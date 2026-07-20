# 技术方案：Graph Engineering 能力 + Harness/Loop 可观测与断点续跑优化

> 关联 PRD：`docs/prd/graph-engineering/PRD.md`
> 分支：`feat/graph-engineering`
> 状态：v1
> 日期：2026-07-20

## 0. 设计总则

**核心判断**：Graph 不是新引擎，而是 Loop 之上的**编排层**。复用现有 `runHostAgent`/`runContainerAgent` 执行单节点、复用 `buildReviewerPrompt` 做 gate 节点、复用 `DagView` reactflow 画布做可视化、复用 `bootRecoverSupervisor` 模式做崩溃恢复。新建独立三表（不污染 `loop_*`），模仿 `loop-orchestrator.ts` 结构新增 `graph-orchestrator.ts`。

**不改动**（Surgical Changes）：现有 Loop/Harness/Supervisor 三套运行逻辑保持不变，仅对 `executeGoalLoop` 入口加 2 行续跑逻辑（AC8.1）。现有三套多 Agent 机制不替换。

**目录约定**：所有新代码集中 `src/graph-engineering/`，前端 `web/src/pages/GraphPage.tsx` + `web/src/components/graph/*` + `web/src/stores/graph.ts`，路由 `src/routes/graph.ts`。

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  前端 GraphPage (React) — reactflow 运行态画布 + 节点详情 │
│   ↑ /api/graph/* (SSE 流式推送 graph_* 事件)              │
├─────────────────────────────────────────────────────────┤
│  路由层 src/routes/graph.ts (Hono, authMiddleware)        │
├─────────────────────────────────────────────────────────┤
│  Graph Orchestrator (src/graph-engineering/)             │
│   ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │
│   │ graph-registry│  │graph-scheduler│  │graph-runner  │  │
│   │ (定义+版本)   │  │(拓扑+就绪队列) │  │(单节点执行)  │  │
│   └─────────────┘  └──────────────┘  └──────────────┘  │
│   ┌─────────────┐  ┌──────────────┐                     │
│   │graph-checkpt │  │graph-recovery │                    │
│   │(节点级快照)   │  │(boot recovery)│                   │
│   └─────────────┘  └──────────────┘                     │
├─────────────────────────────────────────────────────────┤
│  复用现有：runHostAgent/runContainerAgent + GroupQueue    │
│  (节点级独立子工作区，不破坏 serializationKeyResolver)    │
├─────────────────────────────────────────────────────────┤
│  SQLite (schema v52): graph_definitions / graph_runs /   │
│  graph_node_runs / graph_edges                            │
└─────────────────────────────────────────────────────────┘
```

## 2. 数据模型（schema v52，新建 4 表）

模仿 `loop_runs/loop_iterations/loop_trace_nodes`（`src/db.ts:378-445`）三件套。`CREATE TABLE IF NOT EXISTS` + `SCHEMA_VERSION='52'`。

### 2.1 `graph_definitions`（图定义，版本化）
```sql
CREATE TABLE IF NOT EXISTS graph_definitions (
  id TEXT PRIMARY KEY,                -- definition id (slug)
  version INTEGER NOT NULL DEFAULT 1,
  parent_version_id TEXT,             -- 版本链
  name TEXT NOT NULL,
  description TEXT,
  nodes_json TEXT NOT NULL,           -- GraphNode[]
  edges_json TEXT NOT NULL,           -- GraphEdge[]
  state_schema_json TEXT,             -- state 字段定义
  manifest_hash TEXT NOT NULL,        -- 内容 hash
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
  created_at TEXT NOT NULL,
  UNIQUE(id, version)
);
CREATE INDEX IF NOT EXISTS idx_graph_def_status ON graph_definitions(status);
```

### 2.2 `graph_runs`（图运行实例）
```sql
CREATE TABLE IF NOT EXISTS graph_runs (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,  -- 续跑锁定版本
  owner_user_id TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  goal_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','paused','completed','failed','cancelled')),
  current_node_id TEXT,                 -- 当前执行节点（断点锚点）
  state_json TEXT NOT NULL DEFAULT '{}', -- 共享 GraphState
  max_parallel INTEGER NOT NULL DEFAULT 4,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  cancel_reason TEXT,
  FOREIGN KEY (definition_id) REFERENCES graph_definitions(id)
);
CREATE INDEX IF NOT EXISTS idx_graph_runs_owner ON graph_runs(owner_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_graph_runs_status ON graph_runs(status);
```

### 2.3 `graph_node_runs`（节点级 checkpoint）
```sql
CREATE TABLE IF NOT EXISTS graph_node_runs (
  id TEXT PRIMARY KEY,                  -- node_run id
  graph_run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,                -- 图定义中的节点 id
  node_type TEXT NOT NULL
    CHECK(node_type IN ('agent','gate','branch','join','human')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','completed','failed','skipped','paused')),
  attempt INTEGER NOT NULL DEFAULT 0,
  input_summary TEXT,                   -- 节点输入快照
  output_summary TEXT,                  -- 节点输出快照
  state_patch_json TEXT,                 -- 本节点对 state 的 patch
  parent_node_run_id TEXT,              -- span 父子（fan-out/fan-in 还原）
  started_at TEXT,
  ended_at TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  is_idempotent INTEGER NOT NULL DEFAULT 0,  -- 幂等标记
  FOREIGN KEY (graph_run_id) REFERENCES graph_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_graph_node_runs_run ON graph_node_runs(graph_run_id, status);
CREATE INDEX IF NOT EXISTS idx_graph_node_runs_parent ON graph_node_runs(parent_node_run_id);
```

### 2.4 `graph_node_run_locks`（同 folder 并发隔离，AC2.7）
```sql
CREATE TABLE IF NOT EXISTS graph_node_run_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  workspace_folder TEXT NOT NULL,        -- 节点级独立子工作区路径
  acquired_at TEXT NOT NULL,
  released_at TEXT,
  FOREIGN KEY (graph_run_id) REFERENCES graph_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_graph_locks_run ON graph_node_run_locks(graph_run_id, released_at);
```

## 3. 模块结构（`src/graph-engineering/`）

| 文件 | 职责 | 行数估 |
|------|------|--------|
| `graph-types.ts` | `GraphNode`/`GraphEdge`/`GraphState`/`GraphDefinition`/`NodeRunStatus` 类型 | ~150 |
| `graph-registry.ts` | 图定义 CRUD+版本化+manifest hash+校验（环检测/悬空边）+Mermaid 导出。模仿 `harness-registry.ts:166 captureCurrentHarness` | ~300 |
| `graph-scheduler.ts` | 拓扑排序+就绪队列+fan-out/fan-in+条件分支+retry policy+全局并发限。**纯调度**，不执行 | ~350 |
| `graph-runner.ts` | 单节点执行：`agent` 节点调 `runHostAgent`/`runContainerAgent`（复用 `runOneIteration` 模式）；`gate` 节点调 reviewer；`branch` 求值谓词。模仿 `loop-orchestrator.ts:228 runOneIteration` | ~300 |
| `graph-checkpoint.ts` | 节点完成→落 `graph_node_runs`；读 checkpoint；幂等性自检。模仿 `loop-orchestrator.ts:346 updateLoopIteration` | ~150 |
| `graph-recovery.ts` | `bootRecoverGraphRuns()`：翻 stale running→failed，重 arm pending。模仿 `supervisor-agent.ts:745 bootRecoverSupervisor` | ~120 |
| `graph-orchestrator.ts` | 顶层入口 `executeGraph(ctx,deps)`：协调 scheduler+runner+checkpoint，对外暴露 pause/resume/cancel/rerun。模仿 `executeGoalLoop:432` | ~250 |
| `graph-commands.ts` | `/graph` 斜杠命令：从自然语言/模板生成图定义→启动。模仿 `loop-commands.ts:100 handleGoalCommand` | ~200 |
| `graph-events.ts` | `emitGraphEvent()` + 流式事件构造，复用 `broadcastStreamEvent` | ~100 |

## 4. 调度算法（`graph-scheduler.ts` 核心）

```
executeGraph(runId):
  run = getGraphRun(runId)
  if run.status in ('completed','failed','cancelled'): return
  if run.status == 'paused': return  // 等待 resume 信号

  // 续跑：从 checkpoint 恢复
  completedNodes = {node_id for node_run in graph_node_runs where run_id=runId and status='completed'}
  pendingQueue = topologicalReadyQueue(graph_def, completedNodes)

  setRunStatus(runId, 'running')

  while pendingQueue not empty and run.status == 'running':
    // 取就绪节点（入度已满足）
    batch = pendingQueue.dequeueUpTo(run.max_parallel, respect global MAX_CONCURRENT_*)
    // fan-out 并行
    await Promise.all(batch.map(node => runNode(runId, node)))
    // 节点完成后更新后继入度，新就绪节点入队
    pendingQueue = topologicalReadyQueue(graph_def, completedNodes ∪ batch.completed)

  if allNodesCompleted: setRunStatus(runId,'completed')
```

**runNode(runId, node)**（`graph-runner.ts`）：
1. 创建 `graph_node_runs` 记录（status=running，attempt++）
2. 落盘后推进（先持久化后执行，避免重蹈 Loop 断点债）
3. 按 node_type 分派：
   - `agent`：构造 ContainerInput（workspaceFolder=节点级独立子目录），调 `runHostAgent`/`runContainerAgent`，收集 stream events + usage
   - `gate`：调 `buildReviewerPrompt`+`lightweightSdkQuery`+`parseReviewResult`
   - `branch`：求值 `condition(state)`，返回激活的后继 node_id
   - `join`：所有前驱 completed 后激活，合并 state patch
   - `human`：P0 占位（status=paused，等 P1 接飞书）
4. 落 checkpoint（status=completed/failed，output_summary，state_patch_json，tokens/cost）
5. 失败→retry policy（max_attempts=3，指数退避 5s/10s/20s）→ 仍失败则 graph status=failed

## 5. 并发策略：节点级独立子工作区（AC2.7）

**问题**：`GroupQueue.serializationKeyResolver`（`group-queue.ts:82`）防同 folder 并发写。Graph 的 fan-out 让同 folder 多节点并发写，会破坏不变量。

**方案**：每个并发节点分配独立子工作区 `data/groups/{folder}/graph-workspaces/{run_id}/{node_id}/`，作为该节点 Agent 的工作目录。节点间无文件写冲突。`graph_node_run_locks` 表记录占用，节点完成释放。

**与 GroupQueue 的关系**：
- 节点执行仍走 `runHostAgent`/`runContainerAgent`，受 `MAX_CONCURRENT_CONTAINERS=20`/`MAX_CONCURRENT_HOST_PROCESSES=5` 全局上限约束（`CLAUDE.md §8.7`）。
- graph-scheduler 的 `max_parallel`（默认 4）≤ 全局上限，作为图内层节流。
- 不绕过 GroupQueue 的全局计数，只在其下加一层图内并发管理。

**实现**：`graph-runner.ts` 构造 ContainerInput 时，`workspaceFolder` 传节点级路径；`runHostAgent`/`runContainerAgent` 已支持自定义 workspace（见 `container-runner.ts:573 buildVolumeMounts`）。

## 6. 断点续跑与恢复（功能点 3+4）

### 6.1 主动续跑 API
- `POST /api/graph/runs/:id/resume`：从 `graph_node_runs` 已 completed 节点续跑，跳过 completed，重跑 paused/failed（幂等校验）。
- `POST /api/graph/runs/:id/pause`：run.status=paused，当前节点完成后停止（不阻塞无依赖并行分支）。
- `POST /api/graph/runs/:id/cancel`：run.status=cancelled，清理半成品节点（status=skipped）。
- `POST /api/graph/runs/:id/nodes/:nodeId/rerun`：重置该节点及下游 status=pending，重新调度。

### 6.2 崩溃恢复（`bootRecoverGraphRuns`）
模仿 `bootRecoverSupervisor`（`supervisor-agent.ts:745`）：
1. 扫 `graph_runs where status='running'` → 翻为 'failed'（带 `cancel_reason='crashed before recovery'`）。
2. 扫 `graph_node_runs where status='running'` → 翻为 'failed'。
3. 对 failed 的 graph_runs，前端列表标红，用户可手动 `resume` 重跑（幂等节点自动续跑，非幂等节点提示确认）。
4. 在 `src/index.ts` 启动序列里与 `bootRecoverSupervisor()` 并列调用。

### 6.3 版本锁定（AC3.5）
`graph_runs.definition_version` 在创建时锁定。`resume` 时校验 `graph_definitions(id, version)` 仍存在且 `manifest_hash` 一致；不一致→拒绝，提示需显式迁移。

## 7. Loop 断点续跑补债（AC8.1，外科手术式改动）

`src/loop-orchestrator.ts:432 executeGoalLoop` 当前 `for (let i = 0; i < ctx.maxTurns; i++)`。改动：

```typescript
// 续跑：若 loop_run 之前跑到 current_turn 后崩溃，从该轮继续
const existingRun = getLoopRun(ctx.loopRunId);
const startTurn = existingRun?.current_turn ?? 0;

for (let i = startTurn; i < ctx.maxTurns; i++) {
  // 检查取消（已有逻辑 :454-458）
  ...
  updateLoopRunStatus(ctx.loopRunId, 'running', { currentTurn: i });
  ...
}
```

**仅 2 行新增**，不改其他逻辑。续跑前清理：若 `startTurn > 0` 且对应 iteration 的 review_result 为空（崩溃在 review 前），重跑该 iteration（已有 iteration 记录 status=running 会被覆盖）。

**幂等性**：loop iteration 非严格幂等（agent 可能有副作用），但 Loop 本就是迭代式纠错，重跑当前轮可接受——这与现状（崩溃即失，整 Loop 作废重跑）相比是纯收益。

## 8. 流式事件（`shared/stream-event.ts` 扩展）

在 `shared/stream-event.ts`（单一真相源，`CLAUDE.md §3.2`）新增事件类型，`make sync-types` 同步 3 处副本：

```typescript
| { eventType: 'graph_start'; graph: { runId; definitionId; goalText; status } }
| { eventType: 'graph_node_start'; graph: { runId; nodeId; nodeType; attempt }; traceNode: {...} }
| { eventType: 'graph_node_status'; graph: { runId; nodeId; status; attempt } }
| { eventType: 'graph_node_end'; graph: { runId; nodeId; status; tokens; cost } }
| { eventType: 'graph_edge_taken'; graph: { runId; fromNodeId; toNodeId; conditionResult } }
| { eventType: 'graph_end'; graph: { runId; status; totalTokens; totalCost } }
```

`graph-events.ts` 的 `emitGraphEvent()` 复用 `LoopDeps.broadcastStreamEvent`。

## 9. 前端（复用 reactflow）

| 文件 | 职责 |
|------|------|
| `web/src/stores/graph.ts` | Zustand store：`graphRuns`/`graphNodeRuns[runId]`/当前选中节点；`loadGraphRun(runId)`/`subscribeGraphEvents(runId)`（SSE 或轮询）/`resumeGraph`/`pauseGraph`/`cancelGraph`/`rerunNode`。模仿 `stores/loops.ts` |
| `web/src/components/graph/GraphDagView.tsx` | 复用 `DagView.tsx` 的 lazy reactflow 模式，数据源换为 `graphNodeRuns`，节点按状态着色（running 脉冲/failed 红/completed 绿/paused 黄），fan-out/fan-in 边按 `parent_node_run_id` 还原 |
| `web/src/components/graph/GraphNodeDetail.tsx` | 节点详情：input/output/tokens/cost/attempt/error，支持 annotation 编辑 + rerun/resume 按钮（调服务端 AC3.4/AC4.4） |
| `web/src/pages/GraphPage.tsx` | 图运行列表 + 详情视图。模仿 `LoopsPage.tsx` |

**DagView 复用决策**：不直接改 `DagView.tsx`（它是 chat trace 专用），新建 `GraphDagView.tsx` 复用其 lazy import + 节点配色模式。两者共享 `@xyflow/react` 包，不增加依赖。

## 10. 路由（`src/routes/graph.ts`）

模仿 `routes/loops.ts`，Hono + authMiddleware：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/graph/definitions` | GET | 列出图定义 |
| `/api/graph/definitions/:id` | GET | 图定义详情（含 Mermaid） |
| `/api/graph/runs` | GET/POST | 列出/启动图运行 |
| `/api/graph/runs/:id` | GET | 图运行 + 节点树 |
| `/api/graph/runs/:id/resume` | POST | 续跑（AC3.4） |
| `/api/graph/runs/:id/pause` | POST | 暂停（AC4.1） |
| `/api/graph/runs/:id/cancel` | POST | 取消（AC4.3） |
| `/api/graph/runs/:id/nodes/:nodeId/rerun` | POST | 节点级重跑（AC4.4） |
| `/api/graph/runs/:id/usage` | GET | token/cost 聚合 |

挂载点：`src/web.ts:264-292` 附近，与 `loopsRoutes` 并列。

## 11. MCP 工具（可选，P0 可后置）

`container/agent-runner/src/mcp-tools.ts` 新增 `graph_get_status`/`graph_wait_node`（让 Agent 在 graph 内查询兄弟节点状态）。P0 可不实现，agent 节点隔离执行即可。

## 12. 实施计划（P0 分阶段提交）

| 阶段 | 内容 | 提交 |
|------|------|------|
| C1 | DB schema v52 + 4 表 + db.ts CRUD 函数 | commit 1 |
| C2 | graph-types.ts + graph-registry.ts（定义+校验+Mermaid） | commit 2 |
| C3 | graph-runner.ts（单节点执行，复用 runOneIteration 模式） | commit 3 |
| C4 | graph-scheduler.ts + graph-orchestrator.ts（拓扑调度+并行+checkpoint+resume） | commit 4 |
| C5 | graph-recovery.ts + index.ts 启动调用 | commit 5 |
| C6 | Loop 断点续跑补债（executeGoalLoop 2 行） | commit 6 |
| C7 | shared/stream-event.ts graph_* 事件 + graph-events.ts | commit 7 |
| C8 | routes/graph.ts + web.ts 挂载 | commit 8 |
| C9 | 前端 stores/graph.ts + GraphDagView + GraphNodeDetail + GraphPage | commit 9 |
| C10 | graph-commands.ts /graph 斜杠命令 | commit 10 |

每阶段提交后跑对应测试用例（PRD §5 TC1-18），失败→查 log+代码→修复→重测，Supervisor 闭环。

## 12. 验收与测试对应

PRD §5 的 18 个测试用例分布到 C1-C10：
- C1：无（DB 基础）
- C2：TC4（环检测）、TC16（Mermaid）
- C3+C4：TC1（线性）、TC2（fan-out）、TC3（branch）、TC5（retry）、TC14（并发上限）、TC15（并发写隔离）
- C4+C5：TC6（崩溃续跑）、TC7（resume API）、TC8（版本锁）、TC9（pause）、TC10（cancel）、TC11（rerun）、TC17（幂等校验）
- C6：TC13（Loop 续跑）
- C7+C9：TC12（前端高亮）、TC18（span 树）

## 13. 风险与缓解

| 风险 | 缓解 |
|------|------|
| GroupQueue 单 active 限制阻断节点并发 | 节点级独立子工作区，不共用 folder-level active 标志；C4 阶段单独验证 TC15 |
| 节点非幂等续跑副作用重复 | `is_idempotent` 标记，非幂等节点 resume 前强制确认（TC17） |
| 续跑版本漂移 | `definition_version`+`manifest_hash` 双锁（TC8） |
| 循环子图自旋（P0 禁环） | C2 环检测拒绝，SCC 识别 |
| trace 数据爆炸 | graph_node_runs 只存 summary（output 截断 500/10000 字符），详细 trace 走现有 chat_trace_nodes |
| 工作区磁盘膨胀 | graph-node-run 完成后清理子工作区（保留 output_summary） |

## 14. 非目标重申

- 不替换 SubAgent/Conversation Agent/Supervisor
- 不做循环节点（P2）、动态子图（P3）、Temporal（P3）、设计态拖拽（P2）、HITL 飞书审批（P1）
- 不改 `loop_*` 表结构（仅 executeGoalLoop 入口 2 行）
- 不引入外部图数据库
