# DeepThink 长程任务自主 Loop Engineering

> 需求 ID: loop-engineering
> 分支: `feat/loop-engineering`（基于 main）
> 创建日期: 2026-07-08
> 作者: Code Agent

## 一、需求背景

DeepThink 当前已具备完整的会话执行（`container-runner` + `agent-runner`）、定时任务调度（`task-scheduler`）、流式输出（`StreamEvent`）、子代理（`agents` 表 + `code-reviewer`/`web-researcher`）等基础设施。但缺失**长程自主任务循环**能力：

1. 用户发起一个目标后，Agent 无法自主多轮迭代直到达成可验证的成功标准
2. 没有 `/loop`、`/schedule`、`/goal` 等斜杠命令，用户只能手工逐轮驱动
3. 任务执行过程没有 DAG 可视化，无法回溯每个节点的 input/output/token
4. 缺少双重 Agent 评审机制，单次产出质量靠 Agent 自我判断
5. Token 消耗没有按循环聚合的视角，长链路任务成本不可控

本需求在 DeepThink 内原生实现 Loop Engineering 能力，使 Agent 能够在结构化的循环框架下自主完成复杂任务，同时保持质量与成本可控。

## 二、目标（Goal-Driven）

建立 DeepThink 原生的 Loop Engineering 子系统，覆盖 4 种循环类型 + DAG 可视化 + 双重评审 + Token 统计，让用户可一句话发起长程任务并实时观察执行 DAG。

### 成功标准（可验证）

#### 2.1 4 种循环命令

1. ✅ `/goal <目标描述> [max_turns=N]` 斜杠命令 — 启动目标循环，最多 N 轮（默认 5），每轮后由"评审 Agent"检查成功标准是否达成，达成则退出
2. ✅ `/loop <interval> <任务描述>` 斜杠命令 — 启动时间循环，按间隔重复执行（如 `/loop 5m 检查 CI 失败并修复`），直到 `/cancel` 或任务完成
3. ✅ `/schedule <cron> <任务描述>` 斜杠命令 — 启动云端调度循环（基于现有 task-scheduler），持久化运行
4. ✅ `/proactive <cron> <goal> [workflow=parallel]` 斜杠命令 — 启动主动循环，组合 schedule + goal + 子代理并行工作流

#### 2.2 Loop Orchestrator

5. ✅ 新增 `src/loop-orchestrator.ts` — 管理单次 goal 执行的有限状态机：`pending → running → reviewing → iterating → completed/failed/cancelled`
6. ✅ 每轮调用 `runContainerAgent`/`runHostAgent` 执行一回合，将 Agent 输出传给评审 Agent 判定是否达标
7. ✅ 未达标时自动注入"继续改进"提示，进入下一轮；达标或达到 max_turns 时退出
8. ✅ 支持用户中途 `/cancel <loop_id>` 取消

#### 2.3 DAG 可视化与 Trace 持久化

9. ✅ 新增 `loop_runs` 表：`id, owner_user_id, group_folder, chat_jid, kind ('goal'|'loop'|'schedule'|'proactive'), goal_text, success_criteria, max_turns, current_turn, status, started_at, ended_at, total_tokens, total_cost_usd, root_prompt`
10. ✅ 新增 `loop_iterations` 表：`id (auto), loop_run_id, turn_index, status, agent_session_id, started_at, ended_at, input_tokens, output_tokens, cost_usd, review_result, review_reason`
11. ✅ 新增 `loop_trace_nodes` 表：`id (auto), loop_run_id, iteration_id, node_type ('turn'|'tool'|'review'|'goal_check'|'skill'), parent_node_id, tool_name, tool_use_id, title, input_summary, output_summary, started_at, ended_at, tokens, status`
12. ✅ 扩展 `shared/stream-event.ts` 新增事件：`loop_start`、`loop_iteration_start`、`loop_iteration_end`、`loop_goal_check`、`loop_review_result`、`loop_end`
13. ✅ `agent-runner` 在 loop 模式下发射上述事件，主进程通过 `broadcastStreamEvent` 推送到 Web
14. ✅ Web 前端新增 `LoopDagPanel.tsx` 组件 — 基于 `loop_trace_nodes` 实时渲染 DAG，节点可点击展开 Trace 详情（input/output/tokens/耗时）

