# 技术方案：超级 Agent 团队（Super Agent Team）—— 自主 Multi-Agent 协同工作模式

> 关联 PRD：`docs/prd/super-agent-team/PRD.md`
> 分支：`feat/super-agent-team`
> 状态：v1
> 日期：2026-07-22

## 0. 设计总则

**核心判断**：Super Agent Team 不是新引擎，而是 graph-engineering 之上的**自主组建层**。复用 graph-orchestrator 100% 执行/调度/checkpoint/续跑/恢复；复用 Agent Definitions 基础设施（`createAgentDefinition`/`addAgentMount`/`loadGroupAgentDefinition`）做"自主创建 Agent"；复用 `harness-eval.scoreAssertion` 做行为证据验收；复用 `runScript` 做 shell 检查；复用 `chat_trace_nodes` + 新增 `trace_tool_calls` 做节点内子步骤 trace；复用 `GraphDagView`/`GraphNodeDetail` 做可视化。Team Builder 产出的就是标准 `GraphDefinition`。

**不改动**（Surgical Changes）：graph-scheduler/graph-orchestrator 核心调度逻辑零改动；agent-runner 内核零改动（仅经 `ContainerInput` 既有字段透传）；既有 Loop/Supervisor 零改动；既有 chat trace 行为不回归。仅扩展：`GraphNode` 类型、`graph-runner.runAgentNode`/`runGateNode`、`chat-trace-persist`、`ContainerInput`（加 2 字段）、`buildOwnerGroup`（设 agentDefId）、DB schema v52→v53（加列+加表）、前端 `GraphNodeDetail`+`stores/team.ts`+`TeamPage`。

**目录约定**：新后端代码集中 `src/agent-team/`；trace 扩展在 `src/chat-trace-persist.ts`+`src/db.ts`；graph 扩展在 `src/graph-engineering/graph-types.ts`+`graph-runner.ts`；前端 `web/src/pages/TeamPage.tsx`+`web/src/stores/team.ts`+`web/src/components/graph/NodeTraceSubgraph.tsx`；路由 `src/routes/team.ts`+`src/routes/graph.ts`（加 trace 端点）。

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  前端 TeamPage (React) — 输入复杂任务 → 看团队组建 + DAG 实时执行 │
│   ↑ POST /api/team/runs   ↑ SSE graph_* 事件(既有)            │
│   ↑ GET /api/graph/runs/:id/nodes/:nodeId/trace (新)          │
├──────────────────────────────────────────────────────────────┤
│  路由层 src/routes/team.ts (Hono, authMiddleware)              │
│         src/routes/graph.ts (+trace 端点)                      │
├──────────────────────────────────────────────────────────────┤
│  Agent Team 层 (src/agent-team/)                              │
│   ┌────────────────┐  ┌──────────────┐  ┌────────────────┐  │
│   │ team-builder.ts │→│ (复用)        │  │ team-plan.ts    │  │
│   │ 元Agent:拆解   │ │ createAgent  │  │ zod schema +    │  │
│   │ +创建+启动     │ │ Definition/  │  │ TeamPlan 类型   │  │
│   └────────────────┘  │ addAgentMount│  └────────────────┘  │
│         │             │ /loadGroup.. │                      │
│         ▼             └──────────────┘                      │
│   产出标准 GraphDefinition（agent 节点带 agentDefId+goalAnchor, │
│   gate 节点带 assertions+shellCheck）→ createGraphDefinition  │
│         │ → startGraphRun → buildRunContext → executeGraph    │
├──────────────────────────────────────────────────────────────┤
│  复用既有 graph-engineering 执行层（零改动）                    │
│   graph-orchestrator → graph-scheduler → graph-runner         │
│   （graph-runner 扩展 runAgentNode/runGateNode + trace 标记）  │
├──────────────────────────────────────────────────────────────┤
│  复用既有 agent-runner（零改动内核）                            │
│   ContainerInput.agentDefinition 注入 systemPrompt/engine/     │
│   skills/mcp；新增 ContainerInput.graphRunId/graphNodeId 透传  │
├──────────────────────────────────────────────────────────────┤
│  Trace 层：chat_trace_nodes(+graph_run_id/graph_node_id/       │
│   tool_name/tool_use_id 列) + trace_tool_calls(新表)           │
│   chat-trace-persist 扩展：捕获 toolInput/toolResult           │
├──────────────────────────────────────────────────────────────┤
│  SQLite (schema v52→v53)                                       │
└──────────────────────────────────────────────────────────────┘
```

## 2. 数据模型（schema v52 → v53）

`SCHEMA_VERSION` 由 `'52'`（`src/db.ts:1933`）改为 `'53'`。沿用既有 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` 迁移惯例（不动既有列）。

