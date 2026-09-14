# Issue: Agent 对话流式输出缺失 + 新建会话 Tab 无响应

## 1. 用户现象

### Bug 1: Agent 对话无中间流式输出
- 用户在 K8s 部署的 DeepThink (`http://192.168.1.25:30080/chat`) 中与 Agent 对话
- 看不到中间的思考推理过程（thinking/reasoning）、工具调用过程（tool call）、技能调用过程（skill call）
- 只能看到最终的 Agent 回复文本，缺少中间交互可见性

### Bug 2: 新建会话 Tab 无响应
- 用户创建新的 Agent 会话 Tab（🦜 图标），发送消息后 Agent 完全无响应
- 无任何输出，页面卡死

## 2. 问题描述

### Bug 1
从技术视角，Agent conversation 的流式事件处理中缺少 `persistTraceNodeFromStreamEvent` 调用。主对话路径（`processGroupMessages`）有该调用（line 3916, 5056），但 agent conversation 路径（`processAgentConversation` 中的 `wrappedOnOutput`）只调用了 `broadcastStreamEvent`，导致 trace node 不持久化，流式中间输出虽然广播到 WS 客户端但缺少持久化链路。

### Bug 2
`processAgentConversation` 函数在分发 Agent 任务时，直接调用 `runContainerAgent` / `runHostAgent`，没有检查 Redis 分布式调度器是否可用。而主对话路径 `runAgent` 有 `isRedisConnected() && hasDistributedRunners()` 检查，会通过 `publishAgentTask` 将任务调度到 agent-runner pods。在 K8s 分布式部署中，agent conversation 因为没有走分布式调度，任务被发送到不存在的本地 runner，导致 Agent 完全无响应。

## 3. 根因

### Bug 1: 代码层面
- `src/index.ts` 中 `processAgentConversation` 的 `wrappedOnOutput` 回调缺少 `persistTraceNodeFromStreamEvent` 调用
- 主路径在 line 3916/5056 有该调用，agent conversation 路径在 line 8364 只有 `broadcastStreamEvent`

### Bug 2: 代码层面
- `src/index.ts` 中 `processAgentConversation` 函数（原 line 8914-8931）直接调用 `runContainerAgent` / `runHostAgent`
- 没有任何 `isRedisConnected() && hasDistributedRunners()` 检查
- 在 K8s 分布式部署中，本地 runner 不存在，导致 Agent 任务无人处理

### 附加修复: Trace Node ID 碰撞
- `TraceNodeAllocator.nextId` 每次新进程从 1 开始
- K8s 每次任务分配新 pod → UNIQUE(chat_jid, id) 冲突 → upsert 覆盖历史 trace 数据
- 修复: 添加 `seedBase()` 机制，host 端查询 `MAX(chat_trace_nodes.id) + 1` 传递给 agent-runner

## 4. 复现路径

1. 访问 K8s 部署的 DeepThink: `http://192.168.1.25:30080/chat`
2. 登录 (admin / 88888888)
3. 在主对话中发送任意消息 — 观察不到思考过程/工具调用中间输出 (Bug 1)
4. 点击 🦜 图标新建 Agent 会话 Tab
5. 在新 Tab 中发送消息 — Agent 完全无响应 (Bug 2)

## 5. 诊断方法

```bash
# 检查 agent-runner 日志确认任务未被分发
kubectl logs -n deepthink deployment/agent-runner --tail=50 | grep -i "task\|BLPOP"

# 检查 server 日志确认无 agent conversation 分发
kubectl logs -n deepthink deployment/deepthink --tail=100 | grep -i "processAgent\|publishAgentTask"

# 验证 Redis 连接
kubectl exec -n deepthink deployment/deepthink -- node -e "
  const Redis = require('ioredis');
  const r = new Redis('redis://redis:6379');
  r.ping().then(console.log);
"

# 检查 agent conversation 是否有 trace node 持久化
kubectl exec -n deepthink deployment/postgres -- psql -U deepthink -d deepthink -c "
  SELECT chat_jid, COUNT(*) FROM chat_trace_nodes WHERE chat_jid LIKE '%#agent:%' GROUP BY chat_jid;
"
```

## 6. 修复方案

共 6 个文件，10 处修改：

