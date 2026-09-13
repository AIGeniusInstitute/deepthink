# Skill Mount Context Not Injected in K8s Distributed Mode

## 1. 用户现象

在 DeepThink Agent 对话界面中，用户从技能下拉菜单选中一个具体技能（如 "agent-browser"）后发送消息，Agent 回复时**完全没有技能感知**，表现得像没选技能一样。

## 2. 问题描述

选中技能后，技能内容（SKILL.md）应该被注入到 Agent 的 system prompt 中，以 `<skill name="agent-browser">...</skill>` XML 块的形式呈现。实际运行时，Agent 收到的 system prompt 是**基础 Agent 定义**，不包含任何技能内容。

## 3. 根因

**两层根因叠加**：

### 3.1 项目级技能文件找不到（Root Cause #1）

`src/container-runner.ts` 的 `getSkillContentsForTurn()` 函数搜索技能的优先级：
1. PostgreSQL `skills` 表（仅 builtin 类技能）
2. 用户技能目录 `/data/skills/{userId}/`

但**缺少第三步**：项目级技能目录 `/app/container/skills/{id}/SKILL.md`。

"agent-browser" 等技能是项目技能（source=project），存储在文件系统的 `container/skills/` 目录下，不在 DB 的 `skills` 表中。导致 `getSkillContentsForTurn(["agent-browser"])` 返回空数组。

### 3.2 跨 Pod 状态不可见（Root Cause #2，致命）

`src/index.ts:1007` 的 `pendingTurnMounts` 是一个**进程内 `Map<string, SelectedMounts>`**。

调用链：
```
web.ts:703  → setPendingTurnMounts(msgId, mounts)  // 写入 Pod A 的 Map
web.ts:687  → storeMessageDirect(...)                // 持久化消息到 DB
             → broadcastNewMessage()                  // 触发消息处理
index.ts    → processGroupMessages()                  // 可能在 Pod B 执行
index.ts:3861 → popPendingTurnMounts(msgId)           // 从 Pod B 的 Map 读取 → undefined!
```

在 K8s 分布式模式下，Web 请求处理器和消息处理器可能在**不同 Pod** 上运行。`pendingTurnMounts` 是进程内 Map，不跨 Pod 共享。

**证据**（修复前）：
- Web-server 日志：`hasTurnMounts: false, hasEnriched: false`
- Agent-runner 日志：`agentDefinition=undefined`

## 4. 复现路径

1. K8s 部署 DeepThink（2+ web-server 副本 + Redis + PostgreSQL）
2. 在 Web UI 打开 Agent 对话，从技能下拉菜单选中 "agent-browser"
3. 发送一条消息如 "浏览 bing.com"
4. Agent 回复不含任何浏览器操作，表现得不知道 agent-browser 技能的存在

## 5. 诊断方法

```bash
# 1. 检查技能内容是否能被找到（Root Cause #1）
kubectl exec -n deepthink deploy/deepthink -- ls -la /app/container/skills/agent-browser/SKILL.md
# 如果文件存在但 Agent 看不到，说明是 Root Cause #2

# 2. 检查 Redis 中是否有 turn-mounts key
kubectl exec -n deepthink deploy/redis -- redis-cli KEYS "deepthink:turn-mounts:*"
# 修复前：始终为空（从未写入 Redis）
# 修复后：消息发送后的 5 分钟 TTL 内可见

# 3. 检查 web-server 日志
kubectl logs -n deepthink deployment/deepthink | grep -i "applyTurnMounts\|enrichedAgentDef"
# 修复前：applyTurnMounts 行不出现，或 hasTurnMounts: false
# 修复后：skillCount: 1, hasEnriched: true

# 4. 检查 agent-runner 收到的 agentDefinition
kubectl logs -n deepthink deployment/agent-runner | grep "agentDefinition"
# 修复前：agentDefinition=undefined
# 修复后：正常出现
```

## 6. 修复方案

### 6.1 项目技能目录回退（Root Cause #1）

**文件**：`src/container-runner.ts`

在 `getSkillContentsForTurn()` 中新增第三步回退：搜索 `/app/container/skills/{id}/SKILL.md`