### 2.1 `chat_trace_nodes` 加列（对齐 `loop_trace_nodes`，向后兼容）

```sql
ALTER TABLE chat_trace_nodes ADD COLUMN graph_run_id TEXT;
ALTER TABLE chat_trace_nodes ADD COLUMN graph_node_id TEXT;
ALTER TABLE chat_trace_nodes ADD COLUMN tool_name TEXT;
ALTER TABLE chat_trace_nodes ADD COLUMN tool_use_id TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_trace_graph ON chat_trace_nodes(graph_run_id, graph_node_id);
```
实现：在 `initDatabase()` 里用 `try { ALTER TABLE ... } catch {}` 包裹（既有迁移惯例，列已存在则忽略），或 `PRAGMA table_info` 检测列存在性（与既有 v52 迁移一致）。`ChatTraceNodeRow`/`ChatTraceNodeUpsertInput` 类型加对应可选字段。

### 2.2 新表 `trace_tool_calls`（工具调用原始 I/O）

```sql
CREATE TABLE IF NOT EXISTS trace_tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_run_id TEXT,
  graph_node_id TEXT,
  chat_jid TEXT,
  tool_use_id TEXT NOT NULL,          -- SDK tool_use id（去重键）
  tool_name TEXT NOT NULL,
  input_json TEXT,                    -- 工具入参 JSON（截断 64KB）
  output_json TEXT,                   -- 工具结果 JSON（截断 64KB）
  status TEXT,                        -- success/failed/denied
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(graph_run_id, tool_use_id)
);
CREATE INDEX IF NOT EXISTS idx_trace_tool_graph ON trace_tool_calls(graph_run_id, graph_node_id);
```
CRUD 函数（仿 `upsertChatTraceNode` 幂等模式）：`upsertTraceToolCall(input)`、`listTraceToolCalls(graphRunId, graphNodeId)`。

### 2.3 既有 4 张 graph 表（v52 已建，零改动）
`graph_definitions`/`graph_runs`/`graph_node_runs`/`graph_node_run_locks` 不动。`GraphNode` 新字段（agentDefId/goalAnchor/agentMember/assertions/shellCheck/upstreamNodeId）序列化进既有 `nodes_json` 列（`graph-registry` 既有 JSON 序列化自动携带，无需改表）。

## 3. 模块结构

| 文件 | 职责 | 行数估 | 新建/扩展 |
|------|------|--------|----------|
| `src/agent-team/team-plan.ts` | `TeamPlan`/`TeamMember`/`TeamGraphNode` zod schema + 类型 + 校验 | ~150 | 新建 |
| `src/agent-team/team-builder.ts` | `buildTeam(input)`：sdkQuery 拆解 → 校验 → 创建 agent_definition + mounts → 组装 GraphDefinition → 注册+启动 | ~350 | 新建 |
| `src/agent-team/team-prompt.ts` | 拆解 prompt 模板 + goalAnchor 拼装模板 | ~120 | 新建 |
| `src/routes/team.ts` | `POST /api/team/runs` + `GET /api/team/runs` | ~100 | 新建 |
| `src/graph-engineering/graph-types.ts` | `GraphNode` 加 agentDefId/goalAnchor/agentMember/assertions/shellCheck/upstreamNodeId | +~25 | 扩展 |
| `src/graph-engineering/graph-runner.ts` | `runAgentNode`：buildOwnerGroup 设 agentDefId + goalAnchor 前置 + trace 透传；`runGateNode`：shellCheck+assertions+LLM | +~120 | 扩展 |
| `src/chat-trace-persist.ts` | 捕获 StreamEvent toolInput/toolResult 写 trace_tool_calls + 给 traceNode 打 graph 标记 | +~60 | 扩展 |
| `src/container-runner.ts` | `ContainerInput` 加 `graphRunId?`/`graphNodeId?` 透传字段 | +~6 | 扩展 |
| `src/db.ts` | schema v53 + 加列 + trace_tool_calls 表 + CRUD + trace 查询函数 | +~120 | 扩展 |
| `src/routes/graph.ts` | `GET /api/graph/runs/:id/nodes/:nodeId/trace` | +~40 | 扩展 |
| `web/src/stores/team.ts` | Zustand：buildTeam/teamRuns/subscribeTeamEvents | ~120 | 新建 |
| `web/src/pages/TeamPage.tsx` | 任务输入 → 组建 → 跳转 graph run | ~180 | 新建 |
| `web/src/components/graph/NodeTraceSubgraph.tsx` | 节点内子步骤 span 树 + 工具 I/O 折叠 | ~220 | 新建 |
| `web/src/components/graph/GraphNodeDetail.tsx` | 挂载 NodeTraceSubgraph | +~15 | 扩展 |

