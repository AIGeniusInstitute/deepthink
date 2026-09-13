# Feishu IM Leader Election Failure During K8s Rolling Update

## 1. 用户现象

飞书消息渠道已配置，但消息发送后收到：**⚠️ 消息处理失败，请重发一次**。在 K8s 多副本部署中，飞书 WebSocket 始终无法连接，`login` 响应显示 `feishuConfigured: false`。

## 2. 问题描述

K8s 集群中 `deepthink` Deployment 有 2 个副本。滚动更新后，两个 Pod 都打印日志：
```
IM leader lease held by another Pod — skipping user IM connect
```
导致没有任何 Pod 连接飞书 WebSocket，所有飞书消息无法处理。

## 3. 根因

**两层问题叠加**：

### 3.1 IM Leader Election 竞态（代码层面）

`src/index.ts:12269` 的 `acquireOwnership()` 使用 Redis `SET NX PX` 实现互斥锁：

```typescript
const result = await pub.set(key, token, { NX: true, PX: ttlMs });
return result === 'OK';
```

- TTL 为 30 秒
- **只在启动时调用一次**，没有重试机制
- 续租 `setInterval` 只在 `imLeader === true` 时运行

**触发路径**：
1. 旧 Pod 持有 `deepthink:im-leader` 锁（TTL 30s）
2. 滚动更新开始：`kubectl rollout restart`
3. 旧 Pod 被 SIGTERM 终止，但 Redis 中的锁 key **尚未过期**
4. 新 Pod 启动，`acquireOwnership()` 因 key 已存在（`NX: true`）返回 false
5. 两个新 Pod 都失败，都不重试
6. 30 秒后锁过期被 Redis 自动删除
7. **没有任何 Pod 重新尝试获取锁** → 永久无 IM 连接

### 3.2 全局 Provider 配置缺失（配置层面）

`src/runtime-config.ts:1649` 的 `readStoredFeishuConfig()` 读取全局配置文件：

```typescript
const FEISHU_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'feishu-provider.json');
// = /data/config/feishu-provider.json
```

K8s 部署中此文件**不存在**。飞书凭据存储于用户级 IM 配置（`/data/config/user-im/{userId}/feishu.json`），该路径仅在 `index.ts:12283` 的 `getUserFeishuConfig(userId)` 中读取——这要求 IM leader 必须先成功获取。

`login` 响应的 `feishuConfigured` 标志来自全局 Provider 配置（`getFeishuProviderConfigWithSource()`），不读取用户级配置，因此即使飞书可正常连接，该标志也为 `false`。

## 4. 复现路径

1. 部署 2 副本 DeepThink K8s Deployment
2. 配置飞书用户级 IM 凭据（通过 Settings UI）
3. 执行 `kubectl rollout restart deployment/deepthink`
4. 查看新 Pod 日志：两个 Pod 都显示 `IM leader lease held by another Pod`
5. 检查 Redis：`GET deepthink:im-leader` → `(nil)`
6. 飞书发消息 → 无响应或收到 `⚠️ 消息处理失败`

## 5. 诊断方法

```bash
# 检查 Redis IM leader 锁状态
kubectl exec -n deepthink deploy/redis -- redis-cli GET "deepthink:im-leader"
kubectl exec -n deepthink deploy/redis -- redis-cli TTL "deepthink:im-leader"
# TTL=-1: key 存在但无过期时间
# TTL=-2: key 不存在（本题情况）

# 检查 Pod 的 IM leader 日志
kubectl logs -n deepthink deploy/deepthink | grep -i "IM leader"

# 检查飞书连接状态
kubectl logs -n deepthink deploy/deepthink | grep -i "feishu.*connect"
```

## 6. 修复方案

### 紧急恢复（无需改代码）

```bash
# 删除一个 Pod 强制重新选举（新 Pod 启动时锁已过期，可以成功获取）
kubectl delete pod -n deepthink $(kubectl get pods -n deepthink -l app=deepthink -o name | head -1)
```

### 长期修复（代码层面）

**方案 A：增加启动重试（推荐，最小改动）**

在 `src/index.ts` IM leader 获取失败后增加重试循环：

```diff
  const POD_TOKEN = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let imLeader = false;
- if (await acquireOwnership(IM_LEADER_KEY, POD_TOKEN, IM_LEADER_TTL_MS)) {
-   imLeader = true;
+ // Retry acquisition: old pod's lease may still have TTL during rolling update
+ for (let attempt = 0; attempt < 5; attempt++) {
+   if (await acquireOwnership(IM_LEADER_KEY, POD_TOKEN, IM_LEADER_TTL_MS)) {
+     imLeader = true;
+     break;
+   }
+   if (attempt < 4) {
+     logger.info({ attempt: attempt + 1 }, 'Waiting for IM leader lease to expire...');
+     await sleep(10_000); // wait 10s, try again (TTL is 30s, 5 attempts = 50s)
+   }
+ }
+ if (imLeader) {
```

**方案 B：非 leader Pod 周期性重试**

在已存在的 `setInterval` 中增加非 leader 的重试逻辑：

```diff
  setInterval(async () => {
    try {
-     if (!imLeader) return;
+     if (!imLeader) {
+       // Non-leader pods periodically re-attempt acquisition
+       if (await acquireOwnership(IM_LEADER_KEY, POD_TOKEN, IM_LEADER_TTL_MS)) {
+         imLeader = true;
+         logger.info('Acquired IM leader lease on retry — connecting user IM channels');
+         // ... reconnect logic
+       }
+       return;
+     }
      const ok = await renewOwnership(IM_LEADER_KEY, POD_TOKEN, IM_LEADER_TTL_MS);
```

## 7. 处理卡住的状态

```bash
# 清除旧锁（如果确认旧 Pod 已不存在）
kubectl exec -n deepthink deploy/redis -- redis-cli DEL "deepthink:im-leader"

# 然后删除一个 Pod 强制重启
kubectl delete pod -n deepthink <pod-name>
```

## 8. 经验沉淀 / 预防

1. **分布式锁必须考虑启动竞态**：`SET NX` 是原子操作，但在滚动更新场景下，旧 Pod 的锁可能仍然有效。需要重试机制。

2. **`feishuConfigured` 与飞书实际连接状态解耦**：`feishuConfigured` 读取全局 Provider 配置（`feishu-provider.json`），而实际飞书连接使用用户级 IM 配置（`user-im/{userId}/feishu.json`）。两者不一致会导致 UI 显示 `feishuConfigured: false` 但飞书实际可用，或反之。

3. **巡检脚本**：
```bash
#!/bin/bash
# 检查 K8s IM leader 锁是否存在
LEADER=$(kubectl exec -n deepthink deploy/redis -- redis-cli GET "deepthink:im-leader" 2>/dev/null)
if [ -z "$LEADER" ]; then
  echo "ALERT: No IM leader — Feishu/Telegram/WhatsApp will not work"
fi
```

4. **告警建议**：监控日志中 `IM leader lease held by another Pod` 的出现频率。如果所有 Pod 都打印此日志且持续超过 60 秒，触发告警。