#### 2.4 双重 Agent 评审

15. ✅ Loop Orchestrator 每轮结束后自动调用 `code-reviewer` SubAgent，传入"成功标准 + Agent 产出"
16. ✅ 评审结果写入 `loop_iterations.review_result`（`pass`/`fail`/`needs_improvement`）+ `review_reason`
17. ✅ 评审未通过时，将 `review_reason` 作为下一轮的额外 user message 注入

#### 2.5 Token 消耗管理

18. ✅ `loop_runs` 聚合每次循环的总 token 与成本（基于现有 `usage_records` 表）
19. ✅ 新增 `GET /api/loops` 路由 — 列出当前用户的 loop_runs（分页、按 status/kind 过滤）
20. ✅ 新增 `GET /api/loops/:id` 路由 — 返回 loop_run 详情 + 所有 iterations + trace 节点
21. ✅ 新增 `POST /api/loops/:id/cancel` 路由 — 取消运行中的 loop
22. ✅ 新增 `GET /api/loops/:id/usage` 路由 — 返回该 loop 的 token 消耗按 iteration 聚合

#### 2.6 文档与测试

23. ✅ PRD（本文档）+ 技术方案 + 测试报告写入 `docs/{prd,tech_solution,test_report}/loop-engineering/`
24. ✅ `make typecheck` 通过
25. ✅ `npx vitest run` 新增单元测试全部通过，不引入现有用例的新失败
26. ✅ Web E2E 手动验证：发起一个 `/goal` 任务，截图 DAG 渲染 + 节点 Trace 展开

## 三、非目标（Non-Goals）

明确**不在本次 MVP 范围**的能力，留作 Phase 2：

- ❌ **自适应循环**：根据历史性能动态调整 max_turns / 模型选择 / 时间间隔
- ❌ **技能自进化循环**：失败后自动更新 `SKILL.md` 的验证步骤
- ❌ **多阶段目标循环**：将大任务分解为多个子 goal 串联执行
- ❌ **对抗性并行工作树**：3 个并行 worktree 探索不同方案
- ❌ **/workflows 命令**：展示每个子 Agent 的 token 使用（已有 `usage_records` 聚合替代）
- ❌ **/usage 命令**（IM 内）：改由 Web `/usage` 页面承担

## 四、范围边界与约束

1. **循环引擎自研**：不依赖外部 Claude Code CLI 的 `/goal`/`/loop` 命令，完全基于 DeepThink 内的 SDK `query()` + `task-scheduler`
2. **时间循环复用 task-scheduler**：`/loop` 和 `/schedule` 都落到 `scheduled_tasks` 表，通过新增 `loop_kind` 字段区分
3. **目标循环新表**：`/goal` 和 `/proactive` 走新建的 `loop_runs` 表，不污染 `scheduled_tasks`
4. **评审 Agent 复用**：直接调用内置 `code-reviewer` SubAgent，不新建评审 Agent
5. **DAG 渲染基于现有 traceEvents 扩展**：不引入新的可视化库，复用 `StreamingDisplay.tsx` 的 Mermaid/React 节点渲染能力
6. **数据库 schema 升级到 v41**：新增 3 张表 + `scheduled_tasks` 增加 `loop_kind` 列
7. **不修改现有消息流**：loop 产生的消息依然落到 `messages` 表，通过 `loop_run_id` 关联

## 五、用户故事

### 5.1 目标循环（Goal-based）

> 作为开发者，我希望一句话发起"把首页 Lighthouse 分提到 90"，Agent 自主迭代直到达成或 5 轮后停止，每轮有评审，整个过程在 Web 看得见 DAG。

