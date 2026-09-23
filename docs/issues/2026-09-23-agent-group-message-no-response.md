# Agent 群组（swarm）发消息后无任何回复，Pipeline 面板为空

## 1. 用户现象

在 `http://127.0.0.1:9999/agent-groups/web:swarm:546f318b-6458-4311-a27d-64b79f384ab1`（群组名「唯心唯物辩论」）的输入框里发消息，发出去了（消息气泡出现在群聊里），但：

- 没有任何 Agent 席位回复；
- 右侧 Pipeline 面板始终显示「点击"启动 Pipeline"开始运行」，点了按钮也没反应；
- 刷新页面后消息还在，但依然没有回复。

## 2. 问题描述

Agent 群组的执行链路**从未接线**。PRD 定义「Run = 一条消息触发的一次完整链路执行」，TECH_SOLUTION §3.1.3 步骤 4 写明发消息要「触发 Run 执行」、§3.3 写明应「调用既有的 `startGraphRun()`」——但这部分在当前代码里完全没落地：

1. `POST /api/agent-groups/:jid/messages` 只把消息写进 `group_messages` 表，**不触发任何执行**。
2. `POST /api/agent-groups/:jid/runs`（「启动 Pipeline」按钮）走了一条临时 Redis 链路，在本机（SQLite + 无 Redis + 单进程）**三重故障、必然失效**。
3. 由于 1，新群组的首条消息还被消息轮询的冷启动守卫**静默丢弃**。

## 3. 根因

### 3.1 发消息不触发执行（直接对应「没反应」）

`src/routes/agent-groups.ts` 的 `POST /:jid/messages` 只调用 `createGroupMessage(...)` 落库。

证据（本机 `~/.deepthink-9999/db/messages.db`）：

| 表 | 故障时 |
|----|--------|
| `group_messages` | 3 行，全部 `sender_type='user'`，0 行 agent |
| `graph_runs` | **0 行** |
| `graph_definitions` | **0 行** |
| `registered_groups.graph_definition_id` | NULL |

也就是说「消息进来了，但没有任何东西被执行过」。

### 3.2 「启动 Pipeline」三重故障

- **外键约束失败**：`src/db.ts` 声明 `FOREIGN KEY (definition_id, definition_version) REFERENCES graph_definitions(id, version)`，而 `POST /:jid/runs` 硬编码写入 `definition_id='swarm-pipeline', version=1`；`graph_definitions` 表是空的，INSERT 必然失败。
  日志：`[runSwarmPipeline] INSERT graph_runs failed: FOREIGN KEY constraint failed`。
- **连带失败**：`createPipelineNode` 的外键指向 `graph_runs`，同样失败 → `nodeId === null` → 面板永远没有节点。
- **假 running**：唯一派发通道是 Redis。`subscribeIpcOutput` 打印 `Redis not connected, skipping`；`src/redis-bus.ts` 的 `publishAgentTask` 在未连接时直接 `return true` 却什么都没做，而该路由没有本地兜底路径 —— 于是接口返回 `status:'running'` 而实际零执行。

### 3.3 新群组首条消息被冷启动守卫丢弃

`src/index.ts` 的消息轮询中，当某 jid 没有 cursor 时，守卫直接「快进」到最新消息并跳过。而 `setCursors` 只在少数几个位置被调用，**群组注册时不会播种 cursor** —— 所以任何新群组的第一条消息都会被丢弃。

日志证据：`chatJid: "web:swarm:546f318b-...", count: 1`。

### 3.4 必须绕开的既有约束

- `src/container-runner.ts` 中 `input.agentDefinition` 会被 `loadGroupAgentDefinition(group.agentDefId, group.created_by)` 的结果**覆盖**，所以席位人设**只能经节点 prompt 注入**。
- 席位的 `agent_definition_id` 是前端自由文本（`唯心主义者`/`唯物主义者`），在 `agent_definitions` 表里解析不到 —— 只能当它真能解析时才绑定 `agentDefId`。
- `graphNodeEndEvent`（`src/graph-events.ts`）把 output **截断到 500 字符**，不能作为回复正文来源；完整输出在 `graph_node_runs.output_summary`。