## 4. 核心算法

### 4.1 Team Builder 拆解与组建（`team-builder.ts`）

```
buildTeam(input: TeamTaskInput):
  1. prompt = buildDecompositionPrompt(input)  // goal+background+acceptanceCriteria+成员设计指引
  2. raw = await sdkQuery(prompt, {timeout: 90_000})  // 单轮、无工具
  3. plan = parseAndValidate(raw)  // zod 校验 TeamPlan；非法→重试1次→仍非法→降级单agent模板
  4. 持久化 root trace span（node_type='team_build', title=plan.teamName）
  5. for member in plan.members:
       def = getAgentDefinitionByName(ownerUserId, member.name)  // 幂等
       if not def: def = createAgentDefinition(ownerUserId, {
                name: member.name, system_prompt: member.systemPrompt,
                engine: member.engine ?? 'claude', model: member.model ?? null,
                max_turns: member.maxTurns ?? 20 })
       for skill in member.skills ?? []: addAgentMount(def.id, 'skill', skill)
       for mcp  in member.mcpServers ?? []: addAgentMount(def.id, 'mcp_server', mcp)
       memberMap[member.name] = def.id
  6. graphDef = assembleGraphDefinition(plan, memberMap, input)  // 见 4.2
  7. defId = createGraphDefinition(graphDef)
  8. started = startGraphRun({definitionId: defId, ownerUserId, groupFolder, chatJid, goalText: input.goalText})
  9. buildRunContext(started.runId, graphDeps).then(ctx => executeGraph(ctx, graphDeps))  // 后台 detached
  10. 返回 {runId, definition: started.definition, plan}
```

**幂等性**：`getAgentDefinitionByName`（新增 db.ts 查询：by user_id+name）确保同 teamName+member.name 不重复创建。graph 定义 id 用 `team-{teamName}-{hash}`，重复 build 同任务可复用或生成新版本（P0 每次新版本，简单）。

### 4.2 assembleGraphDefinition（`team-builder.ts`）

```
assembleGraphDefinition(plan, memberMap, input):
  nodes = []
  edges = []
  for gn in plan.graph.nodes:
    node: GraphNode = {id: gn.id, type: gn.type, title: gn.title}
    if gn.type == 'agent':
      node.agentDefId = memberMap[gn.agentMember]
      node.agentMember = gn.agentMember
      node.goalAnchor = buildGoalAnchor(input, gn)  // 原始goal+验收标准+角色+交付物
      node.prompt = gn.deliverable ?? gn.title      // 节点任务说明
    if gn.type == 'gate':
      node.assertions = gn.assertions ?? []
      node.shellCheck = gn.shellCheck
      node.upstreamNodeId = gn.upstreamNodeId ?? (最近前驱)
      node.successCriteria = gn.successCriteria ?? input.acceptanceCriteria
    nodes.push(node)
    for dep in gn.dependsOn ?? []: edges.push({id: `${dep}->${gn.id}`, from: dep, to: gn.id, type:'data'})
  // 末端验收 gate 兜底：若 plan 未显式声明验收 gate，自动追加
  if not hasAcceptanceGate(plan): append {id:'accept', type:'gate',
      assertions:[{kind:'contains', value: 截取acceptanceCriteria关键词}], shellCheck: plan.shellCheck,
      dependsOn:[最后一个agent]} 
  return {id:`team-${plan.teamName}`, version:1, name:plan.teamName, nodes, edges}
```

