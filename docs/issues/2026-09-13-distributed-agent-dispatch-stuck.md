# 分布式 Agent-Runner 任务调度修复

> 日期: 2026-09-13
> 提交: 481e646

## 1. 用户现象

E2E 测试（Playwright 自动化）向 DeepThink 发送消息后，始终收不到 Agent 的回复。WebSocket `new_message` 事件仅有用户消息，无 `sender="deepthink-agent"` 的 Agent 回复。Agent 回复卡在 Redis 队列中无法被消费。

## 2. 问题描述

DeepThink 分布式模式下，web-server Pod 通过 Redis List (`deepthink:agent-tasks`) 将任务分发给 agent-runner Pod。agent-runner 处理完任务后进入 `waitForIpcMessage()` 等待后续 IPC 输入，但 web-server 从未发送 `_close` 信号，导致 `processOneTask()` 永不返回 → while 循环无法到达下一个 `BLPOP` → 后续任务永久困在 Redis 队列。

同时存在两个附加问题：
- **订阅竞态**：web-server 的 Redis IPC 订阅未完成时 agent-runner 已发布输出 → "0 subscribers" → 输出丢失
- **多 Pod 重复分发**：两个 web-server Pod 同时收到同一条消息，各自 LPUSH 同个任务 → agent-runner 重复执行

## 3. 根因

### 根因 #1：缺少 _close 信号（主因）

```typescript
// agent-runner: processOneTask() 中的 while 循环
while (true) {
  const msg = await waitForIpcMessage(...); // 阻塞等待, 永不返回
  // 处理消息...
}
```

`waitForIpcMessage()` 从两种来源读取：①本地文件系统 `fs.watch` ②Redis IPC 频道 `deepthink:ipc:{folder}`。正常情况下 `_close` 信号使函数返回并退出循环。但在分布式模式中，web-server 的 `runAgent` 只在本地模式（`closeStdin`）发送 `_close`，分布式路径缺失此逻辑。

**修复**：在 `runAgent` 分布式路径的 `finally` 块中：
```typescript
if (isRedisConnected()) {
  publishAgentIpc(group.folder, { type: '_close', text: '' }).catch(() => {});
}
```

### 根因 #2：IPC 订阅竞态

`IpcWatcherManager.watchGroup()` 异步订阅 Redis IPC 频道，但 `publishAgentTask` 立即 LPUSH 任务。agent-runner 可能在订阅完成前就消费并发布输出 → web-server 错过输出。

**修复**：新增 `ensureSubscriptionsReady()` 方法，在 `publishAgentTask` 前 await 订阅就绪：
```typescript
await ipcWatcherManager?.ensureSubscriptionsReady(group.folder);
```

### 根因 #3：多 Pod 任务重复分发

两个 web-server Pod 同时接收同一条消息，各自进入 `runAgent` → 各自 LPUSH 同个 `turnId` 任务到队列 → agent-runner 重复执行。

**修复**：`publishAgentTask` 新增 `SET NX` 去重：
```typescript
const dedupKey = `deepthink:task-claimed:${turnId}`;
const claimed = await pub.set(dedupKey, '1', { NX: true, EX: 900 });
if (claimed !== 'OK') return false; // 其他 Pod 已认领
```

### 根因 #4：distributedHandler 异常导致 Promise 悬挂

`distributedHandler` 中 `wrappedOnOutput` 抛异常时，`resolve()` 不会执行 → `finalOutputPromise` 永久悬挂 → 等 10 分钟超时。

**修复**：用 try/catch/finally 包裹，确保 terminal status 始终 resolve。

### 根因 #5：Redis 初始化启动竞态

`initRedis()` 是异步的，若消息在 Redis 连接前到达，`isRedisConnected()` 返回 false → 分布式分发路径跳过 → 回退到本地 Docker 模式（K8s 中不可用）。

**修复**：在 `startWebServer` 前 `await initRedis()`。

## 4. 复现路径

1. 部署 DeepThink 到 K8s (kind 集群，2x web-server + 2x agent-runner)
2. 访问 http://localhost:30080/ 登录 admin/88888888
3. 发送任意消息
4. 观察：Agent 不回复，Redis 队列 `deepthink:agent-tasks` 为空（任务被消费但卡在 `waitForIpcMessage`）

## 5. 诊断方法

```bash
# 1. 检查 agent-runner 是否卡在 waitForIpcMessage
kubectl logs -n deepthink deploy/agent-runner --tail=50

# 2. 检查 Redis 队列是否为空（任务已被消费但未处理完成）
kubectl exec -n deepthink deploy/redis -- redis-cli LLEN deepthink:agent-tasks

# 3. 手动发送 _close 验证理论
kubectl exec -n deepthink deploy/redis -- redis-cli PUBLISH "deepthink:ipc:main" '{"type":"_close","text":""}'
# 若 agent-runner 立即开始处理队列中的任务 → 确认根因 #1

# 4. 监控 Redis 流量
kubectl exec -n deepthink deploy/redis -- redis-cli MONITOR | grep agent-tasks
```

## 6. 修复方案

| 文件 | 改动 | 修复根因 |
|------|------|---------|
| `src/index.ts` | `runAgent` finally 块添加 `publishAgentIpc(_close)` | #1 |
| `src/index.ts` | `IpcWatcherManager.ensureSubscriptionsReady()` + 订阅前 await | #2 |
| `src/index.ts` | `distributedHandler` try/catch/finally | #4 |
| `src/index.ts` | `initRedis()` 提前到 `startWebServer` 前 | #5 |
| `src/redis-bus.ts` | `publishAgentTask` 返回 boolean + `SET NX` 去重 | #3 |
| `src/redis-bus.ts` | `initRedis` 幂等守卫 + IPC 订阅日志 | 诊断 |
| `src/group-queue.ts` | `closeStdin` Redis 分支 | #1 辅助 |

## 7. 处理卡住的状态

如果线上已部署了旧代码（无 `_close` 信号），agent-runner 会卡在 `waitForIpcMessage`：

```bash
# 手动发送 _close 到所有卡住的 group
kubectl exec -n deepthink deploy/redis -- redis-cli PUBLISH "deepthink:ipc:main" '{"type":"_close","text":""}'
# agent-runner 会立即消费队列中的任务
```

## 8. 经验沉淀 / 预防

1. **IPC 协议必须定义终止信号**：分布式模式下 `_close` 是必须的协议信号，不能默认"本地文件系统会自然关闭"
2. **异步订阅必须 await**：pub/sub 模式中订阅方和发布方存在天然竞态，订阅完成前不应发布
3. **多写者队列需要去重**：多个 web-server Pod 是独立写者，Redis List 不提供去重，需应用层实现（`SET NX`）
4. **Promise 守卫原则**：任何 handler 回调中的 resolve/reject 都应在 try/finally 中执行，防止调用方永久悬挂
5. **启动顺序敏感**：`initRedis()` 必须在 `startWebServer` 前完成，否则第一条消息走错分发路径