## 4. 复现路径

1. 打开任意 Agent 群组详情页（`/agent-groups/web:swarm:<uuid>`）；
2. 在输入框发送一条消息；
3. 观察：消息气泡出现，但**没有任何席位回复**；右侧 Pipeline 面板始终为空；
4. 点击「启动 Pipeline」→ 按钮无变化，面板仍为空；
5. 查库确认：`SELECT COUNT(*) FROM graph_runs;` → `0`。

## 5. 诊断方法

```bash
# 数据目录（本机 9999 隔离实例）
DB=~/.deepthink-9999/db/messages.db

# 1. 有没有真的执行过？
sqlite3 "$DB" "SELECT COUNT(*) FROM graph_definitions;"   # 故障时 0
sqlite3 "$DB" "SELECT COUNT(*) FROM graph_runs;"          # 故障时 0

# 2. 群聊里有没有 agent 发言？
sqlite3 "$DB" "SELECT sender_type, sender_seat_id, COUNT(*) FROM group_messages GROUP BY 1,2;"
# 故障时只有 sender_type='user'

# 3. 群组有没有绑定图谱定义？
sqlite3 "$DB" "SELECT jid, folder, execution_mode, graph_definition_id FROM registered_groups WHERE group_kind='swarm';"

# 4. 有没有外键报错 / 冷启动丢消息？
grep -i "FOREIGN KEY constraint failed" logs/deepthink-9999.log
grep -i "Cold start" logs/deepthink-9999.log
```

## 6. 修复方案

选型：**复用既有图谱引擎**（`src/graph-engineering/`），把临时 Redis 链路整条替掉，回归 TECH_SOLUTION §3.3 原设计。一次修掉外键、Redis 依赖、消息不触发三个问题；不引入新引擎、不新增中间件。

### 6.1 新增 `src/agent-group/swarm-definition.ts` — 席位 → 图谱定义

一个 swarm 群组**就是**一个 `graph_definition`：节点是席位，边是发言顺序。席位 PK 直接编进节点 id：

```ts
export const SEAT_NODE_PREFIX = 'seat-';

export function seatIdFromNodeId(nodeId: string): number | null {
  const m = /^seat-(\d+)$/.exec(nodeId);   // 严格匹配：Number('') === 0 会误判 'seat-'
  return m ? Number(m[1]) : null;
}

export function buildSwarmDefinition(group, seats, resolveAgentDef): GraphDefinition {
  // 每个 speak_policy !== 'silent' 的席位一个 agent 节点，
  // prompt 内嵌群名 + 角色设定 + 发言要求；
  // agentDefId 仅在真能在 agent_definitions 解析到时才绑定。
}
```

`ensureSwarmDefinition()` 幂等：用既有的 `computeManifestHash` 比对，席位真变了才重新 `registerDefinition`（版本自增）；顺带**自愈** `graph_definition_id` 为 NULL 的存量群组。

### 6.2 新增 `src/agent-group/swarm-runner.ts` — 触发 + 回写

```ts
export function triggerSwarmRun(opts): { runId: string } | { error: string } {
  const ensured = ensureSwarmDefinition(opts.group);
  if ('error' in ensured) return ensured;
  const started = opts.startGraphRun({
    definitionId: ensured.definitionId, ownerUserId: opts.ownerUserId,
    groupFolder: opts.group.folder, chatJid: opts.group.jid,
    goalText: opts.goalText, maxParallel: 1,
    initialState: { goal: opts.goalText },
  });
  if (!started.success || !started.runId) {
    return { error: started.error ?? 'startGraphRun 未返回 runId' };  // 不再假报 running
  }
  return { runId: started.runId };
}
```

### 6.3 触发接线（`src/routes/agent-groups.ts`）