### 文件 1: `container/agent-runner/src/trace-node-allocator.ts`
添加 `seedBase()` 方法，允许 host 端传入起始 ID 避免 UNIQUE 冲突：
```typescript
seedBase(base: number): void {
  if (Number.isFinite(base) && base > this.nextId) {
    this.nextId = base;
  }
}
```

### 文件 2: `container/agent-runner/src/types.ts`
添加 `traceNodeIdBase` 字段到 `ContainerInput` 接口

### 文件 3: `src/db.ts`
添加 `getMaxChatTraceNodeId()` 函数查询当前 chat 的最大 node ID：
```typescript
export function getMaxChatTraceNodeId(chatJid: string): number {
  const row = db.prepare(
    'SELECT COALESCE(MAX(id), 0) AS max_id FROM chat_trace_nodes WHERE chat_jid = ?'
  ).get(chatJid) as { max_id: number | string } | undefined;
  return Number(row?.max_id ?? 0);
}
```

### 文件 4: `src/container-runner.ts`
- 导入 `getMaxChatTraceNodeId`
- 添加 `workspaceGlobal`, `workspaceMemory`, `traceNodeIdBase` 到 `ContainerInput` 接口
- 在 `dockerInput` 和 `hostInput` 中添加 `traceNodeIdBase: getMaxChatTraceNodeId(input.chatJid) + 1`

### 文件 5: `container/agent-runner/src/index.ts`
在 `processOneTask()` 中添加 `seedBase()` 调用：
```typescript
if (containerInput.traceNodeIdBase && containerInput.traceNodeIdBase > 0) {
  traceAllocator.seedBase(containerInput.traceNodeIdBase);
}
```

### 文件 6: `src/index.ts` (核心修复)
**Edit 1**: 在 agent conversation 的 stream 处理中添加 `persistTraceNodeFromStreamEvent`:
```typescript
persistTraceNodeFromStreamEvent(virtualChatJid, output.streamEvent);
broadcastStreamEvent(chatJid, output.streamEvent, agentId);
```

**Edit 2**: 在 `processAgentConversation` 中添加分布式调度检查，与主对话路径对齐：
- 添加 `isRedisConnected() && hasDistributedRunners()` 检查
- 构建 `taskInput` 含 `agentDefinition`、`workspaceGlobal`、`workspaceMemory`
- 设置 `_distributedHandler` → `finalOutputPromise` + `timeoutPromise`
- 调用 `publishAgentTask` 分发到 agent-runner
- 注册/注销 IPC output handler
- 非分布式模式下回退到原有直接调用

### 选型理由
- **分布式调度复用**: 直接复用主对话路径的 `publishAgentTask` + `IpcWatcherManager` 模式，而非重新实现
- **Trace Node 种子机制**: 通过 `getMaxChatTraceNodeId` 避免跨进程 ID 冲突，而非改用 UUID（太大改动）
- **外科手术原则**: 只修改必须改的部分，不影响主对话路径、审批、计量等其他功能

## 7. 处理卡住的状态

不需要手动处理。重启 pods 后所有新任务将使用修复后的代码。

## 8. 经验沉淀 / 预防

### 教训
1. **分布式部署必须为所有 dispatch 路径添加分布式检查**：`processAgentConversation` 和 `runAgent` 是两个独立的 dispatch 路径，添加分布式支持时必须确保两者都被覆盖
2. **UNIQUE 约束在跨进程场景下需要全局 ID 分配**：`UNIQUE(chat_jid, id)` 约束在单进程下安全，多进程/K8s 需要全局单调递增 ID 或使用 UUID
3. **对称性检查**：当主路径和 agent 路径有功能差异时，应定期审计两者是否对称

### 预防
- 添加 CI 检查：在 K8s 部署环境中运行端到端测试，验证 agent conversation tab 响应
- 代码审查清单：新增 dispatch 路径时，确认所有相关路径都已覆盖
- 添加集成测试：验证 trace node ID 的跨进程唯一性

### 巡检脚本
```bash
# 检查是否有 agent conversation 任务未被分发
kubectl logs -n deepthink deployment/deepthink --tail=500 | grep -c "publishAgentTask"

# 检查 Redis 队列深度
kubectl exec -n deepthink deployment/redis -- redis-cli LLEN deepthink:agent-tasks
```