**输入**：`/goal 将首页 Lighthouse 分提到 90 分以上 max_turns=5`
**输出**：
- 创建 `loop_runs` 记录（kind=goal, max_turns=5）
- 进入循环，每轮调用 Agent 执行 + 评审
- Web 实时渲染 DAG 节点（turn → tools → review → goal_check）
- 达成或 5 轮后结束，输出最终结果 + token 总消耗

### 5.2 时间循环（Time-based /loop）

> 作为开发者，我希望每 5 分钟检查 PR 评审意见并修复 CI 失败，直到我取消。

**输入**：`/loop 5m 检查 PR 评审意见，处理 CI 失败`
**输出**：
- 落到 `scheduled_tasks` 表（loop_kind=loop, schedule_type=interval, interval=300000）
- 每 5 分钟触发一次 Agent 执行
- Web 在 Tasks 页面展示，在 Loops 页面展示对应的 loop_run 记录
- `/cancel <loop_id>` 取消

### 5.3 时间循环（Time-based /schedule）

> 作为开发者，我希望每天早上 9 点总结昨日 Slack 消息，即使我电脑关机。

**输入**：`/schedule 0 9 * * * 总结昨日 Slack 消息`
**输出**：落到 `scheduled_tasks`（loop_kind=schedule, schedule_type=cron），复用现有调度

### 5.4 主动循环（Proactive）

> 作为开发者，我希望每小时检查 Bug 报告频道，每个报告都分类、修复、评审。

**输入**：`/proactive 0 * * * * 处理 project-feedback 频道的 Bug 报告 workflow=parallel`
**输出**：
- 落到 `loop_runs`（kind=proactive）+ `scheduled_tasks`（关联 loop_run_id）
- 每小时触发：读取新报告 → 对每个报告启动并行子 Agent（分类/修复/评审）→ 汇总
- DAG 展示主循环 + 每个报告的子分支

## 六、验收用例

| 用例 | 步骤 | 期望 |
|---|---|---|
| UC1 | `/goal 修复 README 错字 max_turns=2` | 创建 loop_run，2 轮内完成，DAG 可见 |
| UC2 | `/loop 1m echo heartbeat` | 创建 scheduled_task，1 分钟后首次执行 |
| UC3 | `/schedule 0 9 * * * daily report` | 创建 scheduled_task，next_run 为明日 9:00 |
| UC4 | `/cancel <loop_id>` | loop_run 状态变 cancelled，停止后续执行 |
| UC5 | Web 访问 `/loops` 页面 | 看到所有 loop_run 列表，状态/类型/耗时/token |
| UC6 | 点击 DAG 节点 | 弹出 Trace 详情面板，展示 input/output/tokens |
| UC7 | 评审 Agent 返回 fail | 下一轮自动注入 review_reason |
| UC8 | `make typecheck` | 无 TS 错误 |
| UC9 | `npx vitest run` | 新增测试全通过，现有测试不破坏 |

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| Loop Orchestrator 状态机复杂，易出 bug | 先写单元测试覆盖所有状态转移 |
| DAG 数据量大时前端卡顿 | 限制单 loop 的 trace 节点数（默认 500），超出截断 + 提示 |
| 评审 Agent 误判导致死循环 | max_turns 硬上限 10，达到强制退出 |
| loop_run 表膨胀 | 增加 `cleanupOldLoopRuns` 清理 30 天前的已完成记录 |
| IM 渠道发起的 loop 取消不便 | `/list` 命令展示活跃 loop，`/cancel <id>` 取消 |

## 八、里程碑

| 里程碑 | 产出 |
|---|---|
| M1 | PRD + 技术方案（本文档 + tech_solution/PRD.md） |
| M2 | DB schema v41 + StreamEvent 扩展 |
| M3 | Loop Orchestrator + 4 个斜杠命令 |
| M4 | Web API `/api/loops` + 前端 DAG 组件 |
| M5 | 双重 Agent 评审 + Token 聚合 |
| M6 | vitest 单元测试 + Web E2E 验证 |
| M7 | 测试报告 + 合并 main + push |
