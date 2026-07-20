# PRD：Graph Engineering 能力开发 + Harness/Loop 可观测与断点续跑优化

> 状态：草案 v1，待评审
> 分支：`feat/graph-engineering`
> 作者：DeepThink
> 日期：2026-07-20
> 关联背景：2026-07-18 Peter Steinberger（OpenClaw 创始人）发问 "Are we still talking loops or did we shift to graphs yet?" 引发社区 Loop→Graph 范式讨论。

---

## 0. 背景与动机

DeepThink 已具备成熟的 Harness（版本化+自进化）与 Loop Engineering（4 类 Loop+Supervisor 长驻监督）。但当前控制流本质是**单 Agent 串行循环**：模型在运行时临时决定下一步。当任务变长、含多角色/多路线/相互依赖时，单 Loop 不够：

- **长程任务崩溃即失**：`loop_runs.current_turn` 字段已存在但无人读，Loop 进程崩溃后无法从断点续跑（探查确认是技术债）。
- **并行受限**：`GroupQueue` 并发粒度仅到"会话/folder"，无 DAG 依赖级并行/fan-out/fan-in。
- **执行图只读**：现有 `DagView`(reactflow) 是事后 trace 可视化，rerun 是 client-side 假续跑，无服务端断点续跑。
- **多 Agent 编排分散**：SubAgent/Conversation Agent/Supervisor 三套机制语义重叠，无统一编排层。

业界已大规模转向 Graph Engineering：LangGraph（StateGraph+checkpoint+interrupt）、Temporal（durable execution）、Claude Code「动态工作流」（2026-05-30 上线，编排脚本+并行子 Agent+断点续传）、MiniMax Mavis（代码状态机确定性 runtime）。共识是 **Graph 不取代 Loop，而是在 Loop 之上加编排层**——一个 Graph 可包含多个 Loop。

## 1. 目标

**需求1（Graph Engineering）**：在 DeepThink 中开发 Graph Engineering 能力——长程复杂任务的图式拆解与执行调度、全链路可观测、可视化任务执行图、可中断可重跑、可恢复续跑。

**需求2（Harness/Loop 优化）**：优化现有 Harness 与 Loop Engineering 的执行可视化、可追踪能力，Agent 执行过程可观测、可中断、可断点续跑。

## 2. 设计原则（约束本 PRD 范围）

1. **Graph = Loop 之上的编排层**，不推翻现有 Loop/Harness/Supervisor，只在其上加一层。复用现有调用模式与表结构模板。
2. **最小侵入**：模仿 `loop-orchestrator.ts` + `loop_runs/loop_iterations/loop_trace_nodes` 三件套新建，不动既有 Loop 逻辑（仅补断点续跑一处）。
3. **Simplicity First**：P0 只做"静态声明图 + 节点级 checkpoint + 拓扑调度 + 中断/续跑 + reactflow 可视化"。动态子图、循环节点、Temporal 级 event sourcing 列为 P2/P3。
4. **节点幂等约定**：凡可续跑的节点，代码必须幂等（同 input 重跑产出相同、副作用可重入）。
5. **先持久化后推进**：`graph_node_runs` 落盘后才推进节点状态，避免重蹈 Loop 断点续跑债务。

## 3. 功能点与验收标准

> 标注 P0（MVP 必做）/ P1（高价值紧跟）/ P2（后续）/ P3（远期）

### 功能点 1：图定义模型（Graph Definition）— P0

**描述**：把任务显式建模为有向图：节点（GraphNode）+ 边（GraphEdge）+ 共享状态（GraphState）。节点类型复用现有 `node_type` 枚举并扩展。

**节点类型**：
- `agent`：执行一个 Agent 子任务（复用 `runHostAgent`/`runContainerAgent`，内部仍可是 Loop）
- `gate`：审批/校验节点（复用 `buildReviewerPrompt`+`parseReviewResult`）
- `branch`：条件分支（求值谓词决定激活后继边）
- `join`：汇合点（all-of 策略）
- `human`：human-in-the-loop 接管/审批节点

**边**：普通边（数据依赖）+ 条件边（控制依赖）。

**验收标准**：
- AC1.1 能用 TypeScript 声明一个图定义（节点+边+state schema），序列化为 `manifest.json` 存 `data/graph/definitions/{id}/`。
- AC1.2 图定义支持版本化（`graph_definitions.version` 字段），续跑时锁定版本。
- AC1.3 图定义可导出为 Mermaid，写入 worktree commit 可审计。
- AC1.4 图定义校验：检测环（DAG 无环校验）、悬空边、缺失 state 字段，校验失败给出明确错误。

