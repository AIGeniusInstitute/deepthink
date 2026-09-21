# 技术方案：DeepThink 多 Agent 群组协作与 Pipeline 可追溯执行面板

**版本**: v1.0  
**日期**: 2026-09-21  
**对应 PRD**: `docs/prd/agent-group-chat/PRD.md`  
**里程碑**: M1 MVP（覆盖 AC-1~5, AC-10）  

---

## 目录

1. [架构总览](#1-架构总览)
2. [数据层设计](#2-数据层设计)
3. [后端实现方案](#3-后端实现方案)
4. [前端实现方案](#4-前端实现方案)
5. [WebSocket 事件协议](#5-websocket-事件协议)
6. [群聊交互流程](#6-群聊交互流程)
7. [Pipeline 面板数据流](#7-pipeline-面板数据流)
8. [与现有系统集成点](#8-与现有系统集成点)
9. [文件清单](#9-文件清单)
10. [测试策略](#10-测试策略)

---

## 1. 架构总览

### 1.1 核心设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | 扩展 `registered_groups` 表（新增 `group_kind` 等字段） | 复用既有 IM 绑定、工作区、消息表、GroupQueue，避免消息链路分裂 |
| 2 | 新增独立表而非修改 `messages` 表 | `group_messages` 携带席位/run/node_run 引用，与现有 chat messages 不同语义 |
| 3 | 复用 `graph_*` WS 事件 | `graph_node_start/status/end` 已有节点状态变更事件，Pipeline 面板直接订阅 |
| 4 | 复用 `agent_worker_links` 表 | 编排者-工作者关系已建模，群组席位在此基础上叠加发言策略 |
| 5 | Pipeline 面板复用 `graph_runs` + `graph_node_runs` 表 | 已有节点执行状态、token、耗时、产物引用，无需新建 |
| 6 | M1 只做显示+交互，不做重跑 | 重跑（FR-5）在 M2 实现，M1 聚焦创建+群聊+面板显示+Trace 查看 |

### 1.2 系统架构图

```
┌────────────────────────────────────────────────────────┐
│                    Web Frontend (React)                  │
│  ┌──────────────────┐  ┌─────────────────────────────┐ │
│  │  AgentGroupChat   │  │    PipelinePanel (right)     │ │
│  │  (main chat area) │  │  ┌─────────────────────────┐ │ │
│  │  ┌──────────────┐ │  │  │ RunHeader (status+ctl)  │ │ │
│  │  │ User Bubble  │ │  │  │ NodeCards (steps list)  │ │ │
│  │  │ Agent Bubble │ │  │  │ TraceDetail (drawer)    │ │ │
│  │  │ System Msg   │ │  │  └─────────────────────────┘ │ │
│  │  │ @mention     │ │  └─────────────────────────────┘ │
│  │  └──────────────┘ │                                   │
│  └──────────────────┘                                   │
│         │ HTTP + WebSocket                               │
└─────────┼───────────────────────────────────────────────┘
          │
┌─────────▼───────────────────────────────────────────────┐
│              Backend (Hono + TypeScript)                 │
│                                                          │
│  routes/agent-groups.ts  (NEW)                           │
│  ├── POST   /api/agent-groups        创建群组            │
│  ├── GET    /api/agent-groups/:id    群组详情            │
│  ├── PATCH  /api/agent-groups/:id    更新群组            │
│  ├── DELETE /api/agent-groups/:id    删除群组            │
│  ├── GET    /api/agent-groups/:id/seats  席位列表       │
│  ├── POST   /api/agent-groups/:id/seats  添加席位       │
│  ├── PATCH  /api/agent-groups/:id/seats/:sid  更新席位  │
│  ├── DELETE /api/agent-groups/:id/seats/:sid  删除席位  │
│  ├── POST   /api/agent-groups/:id/messages   发送消息   │
│  ├── GET    /api/agent-groups/:id/messages   消息列表   │
│  ├── POST   /api/agent-groups/:id/runs       启动Run    │
│  ├── POST   /api/runs/:id/control            控制Run    │
│  ├── GET    /api/runs/:id/nodes              节点列表   │
│  ├── GET    /api/node-runs/:id               节点详情   │
│  └── GET    /api/node-runs/:id/trace         Trace事件  │
│                                                          │
│  db.ts (extend)                                          │
│  ├── New tables: group_seats, group_messages             │
│  ├── ALTER registered_groups: group_kind etc.            │
│  └── CRUD functions for all new entities                 │
│                                                          │
│  graph-engineering/ (reuse)                              │
│  ├── graph-orchestrator: startGraphRun, executeGraph     │
│  ├── graph-runner: agent/gate/human node exec            │
│  └── graph-events: graph_* WS events                     │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 数据层设计

### 2.1 Schema 迁移（v67→v70）

采用增量迁移策略，每个新表独立 migration 块，遵循既有 `ensureColumn` / `CREATE TABLE IF NOT EXISTS` 模式。

#### Migration v67: registered_groups 扩展

```sql
-- 扩展 registered_groups 支持 swarm 模式
ALTER TABLE registered_groups ADD COLUMN group_kind TEXT NOT NULL DEFAULT 'chat' 
  CHECK(group_kind IN ('chat', 'swarm'));
ALTER TABLE registered_groups ADD COLUMN orchestrator_agent_id TEXT;
ALTER TABLE registered_groups ADD COLUMN graph_definition_id TEXT;
ALTER TABLE registered_groups ADD COLUMN floor_policy TEXT NOT NULL DEFAULT 'orchestrator_driven' 
  CHECK(floor_policy IN ('orchestrator_driven', 'round_robin', 'free'));
ALTER TABLE registered_groups ADD COLUMN swarm_status TEXT DEFAULT 'active' 
  CHECK(swarm_status IN ('active', 'archived'));
```

#### Migration v68: group_seats 表

```sql
CREATE TABLE IF NOT EXISTS group_seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL REFERENCES registered_groups(jid) ON DELETE CASCADE,
    agent_definition_id TEXT NOT NULL,
    agent_version TEXT NOT NULL DEFAULT 'latest',
    role_prompt TEXT DEFAULT '',
    speak_policy TEXT NOT NULL DEFAULT 'auto' 
      CHECK(speak_policy IN ('auto', 'mention_only', 'silent')),
    mounts TEXT DEFAULT '{}',
    max_turns INTEGER DEFAULT 10,
    token_budget INTEGER DEFAULT 100000,
    time_budget_ms INTEGER DEFAULT 600000,
    max_parallel INTEGER DEFAULT 1,
    seat_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, agent_definition_id)
);
CREATE INDEX IF NOT EXISTS idx_group_seats_group ON group_seats(group_id);
```

#### Migration v69: group_messages 表

```sql
CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL REFERENCES registered_groups(jid) ON DELETE CASCADE,
    run_id TEXT,
    node_run_id TEXT,
    sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'agent', 'system')),
    sender_seat_id INTEGER REFERENCES group_seats(id),
    msg_type TEXT NOT NULL DEFAULT 'text' 
      CHECK(msg_type IN ('text', 'tool_card', 'handoff', 'pipeline_event', 'system')),
    content_ref TEXT,
    mentions TEXT DEFAULT '[]',
    parent_msg_id INTEGER,
    status TEXT DEFAULT 'completed' 
      CHECK(status IN ('thinking', 'tool_exec', 'completed', 'failed')),
    token_in INTEGER DEFAULT 0,
    token_out INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_group_msgs_group ON group_messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_group_msgs_run ON group_messages(run_id);
```

#### Migration v70: 扩展 graph_node_runs 表

```sql
-- 为 pipeline 面板补充字段
ALTER TABLE graph_node_runs ADD COLUMN seat_id INTEGER;
ALTER TABLE graph_node_runs ADD COLUMN prompt_snapshot_hash TEXT;
ALTER TABLE graph_node_runs ADD COLUMN fingerprint TEXT;
```

### 2.2 关键查询性能

- 消息列表：`(group_id, created_at)` 复合索引覆盖翻页查询
- Run 节点列表：`graph_node_runs(graph_run_id)` 已有索引
- Trace 事件：`trace_steps` 表的原子 trace 复用

---

## 3. 后端实现方案

### 3.1 新文件：`src/routes/agent-groups.ts`

这是核心新增路由文件，约 500-800 行。功能模块：

#### 3.1.1 群组 CRUD

```typescript
// POST /api/agent-groups - 创建群组
// 1. 验证 user auth + admin/owner 权限
// 2. 生成 web:{uuid} 格式的 jid
// 3. 创建 registered_groups 行（group_kind='swarm'）
// 4. 创建 group_seats 行（每个成员）
// 5. 创建 agent_worker_links（orchestrator → workers）
// 6. 可选：从模板或 LLM 生成 GraphDefinition → registerDefinition
// 7. 返回 { groupId, jid, seats }

// GET /api/agent-groups - 列出用户的 swarm 群组
// SELECT * FROM registered_groups WHERE group_kind='swarm' AND created_by=?

// GET /api/agent-groups/:jid - 群组详情（含席位列表）
// PATCH /api/agent-groups/:jid - 更新群组配置
// DELETE /api/agent-groups/:jid - 删除群组（级联删除 seats/messages）
```

#### 3.1.2 席位管理

```typescript
// GET /api/agent-groups/:jid/seats - 席位列表
// SELECT * FROM group_seats WHERE group_id=? ORDER BY seat_order

// POST /api/agent-groups/:jid/seats - 添加席位
// body: { agentDefinitionId, agentVersion?, rolePrompt?, speakPolicy?, ... }
// 同时创建 agent_worker_links 行（orchestrator → 新 worker）

// PATCH /api/agent-groups/:jid/seats/:sid - 更新席位
// DELETE /api/agent-groups/:jid/seats/:sid - 删除席位
```

#### 3.1.3 群聊消息

```typescript
// POST /api/agent-groups/:jid/messages - 发送消息
// body: { text, mentions?: [{seatId, agentName}], attachments? }
// 1. 解析 mentions → 确定路由策略
// 2. 创建 group_messages 行（sender_type='user'）
// 3. broadcastStreamEvent('group_message_created', payload)
// 4. 触发 Run 执行：
//    a. 如有 @mentions → 直接路由到被点名席位
//    b. 如无 @mentions → 交给编排者拆解分派
//    c. 调用 buildTeam 或直接 graph 执行

// GET /api/agent-groups/:jid/messages?before=&limit=50
// SELECT * FROM group_messages WHERE group_id=? AND id < ? ORDER BY id DESC LIMIT ?
```

#### 3.1.4 Pipeline Run 管理

```typescript
// POST /api/agent-groups/:jid/runs - 启动 Run
// 1. 查找群组的 graph_definition_id
// 2. 调用 startGraphRun(opts) 复用既有执行引擎
// 3. 创建 pipeline_runs 行（link to graph_runs.id）
// 4. 异步执行 executeGraph
// 5. 返回 { runId, status: 'running' }

// GET /api/runs/:id/nodes - 节点列表（实时状态）
// SELECT * FROM graph_node_runs WHERE graph_run_id=? ORDER BY started_at

// GET /api/node-runs/:id - 节点详情
// SELECT * FROM graph_node_runs WHERE id=?

// GET /api/node-runs/:id/trace - Trace 事件
// 复用现有 trace_steps 表，按 graph_run_id + graph_node_id 过滤
// SELECT * FROM trace_steps WHERE graph_node_id=? ORDER BY seq
```

### 3.2 扩展现有文件

#### `src/db.ts` 新增函数

```typescript
// Group Seats
createGroupSeat(groupId, opts) -> seatId
listGroupSeats(groupId) -> GroupSeat[]
updateGroupSeat(seatId, fields) -> void
deleteGroupSeat(seatId) -> void

// Group Messages  
createGroupMessage(groupId, opts) -> messageId
listGroupMessages(groupId, before?, limit?) -> GroupMessage[]
getGroupMessage(id) -> GroupMessage

// Pipeline helpers
getRunNodes(runId) -> NodeRun[]
getNodeRunDetail(nodeRunId) -> NodeRun
listNodeTraceEvents(nodeRunId, before?, limit?) -> TraceEvent[]

// Swarm groups
listSwarmGroups(userId) -> RegisteredGroup[]
getSwarmGroup(jid) -> RegisteredGroup
```

#### `src/index.ts` 接线

在 `registerRoutes` 中注册新路由：
```typescript
import { agentGroupRoutes } from './routes/agent-groups.js';
app.route('/api', agentGroupRoutes);
```

### 3.3 与 Graph 引擎集成

**核心思路**：群组 = `registered_groups` (swarm) + `group_seats` + `graph_definition`。

当用户在群组中发消息时：
1. 消息写入 `group_messages`
2. 判断路由策略 → 如果走编排者分派，调用既有的 `startGraphRun()`
3. `executeGraph()` 按 `nodes_json` 中的 agent 节点顺序执行
4. 每个 agent 节点执行时：
   - 从 `group_seats` 查询对应席位配置
   - 将席位 role_prompt 叠加到 Agent 的 system_prompt
   - 运行时产生的 `graph_node_start/status/end` 事件经 WS 广播
5. 执行完毕后，聚合结果写入 `group_messages`

### 3.4 WebSocket 事件新建

在 `stream-event.types.ts` 中新增 `group_*` 事件类型：

```typescript
// 新增到 StreamEventType
'group_message_created',
'group_message_delta', 
'group_message_done',
'group_seat_status',
'group_floor_changed',
```

这些事件复用现有 `graph_*` 事件的数据流路径：
- `graph_node_start/status/end` → Pipeline 面板节点状态更新
- `trace_steps` 已有原子 Trace → 节点 Trace 详情

---

## 4. 前端实现方案

### 4.1 新文件清单

| 文件 | 说明 | 预计行数 |
|------|------|---------|
| `web/src/pages/AgentGroupChatPage.tsx` | 群聊主页面（左右分栏） | ~400 行 |
| `web/src/components/agent-group/GroupChatArea.tsx` | 群聊消息区 | ~300 行 |
| `web/src/components/agent-group/AgentBubble.tsx` | Agent 消息气泡 | ~150 行 |
| `web/src/components/agent-group/PipelinePanel.tsx` | Pipeline 右侧面板 | ~350 行 |
| `web/src/components/agent-group/NodeCard.tsx` | 节点卡片 | ~120 行 |
| `web/src/components/agent-group/TraceDetail.tsx` | Trace 详情抽屉 | ~250 行 |
| `web/src/components/agent-group/CreateGroupDialog.tsx` | 创建群组对话框 | ~200 行 |
| `web/src/components/agent-group/SeatConfig.tsx` | 席位配置面板 | ~150 行 |
| `web/src/api/agent-groups.ts` | API 客户端 | ~100 行 |
| `web/src/stores/agent-group.ts` | Zustand store | ~150 行 |

### 4.2 页面布局

```
┌─────────────────────────────────────────────────────┐
│  AppLayout (UnifiedSidebar + TopBar)                 │
│  ┌──────────────────┬──────────────────────────────┐│
│  │  GroupChatArea   │     PipelinePanel             ││
│  │  (flex-1)        │     (w-[400px], resizable)    ││
│  │                  │  ┌──────────────────────────┐ ││
│  │  ┌──────────┐    │  │ RunHeader                │ ││
│  │  │ User Msg │    │  │ [status] [3/5 nodes]     │ ││
│  │  │   (right)│    │  │ [⏸] [▶] [⏹]              │ ││
│  │  └──────────┘    │  ├──────────────────────────┤ ││
│  │  ┌──────────┐    │  │ Node 1: PRD撰写 ✅ 2.3s  │ ││
│  │  │Agent Msg │    │  │ Node 2: 技术方案 ⏳ ...   │ ││
│  │  │ (left)   │    │  │ Node 3: 测试计划 ○       │ ││
│  │  │ 🧑‍💻架构师 │    │  │ Node 4: 代码审查 ○       │ ││
│  │  │ 12s·1.2k │    │  │ Node 5: 集成测试 ○       │ ││
│  │  └──────────┘    │  ├──────────────────────────┤ ││
│  │  ┌──────────┐    │  │ [查看全部 Trace ▸]       │ ││
│  │  │ System   │    │  └──────────────────────────┘ ││
│  │  │ Run开始  │    │                                ││
│  │  └──────────┘    │  ┌──────────────────────────┐ ││
│  │                  │  │ TraceDetail (drawer)      │ ││
│  │  ┌──────────┐    │  │ Tab: 概览|Trace|上下文    │ ││
│  │  │ @输入框  │    │  │       产物|副作用|成本     │ ││
│  │  └──────────┘    │  └──────────────────────────┘ ││
│  └──────────────────┴──────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

### 4.3 路由注册

在 `web/src/App.tsx` 中添加：
```tsx
<Route path="/agent-groups" element={<Suspense><AgentGroupsListPage /></Suspense>} />
<Route path="/agent-groups/:jid" element={<Suspense><AgentGroupChatPage /></Suspense>} />
```

在 `nav-items.ts` 中添加：
```tsx
{ icon: Users, label: 'Agent群组', path: '/agent-groups' }
```

### 4.4 核心组件设计

#### AgentGroupChatPage

```tsx
// 状态管理
const store = useAgentGroupStore();
const { jid } = useParams();
const { group, seats, messages, currentRun, nodes } = store;

// 布局：左右分栏
return (
  <div className="flex h-full">
    <GroupChatArea group={group} messages={messages} seats={seats} />
    <PipelinePanel run={currentRun} nodes={nodes} />
    <TraceDetail /> {/* 按需打开的抽屉 */}
  </div>
);
```

#### PipelinePanel

```tsx
// 实时数据源：WS graph_* 事件 + polling GET /api/runs/:id/nodes
// 状态枚举映射到视觉
const statusConfig = {
  pending:   { icon: Circle,  color: 'gray' },
  running:   { icon: Loader, color: 'blue' },
  success:   { icon: Check,  color: 'green' },
  failed:    { icon: X,      color: 'red' },
  skipped:   { icon: Skip,   color: 'gray' },
  cancelled: { icon: Ban,    color: 'orange' },
  stale:     { icon: Alert,  color: 'yellow' },
};

// 线性链路渲染：竖向步骤条，并行组并排
return (
  <div className="pipeline-panel">
    <RunHeader run={run} />
    <div className="nodes-list">
      {nodes.map((node, i) => (
        <NodeCard key={node.id} node={node} index={i} 
          onClick={() => openTrace(node.id)} />
      ))}
    </div>
  </div>
);
```

#### TraceDetail

```tsx
// Tab 结构：概览 | 完整Trace | 上下文 | 产物 | 副作用 | 成本
// 虚拟滚动处理长Trace（react-virtuoso 或自定义）
// 搜索：前端过滤 event_type 和 payload 文本
```

### 4.5 前端依赖

- 不新增外部依赖（Simplicity First）
- 消息列表用既有 ChatPage 的 MessageList 组件模式
- 虚拟滚动：复用既有 `useVirtualizer` 或手动实现（数据量可控）
- 图标：复用既有的 lucide-react icons

---

## 5. WebSocket 事件协议

### 5.1 新增 group_* 事件

```typescript
// group_message_created
{ type: 'group_message_created', groupId, messageId, senderType, senderSeatId, 
  content, mentions, createdAt }

// group_message_delta (流式文本)
{ type: 'group_message_delta', groupId, messageId, seatId, textDelta }

// group_message_done
{ type: 'group_message_done', groupId, messageId, seatId, 
  tokenIn, tokenOut, durationMs }

// group_seat_status
{ type: 'group_seat_status', groupId, seatId, 
  status: 'idle'|'thinking'|'tool_exec'|'done'|'failed' }

// group_floor_changed
{ type: 'group_floor_changed', groupId, fromSeatId, toSeatId, reason }
```

### 5.2 复用 graph_* 事件

Pipeline 面板的节点状态更新直接复用 `graph_node_start`、`graph_node_status`、`graph_node_end` 事件：

```typescript
// graph_node_start → 节点卡片 appearance
// graph_node_status → 更新 status/tokens/cost
// graph_node_end → 更新 completed/failed + output
// graph_edge_taken → 连接线动画
// graph_end → Run 完成，更新 RunHeader
```

### 5.3 事件可靠性

- 每个事件带 `event_seq` 单调递增序号
- 客户端重连携带 `Last-Event-ID`
- 服务端从该 seq 补发（补发窗口内 500 条）
- 超窗口触发全量快照拉取 `GET /api/runs/:id/nodes`

---

## 6. 群聊交互流程

### 6.1 消息发送流程

```
用户输入消息（含可选 @mentions）
  │
  ├─ POST /api/agent-groups/:jid/messages
  │   body: { text, mentions: [{seatId, agentName}] }
  │
  ├─ 写入 group_messages（sender_type='user'）
  │
  ├─ broadcastStreamEvent('group_message_created', ...)
  │
  ├─ 路由判断：
  │   ├─ 有 @mentions → 直接路由到被点名席位
  │   │   └─ 每个被点名席位独立执行（并行）
  │   │
  │   └─ 无 @mentions → 编排者分派
  │       └─ 查 graph_definition_id → startGraphRun → executeGraph
  │
  ├─ Agent 开始执行 → graph_node_start → WS
  │   ├─ 流式输出 → group_message_delta → WS
  │   └─ 完成 → group_message_done → WS
  │
  └─ 写入 agent 消息到 group_messages
```

### 6.2 发言权调度（M1 简化版）

M1 阶段实现 `orchestrator_driven`（默认策略），即复用既有的 `executeGraph()` 的串行/并行调度：

- `orchestrator_driven`：编排者（第一个 agent 节点）决定下游节点并行/串行
- `free`：同 `orchestrator_driven`，依赖 graph runner 的并行能力
- `round_robin`：在 graph runner 中按节点顺序串行执行

deadlock 防护：依赖 Graph 引擎既有的 `maxRetries` + `timeout` 机制。

### 6.3 人类介入（M1 简化版）

- 暂停/继续/终止：复用 Graph 引擎既有的 `pauseGraphRun` / `cancelGraphRun`
- 插话：用户新消息在当前节点完成后注入（默认行为）
- @纠正：发 @某席位消息 → 作为新 Run 启动（在既有 engine 中处理为追加 query）

---

## 7. Pipeline 面板数据流

```
executeGraph() 执行中
  │
  ├─ runNodeWithRetry()
  │   ├─ graph_node_start → WS → PipelinePanel.handleNodeStart()
  │   │   └─ 创建节点卡片，状态=pending→running
  │   │
  │   ├─ runAgentNode() / runGateNode() / ...
  │   │   └─ StreamEventProcessor 产出的 trace_steps 行
  │   │
  │   ├─ graph_node_status → WS → PipelinePanel.handleNodeStatus()
  │   │   └─ 更新 token/耗时/cost
  │   │
  │   └─ graph_node_end → WS → PipelinePanel.handleNodeEnd()
  │       └─ 更新 status=success|failed + output
  │
  └─ graph_end → WS → PipelinePanel.handleGraphEnd()
      └─ 更新 RunHeader 为 completed
```

**前端 store 的 WS 处理**：
```typescript
// stores/agent-group.ts
handleGraphEvent(event) {
  if (event.type === 'graph_node_start') {
    upsertNode({ id: event.nodeId, status: 'running', ... });
  } else if (event.type === 'graph_node_status') {
    patchNode(event.nodeId, { status, tokens, costUsd, ... });
  } else if (event.type === 'graph_node_end') {
    patchNode(event.nodeId, { status, output, durationMs, ... });
  }
}
```

---

## 8. 与现有系统集成点

| 集成点 | 现有系统 | 集成方式 |
|--------|---------|---------|
| 群组持久化 | `registered_groups` 表 | ALTER ADD COLUMN 扩展 |
| 编排者-工作者关系 | `agent_worker_links` 表 | 群组创建时写入 |
| 执行引擎 | `graph-orchestrator` + `graph-runner` | 直接调用 `startGraphRun` / `executeGraph` |
| Agent 定义 | `agent_definitions` 表 | 通过 `agent_worker_links.orchestrator_id/worker_id` 引用 |
| WS 广播 | `broadcastStreamEvent` | 新增 group_* 事件 + 复用 graph_* 事件 |
| 消息队列 | `GroupQueue` | swarm 群组的 jid 走既有 enqueue/process 路径 |
| 权限 | `authMiddleware` + `canAccessGroup` | 群组资源校验 owner_user_id |
| 审计 | `auth_audit_log` | 群组创建/删除/成员变更写入审计 |

---

## 9. 文件清单

### 9.1 新增文件

```
src/routes/agent-groups.ts           # 群组 REST API (~600 行)
web/src/pages/AgentGroupChatPage.tsx  # 群聊主页面 (~400 行)
web/src/pages/AgentGroupsListPage.tsx # 群组列表页 (~200 行)
web/src/components/agent-group/GroupChatArea.tsx    # 群聊消息区 (~300 行)
web/src/components/agent-group/AgentBubble.tsx      # Agent 气泡 (~150 行)
web/src/components/agent-group/PipelinePanel.tsx    # Pipeline 面板 (~350 行)
web/src/components/agent-group/NodeCard.tsx         # 节点卡片 (~120 行)
web/src/components/agent-group/TraceDetail.tsx      # Trace 详情 (~250 行)
web/src/components/agent-group/CreateGroupDialog.tsx # 创建群组 (~200 行)
web/src/components/agent-group/SeatConfig.tsx       # 席位配置 (~150 行)
web/src/api/agent-groups.ts         # API 客户端 (~100 行)
web/src/stores/agent-group.ts       # Zustand store (~150 行)
```

### 9.2 修改文件

```
src/db.ts                 # 新增 migration v67-v70 + CRUD 函数 (~200 行)
src/index.ts              # 注册新路由 (~5 行)
src/stream-event.types.ts # 新增 group_* 事件类型 (~10 行)
web/src/App.tsx           # 新增路由 (~4 行)
web/src/components/layout/nav-items.ts  # 新增侧边栏入口 (~8 行)
```

### 9.3 不受影响的文件

- `graph-engineering/` 全部：纯复用，不改
- `agent-team/` 全部：纯复用，不改
- `GroupQueue`：swarm jid 走既有路径
- 既有 routes（chat/files/skills 等）：零触碰

---

## 10. 测试策略

### 10.1 后端测试

- DB migration 测试：验证 v67-v70 迁移正确执行，PG 端兼容
- API 测试：curl 脚本覆盖全部 CRUD 端点
- 集成测试：创建群组 → 发消息 → 验证 graph run 启动 → 验证 node 状态变更

### 10.2 前端测试

- 组件渲染测试
- WS 事件处理测试
- 端到端测试：登录 → 创建群组 → 发消息 → 观察 Pipeline 面板 → 查看 Trace

### 10.3 回归测试

- 既有单 Agent 会话（group_kind='chat'）功能零回归
- 既有的 Team/Graph/Collaboration 页面不受影响
- IM 渠道（飞书/Telegram）消息正常

### 10.4 K8s 部署测试

- `npm run build:web` → 构建前端
- `npm run build` → 构建后端
- 构建 Docker 镜像
- K8s 部署后验证所有端点

---

## 附录 A：实施顺序

| 步骤 | 内容 | 依赖 |
|------|------|------|
| Step 1 | DB migration v67-v70 | 无 |
| Step 2 | db.ts CRUD 函数 | Step 1 |
| Step 3 | routes/agent-groups.ts | Step 2 |
| Step 4 | index.ts 路由注册 | Step 3 |
| Step 5 | stream-event.types.ts 扩展 | 无 |
| Step 6 | 前端 API 客户端 + Store | Step 3 |
| Step 7 | 前端组件（从底层向上） | Step 5, 6 |
| Step 8 | 前端路由注册 | Step 7 |
| Step 9 | K8s 构建部署 | Step 4, 7 |
| Step 10 | 端到端测试 + 回归 | Step 9 |

## 附录 B：风险与缓解

| 风险 | 缓解 |
|------|------|
| registered_groups ALTER 影响既有查询 | 新增列全有 DEFAULT，PG 端验证 |
| WS 事件量激增 | 节流 100ms + 前端虚拟滚动 |
| M1 功能不足以演示价值 | 确保 AC-1~5 核心链路跑通：创建→发消息→Pipeline 面板→Trace 查看 |
| 与 Agent Studio Web 交互冲突 | 新路由前缀 /api/agent-groups 不与既有冲突 |