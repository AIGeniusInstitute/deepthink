# PRD：超级 Agent 团队（Super Agent Team）—— 自主 Multi-Agent 协同工作模式

> 状态：草案 v1，待评审
> 分支：`feat/super-agent-team`
> 作者：DeepThink
> 日期：2026-07-22
> 关联背景：当前 DeepThink 主 Agent 从头到尾单线完成用户任务，存在"提前宣布完成、询问人工确认中途中断、忘记最初任务目标"等问题。本 PRD 提出复刻人类社会组织/科研团队组织的真正 Multi-Agent 多角色协同工作模式。
> 关联既有能力：复用 `graph-engineering`（DAG 编排层，P0 已落地）、`Agent Definitions / Agent Studio`（agent_definition + agent_mounts）、`harness-eval`（行为证据断言）。

---

## 0. 背景与动机

DeepThink 当前主任务执行范式是**单主 Agent 串行循环**：一个主 Agent（Claude SDK preset + DeepThink prompt 段 + 全工具 + 全技能）从头到尾完成用户输入任务，可选叠加旁路 Supervisor（LLM 自评）与 Loop（LLM 自评迭代）。

代码级根因分析（证据见 `docs/tech_solution/super-agent-team/SOLUTION.md §1`）：

- **提前宣布完成**：Loop Orchestrator 的 `runReviewer`（`loop-orchestrator.ts:387`）与 Supervisor 的 `runSupervisionCheck`（`supervisor-agent.ts:458`）评审都依赖**同一模型对 Agent 文本自述的判断**——评审者只看 `agentOutput.slice(0,8000)` 文本，没有工具去验证产出是否真实存在。Agent 声称"已完成"→ 评审者基于文本判定 pass → `executeGoalLoop:506` 提前 `completed`。仓库已有的 `harness-eval`（断言打分：contains/not_contains/regex/no_error）和 `harness-meta-loop`（`judgeVerdict` 只看 pass/fail 集合、不读 proposal 论证文本）才是正确范式，却**尚未接入主任务循环**。
- **忘记任务目标**：目标文本仅作为 prompt 一次性注入（`buildIterationPrompt:138`），每轮 reviewHint 只注入上一轮 `suggestion`，**不重申原始 goal**。长会话 + compaction 后原始 goal 极易从上下文中被压缩掉。
- **中途中断/询问人工确认**：单 Agent 遇到歧义即停下来问人，缺乏"先拆解、再分派、分派不下去再问"的组织层。
- **无组织协同**：SubAgent/Conversation Agent/Supervisor 三套机制语义重叠，无统一"组建团队→分派→验收"编排层。

业界与 DeepThink 自身演进方向：单 Agent → Loop（迭代纠错）→ Graph（DAG 编排）→ **Team（自主组建多角色协同）**。Graph Engineering 已在 Loop 之上加了编排层（`src/graph-engineering/`，P0 落地：节点 agent/gate/branch/join/human、DAG 调度、checkpoint、断点续跑、`/api/graph/*`、`GraphPage` 可视化）。但当前 Graph 的图定义是**人工/模板静态声明**的，节点 agent 是**黑盒**（只跑一个 prompt），trace 只存**节点级摘要**——缺"自主组建团队""节点内子步骤可观测""行为证据验收"三大能力。

本 PRD 在 graph-engineering 之上新增**自主团队组建层 + 节点内子图 trace + 行为证据验收闭环**，把"单主 Agent"范式升级为"DeepThink 自主组建的 Agent 团队"范式。

## 1. 目标

**需求1（自主团队组建）**：DeepThink 接收超级复杂任务后，自主拆解任务、组建 Agent Team——自主创建 Agent 成员（自主设计 System Prompt、自主选择 Engine/Skill/MCP 工具）、自主设计团队 DAG（谁先做、谁后做、谁验收）、把目标/背景/验收标准自主下发给 Team，并启动 Team 执行。

**需求2（全链路可视化 + 节点内子图 trace）**：执行过程用 DAG 任务计算图可视化呈现给用户；每个图节点（Agent）内部还有执行步骤节点（子图），全部执行步骤、工具调用、模型输入输出记录 Trace 数据库，可回溯可追踪。

**需求3（行为证据验收闭环）**：执行任务测试验收采用**行为证据**（断言/命令检查，而非 LLM 自述），发现问题循环执行前面步骤，直到完成任务目标或耗尽重试预算——从根本上解决"提前宣布完成"。

## 2. 设计原则（约束本 PRD 范围）