### 功能点 2：图调度引擎（Graph Orchestrator）— P0

**描述**：新增 `graph-orchestrator.ts`，用拓扑遍历+就绪队列调度图执行，替换 Loop 的 `for i in maxTurns` 为图遍历。

**验收标准**：
- AC2.1 拓扑排序线性化 DAG，保证依赖先跑；含环检测拒绝。
- AC2.2 就绪队列：入度满足的节点入 ready set，worker 拉取执行；节点完成后更新后继入度。
- AC2.3 fan-out 并行：一节点出多条边时后继并行执行；fan-in join 节点等所有前驱完成。
- AC2.4 条件分支：`branch` 节点求值谓词，激活对应后继边。
- AC2.5 节点级 retry policy（次数+退避+超时），与图级"失败跳兜底分支"并存。
- AC2.6 全局并发受 `MAX_CONCURRENT_CONTAINERS`/`MAX_CONCURRENT_HOST_PROCESSES` 约束，不击穿 GroupQueue 全局上限。
- AC2.7 **同 folder 多节点并发写冲突**：通过节点级工作区隔离（每节点独立子目录或文件锁）解决，不破坏 `serializationKeyResolver` 不变量。

### 功能点 3：节点级 Checkpoint 与断点续跑 — P0

**描述**：每节点完成后持久化（state+node_id+output），崩溃后从最近完成节点恢复。

**验收标准**：
- AC3.1 新表 `graph_node_runs`：`status ∈ {pending,running,completed,failed,skipped,paused}`，含 `input_summary/output_summary/tokens/cost/started_at/ended_at/attempt`。
- AC3.2 `graph_runs`：图运行实例，`status/current_node_id/total_tokens/total_cost/version`。
- AC3.3 boot recovery：重启时翻 stale `running`→`failed`，重 arm `pending` 节点，从断点续跑（模仿 `bootRecoverSupervisor`）。
- AC3.4 续跑 API：`POST /api/graph/runs/:id/resume` 从最近 checkpoint 续跑；跳过已 `completed` 节点。
- AC3.5 续跑锁定图定义版本（`version`），版本不一致时拒绝或显式迁移。
- AC3.6 节点幂等性自检：对幂等节点重放，对非幂等节点（含副作用）提示风险并要求确认。

### 功能点 4：可中断、可重跑、可恢复 — P0

**描述**：图执行过程可被中断、重跑、从断点续跑。

**验收标准**：
- AC4.1 `pause`：图在当前节点完成后暂停（不阻塞无依赖并行分支），状态置 `paused`。
- AC4.2 `resume`：从 `paused` 续跑。
- AC4.3 `cancel`：终止整图或某子图，清理半成品（幂等或补偿）。
- AC4.4 `rerun`：从指定节点重跑（`POST /api/graph/runs/:id/nodes/:nodeId/rerun`），重置该节点及下游状态。
- AC4.5 复用现有三层 sentinel（`_interrupt`/`_drain`/`_close`）中断正在跑的节点 query。
- AC4.6 中断/续跑/重跑操作全部入 trace 审计（who/when/what state changed）。

### 功能点 5：全链路可观测 — P1

**描述**：图执行过程的节点状态追踪、执行轨迹、实时进度、失败定位。

**验收标准**：
- AC5.1 每节点记录 `ready/running/succeeded/failed/skipped/paused` + input/output/tokens/cost/duration。
- AC5.2 span 树建模：图运行=root span，节点=child span，节点内 LLM/工具调用=孙 span，父子关系还原 fan-out/fan-in。
- AC5.3 流式推送节点状态变化（复用 `shared/stream-event.ts`，新增 `graph_*` 事件类型，`make sync-types` 同步）。
- AC5.4 失败 span 携带 error+stack+retry 历史，支持"点击节点看输入输出"。
- AC5.5 token/cost 在 span 属性落库（为计费层提供底层数据）。
- AC5.6 trace 采样策略：全量保留失败 span，成功 span 可采样；配 TTL。

### 功能点 6：可视化任务执行图 — P0（运行态）/ P2（设计态）

**描述**：前端可视化图执行，实时高亮当前节点、回放历史、点击看 IO。