### 4.3 graph-runner.runAgentNode 扩展（`graph-runner.ts:235`）

关键改动点（最小侵入）：

```
runAgentNode(ctx, deps, node):
  executionMode = resolveExecutionMode(ctx, deps)
  group = buildOwnerGroup(ctx, executionMode)
  // 【扩展1】若 node.agentDefId 存在，设到合成 group，container-runner 既有
  //         loadGroupAgentDefinition(group.agentDefId, group.created_by) 自动加载
  if node.agentDefId: (group as any).agentDefId = node.agentDefId
  input: ContainerInput = {
    prompt: node.goalAnchor ? `${node.goalAnchor}\n\n---\n\n${node.prompt ?? node.title}` : (node.prompt ?? node.title),
    groupFolder, chatJid, isMain, isHome:true, isAdminHome, turnId, userLanguage,
    // 【扩展2】trace 透传
    graphRunId: ctx.graphRunId, graphNodeId: node.id,
  }
  ... 既有 runAgent(...) 调用与 stream 回调不变 ...
```

`buildOwnerGroup`（`graph-runner.ts:98`）已设 `owner_user_id: ctx.ownerUserId`，故 `group.created_by` 可用；container-runner `loadGroupAgentDefinition(group.agentDefId, group.created_by)` 自动加载——**零改 container-runner 加载逻辑**。

**goalAnchor 前置**：把原始 goal+验收标准+角色+交付物拼到 prompt 头部，每轮执行重申（解决"忘记目标"）。

**trace 透传**：`ContainerInput` 加 `graphRunId?`/`graphNodeId?`；container-runner 既有 `dockerInput = {...input, ...}` / `hostInput = {...input, ...}` 展开会自动携带（零改 container-runner，仅类型加字段）。agent-runner 收到后，在构造 StreamEvent 的 `traceNode` 时把 `graphRunId`/`graphNodeId` 回填到 traceNode，使后端 `persistTraceNodeFromStreamEvent` 能打标。

> agent-runner 改动最小化：仅在 `container/agent-runner/src/stream-processor.ts`/`trace-node-allocator.ts` 构造 traceNode 时，若 `input.graphRunId` 存在则附加到 traceNode 的一个新可选字段（`graphRunId`/`graphNodeId`），写入 `StreamEvent.traceNode`。后端 persist 读这两个字段。这是 FP4 唯一需要碰 agent-runner 的点，且是纯附加字段。

### 4.4 graph-runner.runGateNode 扩展（`graph-runner.ts:302`）

```
runGateNode(node):
  upstreamOutput = 读 node_<upstreamNodeId>_output（从 ctx.state 或重跑读取上游产出）
  // 1. 行为证据：shellCheck（若存在）
  if node.shellCheck:
    res = await runScript(node.shellCheck, ctx.groupFolder)
    if res.exitCode !== 0:
      return failed(output: `shellCheck 失败(exit ${res.exitCode})\n${res.stdout.slice(0,2000)}\n${res.stderr.slice(0,1000)}`)
    shellEvidence = res.stdout.slice(0,2000)
  // 2. 行为证据：assertions（复用 harness-eval.scoreAssertion）
  hadError = !!node.shellCheck && res.exitCode !== 0
  for a in node.assertions ?? []:
    r = scoreAssertion(a, upstreamOutput + '\n' + (shellEvidence ?? ''), hadError)
    if not r.pass: return failed(output: `断言失败 [${a.kind}:${a.value}] ${r.detail}`)
  // 3. LLM 评审（既有，兜底；行为证据已过才跑）
  prompt = buildGatePrompt(node, upstreamOutput)
  raw = await lightweightSdkQuery(prompt, {timeout: GATE_REVIEW_TIMEOUT_MS})
  parsed = parseReviewResult(raw)
  status = parsed.result === 'pass' ? completed : failed
  return {status, output: 行为证据明细 + parsed.reason}
```

gate 节点需要读上游产出：`runGateNode` 签名加 `ctx: GraphRunContext`（当前只收 `node`），从 `ctx.state` 读 `node_<upstreamNodeId>_output`。`dispatchByType` 的 gate 分支改为 `runGateNode(node, ctx)`。

### 4.5 trace 持久化扩展（`chat-trace-persist.ts`）