1. **Team = Graph 之上的自主组建层**，不推翻 graph-engineering/Loop/Supervisor，只在其上加一层。Team Builder 产出的就是标准 `GraphDefinition`，复用 graph-orchestrator 100% 执行/调度/checkpoint/续跑/恢复逻辑。
2. **复用 Agent Definitions 基础设施**做"自主创建 Agent"：Team Builder 调 `createAgentDefinition()` + `addAgentMount()` 写 `agent_definitions` + `agent_mounts` 表，而非发明新的 agent spec 格式。graph 节点通过新增 `agentDefId` 字段引用已创建的 agent 定义，`graph-runner` 通过既有 `loadGroupAgentDefinition()` 加载并经 `ContainerInput.agentDefinition` 注入。
3. **行为证据优先于 LLM 自述**：gate 验收节点支持 `harness-eval` 风格断言（contains/not_contains/regex/no_error）+ 可选 shell 检查命令；断言失败即节点 failed，触发 graph 既有 retry/rerun。复用 `harness-eval.ts:157 scoreAssertion` 纯函数，不重写。
4. **目标锚点每轮重申**：Team Builder 把原始 goal + 验收标准注入每个 agent 节点的 `goalAnchor`，`graph-runner` 每次执行节点时把 goal 锚点拼进 prompt 头部；retry 时 orchestrator 重申。解决"忘记目标"。
5. **Simplicity First**：P0 只做"自主静态组建团队 + 节点内子步骤 trace + 断言验收闭环 + 子图可视化"。运行中动态重组团队（re-plan）、human 节点完整 HITL 飞书审批、循环节点列为 P1/P2。
6. **Surgical Changes**：不改动 graph-scheduler/graph-orchestrator 核心调度逻辑（仅 `runAgentNode`/`runGateNode` 两处扩展 + trace 持久化桥接扩展）；不改动既有 Loop/Supervisor；DB schema 在 v52 之后顺延新增列与新表，不动既有列。

## 3. 功能点与验收标准

> 标注 P0（MVP 必做）/ P1（高价值紧跟）/ P2（后续）/ P3（远期）

### 功能点 1：Team Builder 元 Agent（自主拆解 + 组建 + 启动）— P0

**描述**：新增 `src/agent-team/team-builder.ts`。接收 `TeamTaskInput { goalText, background?, acceptanceCriteria?, ownerUserId, groupFolder, chatJid }`，用 `sdkQuery`（轻量 LLM，单轮、无工具）把复杂任务拆解为结构化团队计划 JSON，然后自主创建 Agent 成员、组装 GraphDefinition、注册并启动 GraphRun。

**Team Builder 输出契约**（LLM 产出的 JSON，`team-builder.ts` 校验后落地）：
```jsonc
{
  "teamName": "slug",
  "members": [
    {
      "name": "researcher",                         // agent_definition name (slug)
      "role": "需求调研员",
      "systemPrompt": "你是资深需求调研员……",        // 自主设计
      "engine": "claude",                           // 自主选择 claude|atomcode|codex|opencode
      "model": null,                                // null=继承全局
      "skills": ["web-research"],                   // 自主选择挂载 skill（可空）
      "mcpServers": ["deepthink"],                  // 自主选择挂载 MCP（可空）
      "maxTurns": 20,
      "deliverable": "产出调研报告 docs/.../report.md"
    }
  ],
  "graph": {
    "nodes": [
      { "id": "research", "type": "agent", "agentMember": "researcher", "title": "需求调研" },
      { "id": "impl",     "type": "agent", "agentMember": "implementer", "title": "方案实现",
        "dependsOn": ["research"] },
      { "id": "accept",   "type": "gate",  "title": "验收",
        "assertions": [ { "kind": "regex", "value": "测试通过" } ],
        "shellCheck": "make test 2>&1 | tail -5",     // 可选：行为证据命令
        "dependsOn": ["impl"] }
    ]
  },
  "acceptanceCriteria": "……（从用户输入继承，注入最终 gate）"
}
```