- `POST /:jid/messages`：落库后调 `startSwarmRun(...)`，响应带 `graphRunId` / `runError`；
- `POST /:jid/runs`：整个函数体换成同一条路径 —— 顺带修好「启动 Pipeline」按钮与外键问题；
- 群组创建 / 席位增删改后调 `refreshSwarmDefinition(jid)`；
- 删掉 `loadSwarmAgentDefContent`、`createPipelineNode`、`updatePipelineNode` 及整段 Redis `subscribeIpcOutput`/`publishAgentTask`。

### 6.4 用户消息注入节点 prompt（`src/graph-engineering/graph-runner.ts`，加性）

```ts
// state.goal 来自 startGraphRun initialState → graph_runs.state_json → ctx.state
const goal = typeof state.goal === 'string' ? state.goal.trim().slice(0, 8000) : '';
if (goal) prompt = `【用户消息】\n${goal}\n\n---\n\n${prompt}`;
```

无 `goal` 时行为完全不变（向后兼容，且函数是纯函数，可单测）。

### 6.5 席位输出回写群聊（不改引擎）

在 `GraphDeps` 上加一个**可选**钩子 `onNodeSettled(ctx, node, outcome)`，在节点落终态的两处（completed、重试耗尽后 failed）调用。与既有 `graph_node_end` 事件的区别：它拿到的是**完整** `NodeRunOutcome`，不是被截断到 500 字符的事件载荷。

`src/index.ts` 的 `graphDeps` 里接上：

```ts
onNodeSettled: async (ctx, node, outcome) => {
  const row = recordSwarmSeatMessage(ctx, node, outcome);
  if (row) broadcastStreamEvent(ctx.chatJid, groupMessageCreatedEvent(ctx.graphRunId, node.id, row));
},
```

未接线时是 no-op，对既有 graph run 零影响。

### 6.6 前端实时刷新

`shared/stream-event.ts` 加可选 `groupMessage` 载荷 + 新事件类型 `group_message_created`（`make sync-types` 同步三份副本）；`GroupChatArea.tsx` 用现成的 `wsManager.on('stream_event')` 监听并 `appendMessage`，席位回复实时出现，无需轮询。

### 6.7 冷启动守卫加时间宽限（`src/index.ts`）

无 cursor 且只有 **1 条**且**时间戳在 5 分钟内**的消息 → 视为新群组首条消息，正常处理；否则才快进跳过。新群组不再丢首条，崩溃恢复时的整段历史回放仍被拦住。

### 6.8 席位继承创建者的执行模式

`createSwarmGroup` 原先不传 `executionMode`，落到 `setRegisteredGroup` 的 `'container'` 默认值。改为继承创建者主容器的模式 —— 与 `schedule_task` 注释里写明的既有约定一致（「a task created from a host workspace runs on host」）：

```ts
executionMode: getUserHomeGroup(authUser.id)?.executionMode ?? 'container',
```

配套修 `resolveExecutionMode`：它原先只读 `deps.registeredGroups()` 这份**内存缓存**，启动后经 Web API 新建的 workspace 不在其中，会静默降级成 container。改为遵循代码库既有的 `缓存 ?? DB` 约定：

```ts
const persisted = getJidsByFolder(ctx.groupFolder)
  .map((jid) => getRegisteredGroup(jid))
  .find((g) => g?.executionMode);
if (persisted?.executionMode) return persisted.executionMode;
```

## 7. 处理卡住的状态

本次遇到两种「卡住的运行态」：

1. **容器内 Agent 静默 601s** → `agent-runner` 的 inactivity watchdog 主动打断并退出（code 143），graph 引擎按既有退避重试；重试耗尽后节点落 `failed`，并经 `onNodeSettled` 在群聊里留下一行 `status='failed'` 的说明，不会静默消失。
2. **旧的假 running 记录**：`graph_runs` 里若残留 `status='running'` 的历史行，直接从库里查出来核对：

```bash
sqlite3 ~/.deepthink-9999/db/messages.db \
  "SELECT id,status,definition_id FROM graph_runs ORDER BY started_at;"
```

## 8. 经验沉淀 / 预防

