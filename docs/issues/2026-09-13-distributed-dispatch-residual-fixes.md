# 分布式 Agent-Runner 调度残留问题修复

**日期**：2026-09-13
**分支**：master
**集群**：kind-desktop, namespace deepthink

---

## 1. 用户现象

- Agent 回复后，WebSocket 中每条消息出现 2 次（用户消息 ×2、Agent 回复 ×2、stream events ×2）
- 多 Pod 部署时 agent-runner session resume 失败（`error_during_execution`），每次需 retry with fresh session（+~1.5s 延迟）

## 2. 问题描述

两个独立问题：

### 问题 A：2× 消息重复
`web.ts` 的 `safeBroadcast()` 同时执行本地广播（`safeBroadcastLocal`）和 Redis 跨 Pod 广播（`publishWsBroadcast`）。所有 Pod 通过 `subscribeWsBroadcast` 订阅 Redis 广播通道，收到后再次调用 `safeBroadcastLocal`。发布 Pod 收到自己的 Redis 广播 → 同一条消息在本地被发送 2 次。

### 问题 B：跨 Pod Session Resume 失败
Agent-runner 的 session transcript 存储在 `CLAUDE_CONFIG_DIR/projects/` 下，但 `CLAUDE_CONFIG_DIR` 未设 env，默认为容器内的 `~/.claude/`（ephemeral fs）。Pod A 创建的 session transcript Pod B 无法读取，导致 resume 失败后被迫 fresh session。

## 3. 根因

### 问题 A
```
safeBroadcast(msg)
  ├─ safeBroadcastLocal(msg)          ← 第 1 次发送（本地）
  └─ publishWsBroadcast(msg)          ← Redis 广播
       └─ subscribeWsBroadcast handler ← 所有 Pod 收到，含发布 Pod
            └─ safeBroadcastLocal(msg) ← 第 2 次发送（发布 Pod 再次收到）
```
**代码位置**：`src/web.ts:2170` `safeBroadcast()` + `src/web.ts:3069` `subscribeWsBroadcast` handler

### 问题 B
`resolveTranscriptDir()` 返回 `path.join(configDir, 'projects', encodedCwd)`，其中 `configDir = process.env.CLAUDE_CONFIG_DIR || ~/.claude`。未设置该 env → 默认 `~/.claude`（容器本地，非 PVC）。
**代码位置**：`container/agent-runner/src/index.ts:911-917` `resolveTranscriptDir()`

## 4. 复现路径

### 问题 A
1. 部署 2 web-server Pod + 2 agent-runner Pod 的 K8s 集群
2. 通过 Playwright E2E 测试发送消息
3. 观察 WS 收到的 `new_message` 事件：每条消息出现 2×
4. `safeBroadcast` 统计中 local 和 Redis 路径均计入同一 Pod

### 问题 B
1. 发送第 1 条消息 → Pod A 处理 → 创建 session transcript
2. 发送第 2 条消息（同 session）→ Pod B 处理 → resume 失败
3. Agent-runner 日志：`Session resume failed (no init): error_during_execution`

## 5. 诊断方法

```bash
# A: 检查消息重复
kubectl --context kind-desktop -n deepthink logs deploy/deepthink --tail=50 | grep "distributedOutput"

# A: E2E 测试
node /tmp/e2e-test-v3.mjs
# 观察 "New messages (N)" — 修复前 N=4（user×2+agent×2），修复后 N=2

# B: 检查 session transcript 位置
kubectl --context kind-desktop -n deepthink exec deploy/agent-runner -- printenv CLAUDE_CONFIG_DIR
# 修复前：空 → 默认 ~/.claude（容器本地）
# 修复后：/data/.claude（共享 PVC）

# B: 验证 transcript 在 PVC
kubectl --context kind-desktop -n deepthink exec deploy/agent-runner -- find /data/.claude/projects -name "*.jsonl"
```

## 6. 修复方案

### 修复 A：`_originPod` 去重标记

**文件**：`src/web.ts`