**验收标准**：
- AC1.1 `buildTeam(input)` 调用一次 `sdkQuery`（maxTurns:1、无工具）产出团队计划 JSON；JSON 不合法（缺 members/缺 graph/有环/引用不存在的 member）时 `team-builder.ts` 拒绝并返回结构化错误，不产生副作用。
- AC1.2 对每个 member，自主调 `createAgentDefinition(ownerUserId, {name, system_prompt, engine, model, max_turns})` 建 `agent_definitions` 行；自主调 `addAgentMount()` 按 member.skills/mcpServers 绑定 `agent_mounts`（resource_type='skill'/'mcp_server'）。所有成员创建幂等：同 `teamName+member.name` 已存在则复用而非重复创建。
- AC1.3 组装标准 `GraphDefinition`：agent 节点带 `agentDefId`（指向刚创建的 agent_definition.id）+ `goalAnchor`（原始 goal+验收标准）；gate 节点带 `assertions`/`shellCheck`/`successCriteria`；边由 `dependsOn` 推导。调既有 `createGraphDefinition()` 注册、`startGraphRun()` 启动。
- AC1.4 Team Builder 把用户输入的 `acceptanceCriteria` 注入最终 gate 节点 + 每个 agent 节点的 `goalAnchor`，确保目标不被遗忘。
- AC1.5 入口齐全：① `POST /api/team/runs`（Hono 路由，authMiddleware）；② `/team <task>` 斜杠命令（IM + Web）；③ 可选：Supervisor 预派发识别到"超复杂任务"时自动 `delegate` 到 Team Builder（AC1.5 的 Supervisor 接入列为 P0 最小 Hook，路由判定逻辑见 §3 FP1）。
- AC1.6 Team Builder 全程输出 trace：组建过程（拆解 JSON、每个 agent 创建、graph 注册）作为 root span 子节点写入 trace（复用 chat_trace_nodes，node_type='team_build'）。

### 功能点 2：Graph 节点挂载 Agent 定义 + 目标锚点 — P0

**描述**：扩展 `GraphNode` 类型与 `graph-runner.runAgentNode`，让 agent 节点不再是"只跑一个 prompt 的黑盒"，而是按 Team Builder 自主设计的 systemPrompt/engine/skill/mcp 运行，且每轮重申目标锚点。

**验收标准**：
- AC2.1 `GraphNode` 新增可选字段：`agentDefId?: string`（引用 `agent_definitions.id`）、`goalAnchor?: string`（原始目标+验收标准文本）、`agentMember?: string`（成员名，便于人读）。不破坏既有无 `agentDefId` 的图定义（向后兼容：缺失时退化为旧行为，prompt 直接跑）。
- AC2.2 `runAgentNode`：当 `node.agentDefId` 存在时，调既有 `loadGroupAgentDefinition(agentDefId, ownerUserId)` 加载 agent 定义，经 `ContainerInput.agentDefinition` 注入 agent-runner；agent-runner 既有逻辑（`<agent-definition>` 标签注入 systemPrompt、按 `agent_mounts` 过滤 skill/mcp、按 `engine` 选引擎）自动生效——**不改 agent-runner**。
- AC2.3 `runAgentNode`：节点 prompt 头部前置 `goalAnchor`（`【团队目标】…【验收标准】…【你的角色与交付物】…`），确保每轮执行都重申目标。goalAnchor 缺失时退化为旧行为。
- AC2.4 agent 节点产出按既有启发式写入 `node_<id>_output` state 字段供下游读取；下游 gate 节点可读该字段做断言。

### 功能点 3：行为证据验收 Gate 节点 — P0

**描述**：扩展 `GraphNode` gate 节点与 `runGateNode`，验收不再只靠 LLM 自述，而是以**行为证据断言**（harness-eval 风格）+ 可选 shell 检查命令为主、LLM 评审为辅。

**验收标准**：
- AC3.1 `GraphNode` gate 新增可选字段：`assertions?: EvalAssertion[]`、`shellCheck?: string`、`upstreamNodeId?: string`（断言作用于哪个上游 agent 的产出，默认最近前驱）。
- AC3.2 `runGateNode`：先跑 `shellCheck`（若有，复用 `script-runner.ts exec()`，超时 60s，1MB 输出缓冲）——退出码非 0 即 gate failed；再对上游产出文本跑 `assertions`（复用 `harness-eval.ts:157 scoreAssertion` 纯函数）；最后才调 LLM 评审（既有 `lightweightSdkQuery + parseReviewResult`）做综合判定。任一行为证据失败 → gate failed，不等 LLM 兜底。
- AC3.3 gate 判定结果（pass/fail + 各断言明细 + shellCheck 输出片段）写入 `graph_node_runs.output_summary` 与 trace，可回溯。
- AC3.4 gate failed 触发 graph 既有 retry（`maxAttempts`+指数退避）；retry 耗尽后 graph status=failed，前端标红，用户可 `rerun` 下游或手动 `resume`。
- AC3.5 当 `assertions` 与 `shellCheck` 均缺失时，退化为既有 LLM-only gate（向后兼容）。