```
persistTraceNodeFromStreamEvent(chatJid, event):
  if event.traceNode:
    tn = event.traceNode
    upsertChatTraceNode({
      ...既有字段...,
      graph_run_id: tn.graphRunId ?? null,    // 新
      graph_node_id: tn.graphNodeId ?? null,  // 新
      tool_name: tn.toolName ?? null,         // 新
      tool_use_id: tn.toolUseId ?? null,      // 新
    })
  // 新：捕获工具调用原始 I/O
  if event.toolInput && event.toolUseId:
    upsertTraceToolCall({graph_run_id, graph_node_id, chat_jid, tool_use_id, tool_name, input_json: 截断(event.toolInput,64KB), status:'running', started_at})
  if event.toolResult && event.toolUseId:
    upsertTraceToolCall({..., output_json: 截断(event.toolResult,64KB), status: event.permissionDenied?'denied':'success', ended_at})
```

StreamEvent 的 `toolInput`/`toolResult`/`toolUseId`/`permissionDenied` 字段已存在于 `stream-event.types.ts:78-190`（既有），仅是此前未持久化。

## 5. 流式事件（既有 graph_* 复用，新增 team_build 标记）

Team Builder 组建过程复用既有 `graph_start`/`graph_node_start`/`graph_node_end`/`graph_end` 事件——因为 Team Builder 最终启动的就是标准 GraphRun。组建期（拆解 JSON/创建 agent）的 trace 写 `chat_trace_nodes`（node_type='team_build'），不新增事件类型（Simplicity First）。前端 `stores/team.ts` 订阅既有 graph_* SSE 即可看到 DAG 实时构建。

## 6. 路由（`src/routes/team.ts` + `src/routes/graph.ts` 扩展）

### 6.1 `src/routes/team.ts`（仿 `routes/loops.ts`）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/team/runs` | POST | 入参 `{goalText, background?, acceptanceCriteria?}`；调 `buildTeam`；返回 `{runId, definition, plan}` |
| `/api/team/runs` | GET | 列出 team 启动的 graph runs（复用 `listGraphRuns` 按 goal_text 非空过滤，或加 team 标记） |

挂载：`src/web.ts` 与 `loopsRoutes`/`graphRoutes` 并列。`buildTeam` 依赖 `GraphDeps`（与 `webDeps.startGraphRun` 同源），从 `webDeps` 注入。