```diff
+ const THIS_POD_ID = process.env.HOSTNAME || `pod-${process.pid}-${Date.now()}`;

  function safeBroadcast(msg, adminOnly, allowedUserIds) {
    safeBroadcastLocal(msg, adminOnly, allowedUserIds);
-   publishWsBroadcast(msg, adminOnly, allowedUserIds ?? null).catch(() => {});
+   const msgWithOrigin = { ...(msg as any), _originPod: THIS_POD_ID };
+   publishWsBroadcast(msgWithOrigin, adminOnly, allowedUserIds ?? null).catch(() => {});
  }

  // subscribeWsBroadcast handler:
  subscribeWsBroadcast((msg, adminOnly, allowedUserIds) => {
+   if ((msg as any)._originPod === THIS_POD_ID) return; // skip own messages
    safeBroadcastLocal(msg as WsMessageOut, adminOnly, allowedUserIds);
  }).catch(...)
```

**选型理由**：不改变 `safeBroadcast` 的二阶段语义（本地零延迟 + Redis 跨 Pod）。只用 `HOSTNAME` 标记来源 Pod，接收端跳过自己发的消息。无需消息 ID、无需清理缓存。

### 修复 B：`CLAUDE_CONFIG_DIR` 指向 PVC

**文件**：`deploy/k8s/agent-runner.yaml`

```diff
  env:
  - name: AGENT_RUNNER_MODE
    value: "distributed"
  - name: REDIS_URL
    value: "redis://redis:6379"
+ - name: CLAUDE_CONFIG_DIR
+   value: "/data/.claude"
  - name: DATABASE_URL
```

**选型理由**：`/data` 是共享 PVC 的挂载点。所有 agent-runner Pod 共享同一 `.claude` 目录，session transcripts 可跨 Pod 访问。settings/credentials 在 Pod 间相同，共享无副作用。

## 7. 处理卡住的状态

```bash
# 清理 Redis agent-runners pool 中的僵尸条目
kubectl --context kind-desktop -n deepthink exec deploy/redis -- redis-cli DEL deepthink:agent-runners:pool
# 重启 agent-runner 会重新注册

# 清理陈旧任务
kubectl --context kind-desktop -n deepthink exec deploy/redis -- redis-cli DEL deepthink:agent-tasks
kubectl --context kind-desktop -n deepthink exec deploy/redis -- redis-cli DEL deepthink:task-claimed:*
```

## 8. 经验沉淀 / 预防

1. **`safeBroadcast` 双重发送**：任何「本地 + Redis」的广播模式都必须考虑自回环。`_originPod` 标记是最简单的去重方案。
2. **容器内 `~/.claude` 非持久**：agent-runner 是 stateless worker，所有需要跨 Pod 共享的状态（session transcripts、模型缓存）必须落在共享 PVC 上。
3. **滚动更新期间的 BLPOP 偷任务**：旧 Pod 在 Terminating 期间仍持有 Redis 连接，可能 consume BLPOP 任务后立即退出。生产环境应在 `preStop` hook 中 `SREM pool + CLIENT KILL` 或使用 Redis Streams consumer group 的 XACK。
4. **E2E 测试脚本的累积数组**：`allWsMessages.push()` 导致每 3s 检查点重复输出旧消息，看起来像 recovery loop。测试应区分「新到消息」和「已打印消息」。

### 巡检脚本

```bash
#!/bin/bash
# check-session-resume.sh — 检查 session transcript 是否在 PVC
PVC_PATH=$(kubectl --context kind-desktop -n deepthink exec deploy/agent-runner -- printenv CLAUDE_CONFIG_DIR 2>/dev/null)
if [ -z "$PVC_PATH" ]; then
  echo "WARN: CLAUDE_CONFIG_DIR not set — session resume will fail across pods"
elif [ "$PVC_PATH" != "/data/.claude" ]; then
  echo "WARN: CLAUDE_CONFIG_DIR=$PVC_PATH (expected /data/.claude)"
else
  echo "OK: CLAUDE_CONFIG_DIR=/data/.claude"
fi
```

### 告警建议
- 监控 `error_during_execution` 在 agent-runner 日志中的频率（>0/min → 告警）
- 监控 `deepthink:agent-tasks` 队列长度（LLEN > 10 → 告警）