### 功能点 4：节点内子步骤 Trace（全步骤 / 工具调用 / 模型 I/O 可回溯）— P0

**描述**：agent 节点执行时，其内部每一步（turn）、每次工具调用、模型输入输出全部记录 trace 数据库，形成节点内子图（子树），可回溯可追踪。

**验收标准**：
- AC4.1 DB schema 顺延（v52→v53）：`chat_trace_nodes` 新增列 `graph_run_id TEXT`、`graph_node_id TEXT`、`tool_name TEXT`、`tool_use_id TEXT`（与 `loop_trace_nodes` 对齐）；新增表 `trace_tool_calls`（`id, graph_run_id, graph_node_id, tool_use_id, tool_name, input_json, output_json, started_at, ended_at, status`）存工具调用原始 input/output JSON。
- AC4.2 `runAgentNode` 启动 agent 前，把 `graph_run_id` + `graph_node_id` 经 `ContainerInput`（新增透传字段）传给 agent-runner；agent-runner 既有 `StreamEvent` 流回后端时，`persistTraceNodeFromStreamEvent` 用这两个字段给 trace 节点打标，使节点内 turn/tool 节点的 `parent_node_id` 指向该 agent 节点的 trace root → 形成节点内子树。
- AC4.3 扩展 `chat-trace-persist.ts`：除既有 `traceNode` 摘要外，捕获 StreamEvent 的 `toolInput`/`toolResult`/`rawEvent` 字段，写入 `trace_tool_calls`（按 `tool_use_id` 去重 upsert），实现"工具调用原始 input/output 可回溯"。模型输入输出经既有 `messages` 表（`sdk_message_uuid`/`token_usage`）+ trace 节点 `session_id` 关联可查。
- AC4.4 trace 写入仍先持久化后推进（复用既有 upsert 幂等），不破坏既有 chat trace 行为（无 graph_run_id 的普通 chat trace 继续工作）。
- AC4.5 新增查询 API：`GET /api/graph/runs/:id/nodes/:nodeId/trace` 返回该 agent 节点的子步骤 trace 树（turn 节点 + tool 调用明细），按 `parent_node_id` 还原 span 树。

### 功能点 5：DAG 可视化 + 节点内子图可视化 — P0

**描述**：DAG 任务计算图可视化（既有 `GraphDagView`）+ 新增"点击 agent 节点展开其内部执行步骤子图"。

**验收标准**：
- AC5.1 Team Builder 组建的 GraphDefinition 在 `GraphPage` 用既有 `GraphDagView`（reactflow）正常渲染：agent 节点按成员角色显示标题、gate 节点显示"验收"、边显示依赖；运行态实时高亮当前节点（running 脉冲/completed 绿/failed 红/paused 黄）——复用既有 graph_* 流式事件。
- AC5.2 `GraphNodeDetail` 新增"节点内子图"面板：点击 agent 节点 → 调 `GET /api/graph/runs/:id/nodes/:nodeId/trace` → 渲染该节点的子步骤 span 树（turn/tool 节点，按状态着色）+ 每步的工具调用 input/output（可折叠）+ token/cost。
- AC5.3 Team Builder 组建过程也可视化：root span 下展示 team_build 子节点（拆解 JSON / 每个 agent 创建 / graph 注册），可在 trace 视图回溯"DeepThink 是如何自主组建这个团队的"。
- AC5.4 新增 `web/src/stores/team.ts`（Zustand）：`buildTeam(taskInput)`/`teamRuns`/`subscribeTeamEvents`，模仿 `stores/graph.ts`。
- AC5.5 新增 `web/src/pages/TeamPage.tsx` 或在 `GraphPage` 加"组建团队"入口（textarea 输入复杂任务 → POST /api/team/runs → 跳转该 graph run 详情）。

### 功能点 6：验收闭环循环（发现问题循环执行直到完成）— P0

**描述**：最终 gate（验收）节点用行为证据检查是否完成任务目标；失败则循环重跑上游，直到通过或耗尽预算。

**验收标准**：
- AC6.1 Team Builder 自动在 DAG 末端追加"验收 gate"节点（`assertions` 来自用户 `acceptanceCriteria`，`shellCheck` 可选），作为完成判据。
- AC6.2 验收 gate failed → graph-orchestrator 既有 retry/rerun 重跑上游 agent 节点（带 goalAnchor 重申）；retry 耗尽 → graph status=failed。
- AC6.3 graph status=completed **当且仅当**验收 gate 行为证据通过（不再允许"agent 自述完成即完成"）。
- AC6.4 失败时可手动 `POST /api/graph/runs/:id/nodes/:nodeId/rerun`（既有 AC4.4）重跑指定节点及下游；用户可在 Web 触发。
- AC6.5 循环上限可配（`maxAttempts` 默认 3，graph 级），防自旋。