**验收标准**：
- AC6.1 复用 `web/src/components/chat/DagView.tsx` 的 reactflow 画布，数据源换为 `graph_runs` 节点树。
- AC6.2 运行态：实时高亮当前节点，已完成节点置灰/着色按状态，失败节点红色，进行中节点脉冲。
- AC6.3 节点详情面板：input/output/tokens/cost/状态/attempt 历史，支持 annotation 编辑。
- AC6.4 历史回放：按时间轴回放图执行过程。
- AC6.5 新增 `GraphPage`+`stores/graph.ts`+`routes/graph.ts`，模仿 LoopsPage 结构。
- AC6.6 节点级 rerun 按钮：从 client-side 假续跑升级为服务端真断点续跑（AC3.4/AC4.4）。
- AC6.7（P2）设计态拖拽建图暂缓，P0 走"代码声明图+自动布局渲染+Mermaid 导出"。

### 功能点 7：Human-in-the-Loop 节点 — P1

**描述**：图中 `human` 节点支持人类审批/接管，对接飞书。

**验收标准**：
- AC7.1 `human` 节点阻塞当前分支（不阻塞无依赖并行分支），等待人类 resolve。
- AC7.2 人类返回值 schema 化（approve/reject/edit/redirect），强制校验。
- AC7.3 审批节点接入飞书卡片（复用 `feishu-cards/`），卡片按钮回写→图续跑。
- AC7.4 超时降级策略（超时自动批准/拒绝/升级）。
- AC7.5 审计：谁/何时/改了什么 state 全部入 trace。
- AC7.6 payload 结构化 HTML 渲染（diff、候选方案对比），复用 HTML 单文件交付规范。

### 功能点 8：Harness/Loop 可观测与断点续跑优化（需求2）— P0

**描述**：优化现有 Harness 与 Loop 的执行可视化、可追踪、可中断、可断点续跑。

**验收标准**：
- AC8.1 **Loop 断点续跑**：`executeGoalLoop` 入口读 `loop_runs.current_turn`，崩溃重启后从该 turn 续跑（补现有技术债）。
- AC8.2 Loop trace 树可视化增强：`LoopDagPanel` 已有，补"当前迭代高亮+迭代间 state diff"。
- AC8.3 Harness 执行过程可观测：Harness meta-loop 的 propose→eval→judge→promote 链路在 `HarnessPage` 实时展示进度。
- AC8.4 统一 trace 模型：把 `loop_trace_nodes`/`chat_trace_nodes`/新增 `graph_node_runs` 纳入统一 span 视图（只读聚合，不迁移原表）。
- AC8.5 中断语义统一文档化：`_interrupt`/`_drain`/`_close` 三层 sentinel 行为写入 `docs/howto/`，对用户明确。
- AC8.6 Agent 执行过程实时可追踪：流式事件已有，补"工具调用链路+token 累计+剩余预算"在 `StreamingDisplay` 展示。

### 功能点 9：把现有 worktree 研发流程建模为内置 Graph 模板 — P1

**描述**：CLAUDE.md 定义的 worktree 流程（PRD→tech_solution→编码→test_report→合并）天然是图，建模为内置模板作为第一个落地场景。

**验收标准**：
- AC9.1 内置 `dev-workflow` 图模板：节点=产物（PRD/tech_solution/code/test_report/merge），边=依赖。
- AC9.2 技术方案阶段支持 fan-out（前端/后端/测试方案并行起草）+ fan-in 汇合。
- AC9.3 test_report 节点为 gate（reviewer 校验测试通过）。
- AC9.4 merge 节点为 human（人类确认合并）。
- AC9.5 该模板可被 `/goal` 或新 `/graph` 命令触发，替代靠 CLAUDE.md 规则约束 Agent 顺序执行。

### 功能点 10：循环节点+预算上限 — P2

**描述**：支持含环图（循环子图），配 `max_iterations/max_tokens/max_cost` 上限。

**验收标准**：
- AC10.1 循环子图识别 SCC，按退出条件终止。
- AC10.2 预算上限：超限自动终止并标记 `failed(budget_exhausted)`。
- AC10.3 循环次数/累计 token 在 span 属性可见。

### 功能点 11：动态子图+Temporal 级 event sourcing — P3

**描述**：运行时动态生成子图、跨进程长任务 durable execution。

**验收标准**：待 P0/P1 落地后评估是否引入 Temporal/Restate，自研覆盖不了的再接。

## 4. MVP（P0）范围明确

**本迭代只交付 P0**：功能点 1,2,3,4,6（运行态）,8。即：
- 图定义模型 + 图调度引擎 + 节点级 checkpoint/断点续跑 + 可中断/重跑/续跑 + reactflow 运行态可视化 + Harness/Loop 断点续跑补债。