### 6.2 `src/routes/graph.ts` 扩展

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/graph/runs/:id/nodes/:nodeId/trace` | GET | 返回 `{traceNodes: ChatTraceNodeRow[], toolCalls: TraceToolCallRow[]}` |

## 7. 前端

| 文件 | 职责 |
|------|------|
| `web/src/stores/team.ts` | `buildTeam(input)` 调 `POST /api/team/runs`；`teamRuns` 列表；订阅 graph_* SSE 复用 `stores/graph.ts` 逻辑 |
| `web/src/pages/TeamPage.tsx` | textarea 输入复杂任务（goal/背景/验收标准）→"组建团队"按钮 → POST → 跳转 `GraphPage` 对应 runId 详情；展示 Team Builder 返回的 plan（成员表 + DAG 预览 mermaid） |
| `web/src/components/graph/NodeTraceSubgraph.tsx` | 调 `GET /api/graph/runs/:id/nodes/:nodeId/trace` → reactflow 子画布渲染 trace span 树（turn/tool 节点按状态着色）+ 每步工具调用 input/output 折叠面板 + token/cost |
| `web/src/components/graph/GraphNodeDetail.tsx` | 当节点 type=agent 时挂载 `<NodeTraceSubgraph runId nodeId />` |

**TeamPage 入口**：在主导航或 GraphPage 顶部加"组建团队"按钮（模仿 LoopsPage 的"新建 Loop"入口）。

## 8. Supervisor 路由 Hook（AC1.5 最小接入）

`src/supervisor.ts:runSupervisorPreDispatch` 当前输出 `clarify/delegate/auto/accept/retry`。AC1.5 的 Supervisor 接入：当判定为"超复杂任务"（启发式：goal 含"调研+实现+测试"等多动词、或长度 > N、或用户显式 `/team`）时，新增决策分支 `delegate_team`——把原消息转给 Team Builder。P0 最小实现：在 `/team` 命令路由（`src/index.ts` 斜杠命令分发处，与 `/graph` 并列 `:2187`）直接走 Team Builder；Supervisor 自动判定 `delegate_team` 列为 P1（不阻塞 P0，P0 靠 `/team` 命令 + Web 入口）。

## 9. 实施计划（P0 分阶段提交）

| 阶段 | 内容 | 提交 |
|------|------|------|
| C1 | DB schema v53 + chat_trace_nodes 加列 + trace_tool_calls 表 + db.ts CRUD（upsertTraceToolCall/listTraceToolCalls/getAgentDefinitionByName） | commit 1 |
| C2 | graph-types.ts GraphNode 扩展 + graph-runner runAgentNode（agentDefId+goalAnchor+trace 透传）+ runGateNode（shellCheck+assertions+LLM）+ ContainerInput 加 graphRunId/graphNodeId | commit 2 |
| C3 | chat-trace-persist 扩展（捕获 toolInput/toolResult + graph 标记）+ agent-runner traceNode 附加 graphRunId/graphNodeId 字段 + shared/stream-event traceNode 类型加字段 | commit 3 |
| C4 | agent-team/team-plan.ts（zod schema）+ team-prompt.ts + team-builder.ts（buildTeam 全流程） | commit 4 |
| C5 | routes/team.ts + web.ts 挂载 + index.ts 注入 GraphDeps + /team 命令路由 | commit 5 |
| C6 | routes/graph.ts trace 端点 | commit 6 |
| C7 | 前端 stores/team.ts + TeamPage.tsx + NodeTraceSubgraph.tsx + GraphNodeDetail 挂载 | commit 7 |
| C8 | 浏览器 UI E2E（TC19）+ 修复循环 + 测试报告 | commit 8 |

每阶段提交后跑对应 TC（PRD §5），失败→查 log+代码→修复→重测，Supervisor 闭环。

## 10. 验收与测试对应

PRD §5 的 20 个 TC 分布到 C1-C8：
- C1：TC12/TC13/TC14（trace 表与幂等）
- C2：TC6/TC7/TC8/TC9/TC10/TC11（agent 节点注入 + gate 行为证据 + 向后兼容）
- C3：TC12/TC13/TC14（trace 持久化 + 工具 I/O 捕获）
- C4：TC1/TC2/TC3/TC4（Team Builder 拆解+创建+组装）
- C5：TC5（/api/team/runs + /team 命令）
- C6：TC15（trace 查询 API）
- C7：TC16/TC17（DAG 渲染 + 节点内子图）
- C8：TC18/TC19/TC20（验收闭环 + E2E + 崩溃恢复回归）

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Team Builder LLM 产出非法 JSON | zod 严格校验 + 重试 1 次 + 降级单 agent 模板 |
| shellCheck 命令注入/破坏性 | 复用 runScript（/bin/sh、超时、1MB 缓冲）；套 Bash 安全守则红线拦截；P0 shellCheck 仅来自 Team Builder 受限模板或用户显式确认 |
| trace 数据爆炸 | trace_tool_calls input/output 截断 64KB + TTL + 成功 span 可采样 |
| 并行 agent 节点 CLAUDE.md 写冲突 | buildOwnerGroup 设 agentDefId 触发 writeAgentProjectClaudeMd 写 owner folder；P0 Team Builder 倾向串行 DAG；文件级隔离 P1；`<agent-definition>` 标签注入为主路径（不依赖 CLAUDE.md 写） |
| 自主 systemPrompt 越权 | agent-runner 既有 security-rules.md/mount-security/im-safety 始终生效；Team Builder 不赋提权工具；systemPrompt 经 append 注入不替换安全段 |
| Schema 迁移破坏既有 DB | CREATE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS（既有惯例），不动既有列 |
| 目标锚点被 LLM 忽略 | goalAnchor 同时作为末端 gate assertions 依据，行为证据兜底 |

## 12. 非目标重申

- 不改 graph-scheduler/graph-orchestrator 核心调度。
- 不改 agent-runner 内核（仅 traceNode 附加 2 字段）。
- 不改既有 Loop/Supervisor 核心逻辑。
- 不做运行中动态 re-plan（P1）、团队自进化（P2）、human 完整 HITL（P1）、设计态拖拽（P2）、循环节点（P2）。
- 不引入外部 trace 后端（继续 SQLite）。