## 4. MVP（P0）范围明确

**本迭代交付**：
- FP1 Team Builder 元 Agent（自主拆解+创建 agent+组装 graph+启动，含 /api/team/runs + /team 命令 + Supervisor 路由 Hook）
- FP2 graph 节点挂 agentDefId + goalAnchor
- FP3 行为证据 gate（assertions + shellCheck，复用 harness-eval）
- FP4 节点内子步骤 trace（DB v53 + trace_tool_calls 表 + persist 扩展 + 查询 API）
- FP5 DAG 可视化 + 节点内子图可视化 + TeamPage/stores
- FP6 验收闭环循环

**本迭代不交付（P1+）**：
- 运行中动态重组团队（re-plan mid-execution）— P1
- human 节点完整 HITL 飞书审批（既有 graph-engineering P1 占位）— P1
- 并行节点文件级工作区隔离（既有 graph-engineering P1）— P1
- 团队结构自进化学习（跨 run 复用最优团队模板）— P2
- 设计态拖拽建图 — P2
- 循环节点 / 动态子图 — P2/P3

## 5. 测试用例（P0 子集）

| ID | 用例 | 验收映射 |
|----|------|---------|
| TC1 | 给 Team Builder 一个复杂任务（"调研X并实现Y原型并写测试"），`buildTeam` 产出合法团队计划 JSON（含 ≥2 members、≥3 nodes、无环、引用 member 存在） | AC1.1 |
| TC2 | 构造非法团队计划 JSON（缺 members / 有环 / 引用不存在的 member），`buildTeam` 拒绝且无副作用（未创建 agent_definition、未注册 graph） | AC1.1 |
| TC3 | 合法任务经 `buildTeam` 后，DB 出现对应 `agent_definitions` 行（每 member 一行）+ `agent_mounts` 行（按 skills/mcpServers）；重复 build 同 teamName 复用不重复创建 | AC1.2 |
| TC4 | 合法任务经 `buildTeam` 后，DB 出现 `graph_definitions` 行 + `graph_runs` 行（status=pending/running）；agent 节点带 `agentDefId`+`goalAnchor` | AC1.3/1.4 |
| TC5 | `POST /api/team/runs`（带 goalText+acceptanceCriteria）返回 200 + graphRunId；未登录返回 401 | AC1.5 |
| TC6 | agent 节点带 `agentDefId` 执行时，agent-runner 收到 `ContainerInput.agentDefinition` 且 systemPrompt 来自该 agent_definition；goalAnchor 出现在 prompt 头部 | AC2.2/2.3 |
| TC7 | 无 `agentDefId` 的旧图定义仍可跑（向后兼容） | AC2.1 |
| TC8 | gate 节点带 `assertions:[{kind:'contains',value:'测试通过'}]`，上游产出含"测试通过"→gate completed；不含→failed | AC3.2 |
| TC9 | gate 节点带 `shellCheck:'make test'`，退出码 0→通过；非 0→failed 且 output_summary 含命令输出片段 | AC3.2/3.3 |
| TC10 | gate 同时有 shellCheck 与 assertions，shellCheck 失败时直接 failed，不跑 LLM 评审兜底 | AC3.2 |
| TC11 | 无 assertions/shellCheck 的旧 gate 退化为 LLM-only 评审，行为不变 | AC3.5 |
| TC12 | agent 节点执行后，`chat_trace_nodes` 出现该节点 trace 子树（`graph_run_id`+`graph_node_id` 非空，`parent_node_id` 链通向 agent 节点 root） | AC4.2 |
| TC13 | agent 执行中发生工具调用，`trace_tool_calls` 出现对应行（tool_name/input_json/output_json 非空，按 tool_use_id 去重） | AC4.3 |
| TC14 | 无 graph_run_id 的普通 chat trace 仍正常写入（向后兼容） | AC4.4 |
| TC15 | `GET /api/graph/runs/:id/nodes/:nodeId/trace` 返回该节点子步骤 span 树 JSON | AC4.5 |
| TC16 | `GraphPage` 渲染 Team 组建的 graph：agent 节点显示成员角色、gate 显示"验收"、运行态实时高亮 | AC5.1 |
| TC17 | 点击 agent 节点 → "节点内子图"面板渲染子步骤 span 树 + 工具调用 input/output 可折叠 | AC5.2 |
| TC18 | 验收 gate 行为证据通过 → graph status=completed；失败 → retry 上游；retry 耗尽 → failed | AC6.2/6.3 |
| TC19 | 浏览器 UI（admin/Test12345!）端到端：登录→TeamPage 输入复杂任务→看到 DAG 实时构建与执行→点击节点看子图→验收通过标绿 | AC1.5/5.1/5.2/6.3 |
| TC20 | 进程崩溃重启后 `bootRecoverGraphRuns` 把 stale running 翻 failed，可 resume 续跑（既有能力不回归） | AC6.4 |