**P0 不做**：循环节点、动态子图、设计态拖拽建图、Temporal、HITL 飞书审批（P1 紧跟）、dev-workflow 模板（P1）。

理由：P0 解决"长程任务可调度+可恢复+可观测"的可用性底线，是后续一切的前提；P1 的 HITL 与模板是价值放大器。

## 5. 测试用例（P0 子集）

| ID | 用例 | 验收映射 |
|----|------|---------|
| TC1 | 声明一个 3 节点线性图（A→B→C），跑通，3 节点全 completed | AC2.1/2.2 |
| TC2 | 声明 fan-out 图（A→[B,C]→D join），B/C 并行，D 等齐 | AC2.3 |
| TC3 | branch 节点按 state 字段路由到正确后继 | AC2.4 |
| TC4 | 图含环，校验拒绝并报错 | AC1.4 |
| TC5 | 节点失败，retry policy 重试 N 次后 failed | AC2.5 |
| TC6 | 图跑到节点 B 时进程崩溃，重启后 boot recovery 从 B 续跑 | AC3.3 |
| TC7 | `POST /resume` 从最近 checkpoint 续跑，跳过已完成节点 | AC3.4 |
| TC8 | 续跑时图定义 version 不一致，拒绝并报错 | AC3.5 |
| TC9 | pause 图在当前节点后暂停，resume 续跑 | AC4.1/4.2 |
| TC10 | cancel 整图，半成品清理 | AC4.3 |
| TC11 | rerun 指定节点，该节点及下游重置重跑 | AC4.4 |
| TC12 | 前端 GraphPage 实时高亮当前节点，点击节点看 IO | AC6.2/6.3 |
| TC13 | Loop 跑到第 3 轮崩溃，重启从第 3 轮续跑（补债） | AC8.1 |
| TC14 | 全局并发不超 `MAX_CONCURRENT_CONTAINERS` | AC2.6 |
| TC15 | 同 folder 两节点并发写不冲突（独立工作区/锁） | AC2.7 |
| TC16 | 图定义导出 Mermaid 正确渲染 | AC1.3 |
| TC17 | 非幂等节点续跑前提示风险并要求确认 | AC3.6 |
| TC18 | trace span 树父子关系正确（fan-out/fan-in 还原） | AC5.2 |

## 6. 风险与陷阱清单

- ❌ 节点画太细（一个 LLM 调用一节点）→ 图爆炸。粒度准则：一个节点=一个可交付物或可独立验证阶段。
- ❌ 节点非幂等却续跑 → 副作用重复（重复写文件/发请求）。
- ❌ 续跑不锁版本 → 上游代码/prompt 变更导致重放不一致。
- ❌ 循环子图无预算上限（P2 才做，P0 禁环）→ 自旋烧光预算。
- ❌ 自研 event sourcing 替代 Temporal → P3 再评估，P0 不碰。
- ❌ HITL 节点成单点瓶颈（所有路径汇到一处审批）→ 并行收益归零。
- ❌ trace 全量保留 → 数据爆炸，需采样+TTL。
- ❌ 破坏 `serializationKeyResolver` 不变量 → 同 folder 并发写冲突。

## 7. 非目标（明确不做）

- 不替换现有 SubAgent/Conversation Agent/Supervisor 三套机制（Surgical Changes）。
- 不引入外部图数据库。
- 不做 LangChain/LangGraph 的直接移植（自研，但借鉴其 state+checkpoint 模型）。
- P0 不做设计态拖拽建图、不做循环节点、不做动态子图。

## 8. 里程碑

- M1（P0）：图定义+调度引擎+checkpoint+断点续跑+reactflow 运行态+Loop 断点续跑补债 — 本 PRD 对应迭代。
- M2（P1）：全链路可观测 span 树+HITL 飞书审批+dev-workflow 模板。
- M3（P2）：循环节点+预算上限+设计态建图。
- M4（P3）：动态子图+Temporal 评估。

---

**待评审决策点**（请确认）：
1. P0 范围是否同意？（是否要把 HITL 飞书审批或 dev-workflow 模板提进 P0？）
2. 同 folder 多节点并发策略：选"节点级独立子工作区"（更安全，磁盘开销）还是"节点级文件锁"（更省，需锁实现）？
3. 是否本期就顺带补 Loop 断点续跑（AC8.1），还是单独 issue？（探查建议顺带补，成本低。）