1. **「接口返回成功」≠「真的执行了」**。`publishAgentTask` 在无 Redis 时 `return true` 却什么都不做，是本次最隐蔽的一环。任何「派发」类函数在降级路径上必须返回可区分的结果（或抛错），调用方必须据此选兜底路径，而不是无脑 `status:'running'`。
2. **外键指向必须由调用方保证存在**。硬编码 `definition_id='swarm-pipeline'` 而目标表为空，是本可直接在 CI 拦下的错误。建议：插入 `graph_runs` 前先确认定义存在；或让 `registerDefinition` 成为唯一写入路径。
3. **新建 workspace 必须播种 cursor**（或由冷启动守卫按时间宽限兜底），否则「新群组第一条消息消失」会反复出现。
4. **内存 group map 不是真相**。`resolveExecutionMode` 只读缓存并靠 folder 名猜测，属于典型的缓存穿透。已改为 `缓存 ?? DB`；其余同类读取点建议一并巡检。
5. **执行模式要继承创建者的环境**。席位跑在谁的机器/权限上，就该用谁的主容器模式 —— 否则会出现「管理员自己在 host 跑得好好的，他建的群组却在容器里连不上自己的 provider」。
6. 本次的 `/tmp` E2E 校验思路（在隔离实例上临时 mint 一个 session cookie，打真实 HTTP API，再用 `sqlite3` 核对落库）可直接复用，比 mock 测试更接近真实故障面。

### 已知遗留（本次未修，非本次回归）

- 无 per-jid run 锁：连发两条消息会对同一 folder 起两个并发 run。
- swarm 定义会出现在 `GET /api/graph/definitions` 与工作流编辑器中。
- 节点 trace 抽屉对引擎节点为空：`chat-trace-persist.ts` 写 `graph_node_id = 'seat-N'`，而 `GET /node-runs/:id/trace` 按 node-run id 查。
- 席位 `agent_definition_id` 目前是自由文本、解析不到真实 Agent 定义，**席位区分度完全来自 `role_prompt`**；建议前端改为从真实 Agent 列表选择（本次未擅自改写用户数据）。

## 9. 验证证据（E2E）

在隔离实例（端口 9999，数据目录 `~/.deepthink-9999`）上，经真实 HTTP API 验证：

| 校验项 | 结果 |
|--------|------|
| `POST /messages` 返回 | `graphRunId: graph-bbfccb84-...`，非 500 |
| `graph_definitions` | 出现 `swarm-swarm-0beb99c4` v1（修改前 0 行） |
| `graph_runs` | `completed`（修改前 0 行） |
| `graph_node_runs` | `seat-1` / `seat-2` 均 `completed` |
| `group_messages` | 新增 `sender_type='agent'`、`sender_seat_id=1/2`、`status='completed'` 两行 |
| `grep -i "FOREIGN KEY constraint failed"` | 0 次命中 |
| WebSocket `/ws` | 收到 2 条 `group_message_created`，前端无需轮询 |
| 启动后新建群组 | 日志为 `Spawning host agent`（模式继承 + DB 回退均生效） |

席位回复内容确实按 `role_prompt` 分化（唯心主义者 vs 唯物主义者各给出对立论点）。

### 环境备注（非代码问题，需人工判断）

本机 `ANTHROPIC_BASE_URL` 指向一个解析到私网地址的 provider。该地址**宿主机可达、Docker 容器不可达**（容器访问公网正常）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://<provider>/   # 宿主: 401（通）
docker run --rm curlimages/curl:latest -s -o /dev/null -w "%{http_code}\n" \
  --max-time 10 https://<provider>/                                          # 容器: 000（不通）
docker run --rm curlimages/curl:latest -s -o /dev/null -w "%{http_code}\n" \
  --max-time 10 https://example.com/                                         # 容器: 200（公网正常）
```

因此**本机所有 container 模式 workspace 都无法调用 LLM**（不止 swarm）。本次通过 6.8 的模式继承让 swarm 走 host 规避；若要恢复 container 隔离，需要先修容器到该私网地址的路由。