## 6. 风险与陷阱清单

- ❌ **Team Builder LLM 产出非法 JSON**：`sdkQuery` 单轮可能产出不合法/不完整团队计划。缓解：严格 schema 校验（zod）+ 失败重试 1 次 + 降级到"单 agent 自主完成"模板。
- ❌ **自主创建的 agent systemPrompt 注入越权**：Team Builder 设计的 systemPrompt 可能尝试绕过安全规则。缓解：agent-runner 既有 `security-rules.md`/`mount-security.ts`/`im-safety` 始终生效（systemPrompt 经 `<agent-definition>` 标签 append，不替换安全段）；Team Builder 不赋予提权工具。
- ❌ **shellCheck 命令注入/破坏性**：gate 的 `shellCheck` 在 owner 工作区执行，可能 `rm -rf`。缓解：复用 `script-runner.ts` 沙箱（超时+1MB 缓冲），并套用既有 Bash 安全守则（红线操作拦截）；P0 限定 shellCheck 仅由 Team Builder 从受限模板生成或用户显式确认。
- ❌ **trace 数据爆炸**：全量工具 input/output JSON 可能极大。缓解：`trace_tool_calls` 单条 input/output 截断（如 64KB）+ TTL 清理 + 成功 span 可采样（AC 借鉴 graph-engineering §13）。
- ❌ **graph 节点并发写冲突**：Team 组建的并行 agent 节点同 folder 写。缓解：既有 graph-engineering P0 约定"节点声明 DISJOINT artifacts"，P0 跑 owner folder，文件级隔离 P1；Team Builder 尽量串行/无写冲突依赖。
- ❌ **目标锚点被 LLM 忽略**：goalAnchor 写在 prompt 头部但仍可能被长输出淹没。缓解：goalAnchor 同时作为最终 gate 的 assertions 依据，行为证据兜底。
- ❌ **Schema 迁移破坏既有 DB**：v52→v53 加列/加表。缓解：`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` IF NOT EXISTS 模式（既有 db.ts 迁移惯例），不动既有列。

## 7. 非目标（明确不做）

- 不替换 SubAgent/Conversation Agent/Supervisor 三套既有机制。
- 不改 graph-scheduler/graph-orchestrator 核心调度（仅 `runAgentNode`/`runGateNode`/trace 桥接扩展）。
- 不改 agent-runner 内核（仅经 `ContainerInput` 透传 `agentDefinition`/`graph_run_id`/`graph_node_id`，复用既有注入点）。
- 不做运行中动态 re-plan（P1）、团队自进化（P2）、设计态拖拽（P2）、循环节点（P2）。
- 不引入外部图数据库或 trace 后端（继续 SQLite）。

## 8. 里程碑

| 里程碑 | 内容 | 对应功能点 |
|--------|------|-----------|
| M1 | DB schema v53 + trace_tool_calls 表 + chat_trace_nodes 加列 + db.ts CRUD | FP4 基座 |
| M2 | GraphNode 扩展（agentDefId/goalAnchor/agentMember/assertions/shellCheck） + graph-runner runAgentNode/runGateNode 扩展 | FP2/FP3 |
| M3 | trace 持久化扩展（chat-trace-persist 捕获工具 I/O） + ContainerInput 透传 + trace 查询 API | FP4 |
| M4 | Team Builder 元 Agent（拆解+创建 agent+组装 graph+启动）+ /api/team/runs + /team 命令 + Supervisor Hook | FP1 |
| M5 | 前端 TeamPage + stores/team.ts + GraphNodeDetail 子图面板 + 组建过程可视化 | FP5 |
| M6 | 验收闭环（末端 gate + retry 循环）+ 浏览器 UI E2E（TC19） | FP6 |