```typescript
// Fallback 2: project skills directory (container/skills/)
const projectDir = getProjectSkillsDir();
for (const id of missing) {
  const skillPath = path.join(projectDir, id, 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    try {
      const content = fs.readFileSync(skillPath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      dbRows.push({ id, name: frontmatter.name || id, content });
    } catch { /* ignore */ }
  }
}
```

### 6.2 Redis 跨 Pod 共享 turnMounts（Root Cause #2）

**文件 1**：`src/redis-bus.ts` — 新增 `setTurnMounts()` 和 `popTurnMounts()`

```typescript
// TTL 5 分钟，覆盖消息处理窗口
const TURN_MOUNTS_TTL_MS = 300_000;

export async function setTurnMounts(msgId, mounts) {
  const pub = getPub();
  if (!pub) return;
  await pub.set(`deepthink:turn-mounts:${msgId}`, JSON.stringify(mounts), { PX: TURN_MOUNTS_TTL_MS });
}

export async function popTurnMounts(msgId) {
  const pub = getPub();
  if (!pub) return undefined;
  const raw = await pub.get(`deepthink:turn-mounts:${msgId}`);
  if (!raw) return undefined;
  await pub.del(`deepthink:turn-mounts:${msgId}`);
  return JSON.parse(raw);
}
```

**文件 2**：`src/index.ts` — `popPendingTurnMounts` 改为 async，Redis 优先

```typescript
async function popPendingTurnMounts(msgId: string): Promise<SelectedMounts | undefined> {
  // Redis-first: in K8s distributed mode, check Redis before falling back to in-memory
  if (isRedisConnected()) {
    try {
      const fromRedis = await import('./redis-bus.js').then(m => m.popTurnMounts(msgId));
      if (fromRedis) return fromRedis as SelectedMounts;
    } catch { /* fall through */ }
  }
  // In-memory fallback (single-process / no Redis)
  const m = pendingTurnMounts.get(msgId);
  if (m) pendingTurnMounts.delete(msgId);
  return m;
}
```

**文件 3**：`src/index.ts` — `setPendingTurnMounts` 桥接函数同步写入 Redis

```typescript
webDeps.setPendingTurnMounts = (msgId, mounts) => {
  if (mounts) {
    pendingTurnMounts.set(msgId, mounts);
    if (isRedisConnected()) {
      import('./redis-bus.js').then(({ setTurnMounts }) => {
        setTurnMounts(msgId, mounts).catch(() => {});
      });
    }
  } else {
    pendingTurnMounts.delete(msgId);
  }
};
```

**选型理由**：使用 Redis 而非 DB，因为 `turnMounts` 是临时数据（仅一个消息处理周期有效），Redis 的 TTL 机制天然适合此场景，且避免 messages 表 schema 变更。

## 7. 处理卡住的状态

如果滚动更新期间有消息正在处理且未正确携带技能：

```bash
# 重启 agent-runner 清除旧任务队列
kubectl rollout restart -n deepthink deployment/agent-runner

# 如 Redis 中有残留 turn-mounts key
kubectl exec -n deepthink deploy/redis -- redis-cli KEYS "deepthink:turn-mounts:*" | xargs -I{} kubectl exec -n deepthink deploy/redis -- redis-cli DEL {}
```

## 8. 经验沉淀 / 预防

1. **进程内可变状态在分布式环境中是反模式**：`Map`、`Set`、`WeakMap` 等进程内数据结构在 K8s 多副本部署下是隔离的。任何需要在请求-处理链路间传递的状态必须走 Redis / DB / MQ。

2. **`pop` 语义（读取并删除）在分布式环境要注意竞态**：本修复使用 `GET + DEL` 两步操作，在极端并发下可能重复读取。但 `publishAgentTask` 中的 `SET NX` 去重机制确保同一条消息只被一个 Pod 处理，所以 `GET+DEL` 的安全窗口足够。

3. **巡检脚本**：
```bash
#!/bin/bash
# 检查技能挂载是否正常：发一条带技能的消息，检查日志
kubectl logs -n deepthink deployment/deepthink --since=5m | grep "applyTurnMounts: skills injected"
# 如果 5 分钟内无此日志行，说明技能挂载异常
```

4. **告警建议**：监控 `applyTurnMounts: skills injected` 日志出现频率。如果 `skillCount > 0` 但 `hasEnriched: false`，触发告警。