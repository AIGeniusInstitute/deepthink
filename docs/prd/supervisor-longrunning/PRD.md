# PRD — DeepThink 长驻 Supervisor Agent（自主监督闭环）

> 范式：主对话 Agent 单次执行 → Supervisor 长驻监督 + 自恢复 + 证据回喂
> 公理：监督必须**可记录、可恢复、证据驱动**；监督结论必须**回喂**主对话 Agent 驱动任务收敛。
> 仓库：`~/deepthink`，分支 `feat/supervisor-longrunning`，基线 `origin/main` @ `eec637f`。
> 作者：DeepThink AI Coder
> 日期：2026-07-20

---

## 1. 背景

DeepThink 已有两套相关但**不满足本次需求**的子系统：

1. **`supervisor.ts`（81 行）**：无状态 1-turn 意图解析器，在主 Agent 运行**前**一次性调用，输出 `clarify`/`delegate`/`auto`。不支持长驻、不支持监督目标/周期/策略、不持久化决策、无 review/retry、崩溃无恢复——是个 MVP 占位。
2. **`loop-orchestrator.ts`（909 行）**：真正的长跑循环（goal/loop/schedule/proactive/adaptive/skill_evolution），有 `loop_runs`/`loop_iterations`/`loop_trace_nodes` 持久化、review/iterate 状态机、`storeResultAndNotify` 结论回喂。但它是"被监督的主 Agent"本身，**不是监督者**；且崩溃后 `running` 状态卡死，无 resume。

用户要的是**第三种**：一个**长驻监督者**，对主对话 Agent（含 loop 编排器）的整个任务生命周期进行**周期性监督**，自主定义监督目标/周期/策略，可视化每次监督日志与决策证据，结论**回喂**驱动主 Agent 收敛，且**全程长驻、异常自恢复、始终在线**直至任务交付。

## 2. 目标 / 非目标

### 目标
1. 主对话 Agent 支持自定义创建一个 Supervisor Agent（每个会话/群组可创建一个长驻 Supervisor）。
2. Supervisor 自主定义：**监督目标**（goal）、**监督周期**（period）、**监督策略**（strategy，本期细化 3 种）。
3. 一个**开关**：开启 / 关闭 Supervisor（保留并复用现有 per-group toggle 思路，迁移到 DB + 扩展为完整会话配置）。
4. **可视化**：每次监督日志（check 记录）、**决策证据**（evidence items）、监督结论（conclusion）的时间线可视化，并**自动回喂**主对话 Agent。
5. **长驻 + 自恢复**：Supervisor 会话在整个任务生命周期内常驻；进程崩溃/异常中断后，重启即自主恢复未完成的监督会话，确保监督者**始终在线**，最终交付任务。

### 非目标（本期不做）
- 不重构现有 `supervisor.ts` 的前置意图解析（保留 MVP，新子系统独立）。
- 不重写 `loop-orchestrator.ts`（只读其状态作为监督证据来源）。
- 不实现 Supervisor 自身的"自进化 harness"（复用 harness 留接口，不连真实 meta-loop）。
- 不做多租户 Supervisor 模板市场（仅 per-group 会话级）。

## 3. 核心设计决策（Think Before Coding）

### D1 — 监督模式：周期性观察者（periodic observer），非逐消息门控
两种可能模型：
- **A. 周期性观察者**：Supervisor 按配置周期（或事件触发）醒来，读取主 Agent 近期会话 + loop 状态 + trace → LLM 评估 → 产出决策 → 按需回喂。**选定此模型**——匹配用户"监督周期"语义，与主 Agent 解耦，长驻可恢复。
- B. 逐消息门控：拦截每条主 Agent 消息。过于侵入，不符合"周期"语义。**否决**。

### D2 — 复用既有持久化与恢复范式，不新造轮子
- DB 表设计仿 `loop_runs` + `loop_iterations`。
- 崩溃恢复三段式，照搬 `task-scheduler.ts` / `index.ts` 既有先例：①内存 dedup set + 启动时 stale `running` 行翻转 ②`next_check_at` 落库驱动 tick ③ watchdog 启动即恢复 `active` 会话。
- 回喂通道复用 `runGroupModeTask` 范式：`storePromptMessage`（sourceKind='supervisor'）+ `queue.enqueueMessageCheck`，使结论可见且驱动下一次主 Agent 运行。

### D3 — 监督策略（strategy）本期细化 3 种
策略 = 触发模式 + 决策策略的组合：

| strategy | 触发模式 | 适用场景 |
|----------|---------|----------|
| `periodic` | 每 `period_ms` 唤醒一次（时间驱动） | 通用：定期巡检长跑任务 |
| `on_iteration` | 订阅绑定 loop_run 的每次 iteration 完成事件（事件驱动） | 监督 loop 编排任务：每轮 review 后评估 |
| `hybrid` | periodic + 主 Agent 每次 turn 结束事件，二者取早 | 高敏感：既要周期兜底又要即时反应 |

**决策策略**（LLM 评估输出，所有 strategy 共用）：
```json
{
  "action": "continue|redirect|escalate|complete|abort",
  "conclusion": "一句话结论",
  "evidence": [{"type":"message|test|file|loop_status","ref":"...","detail":"..."}],
  "next_action_hint": "给主 Agent 的下一步指令（redirect 时必填）",
  "confidence": 0.0-1.0
}
```
- `continue`：仅记录证据，不打扰主 Agent。
- `redirect`：把 `next_action_hint` 作为 supervisor 消息回喂主 Agent。
- `escalate`：向用户提问（storePromptMessage，等用户回答）。
- `complete`：判定目标达成，关闭会话，通知用户。
- `abort`：判定不可恢复，关闭会话，通知用户人工介入。

### D4 — 长驻与自恢复机制
- Supervisor tick loop 是后端进程内的常驻循环（仿 `startSchedulerLoop`），进程在则监督在。
- 后端进程本身由 `desktop/src/backend-supervisor.ts`（已存在）保活重启——链路：BackendSupervisor 保活后端 → 后端 tick loop 保活 Supervisor 会话。
- 每次 check 写一条 `status='running'` 的 `supervisor_decisions` 行作为心跳；正常完成翻 `completed`，异常崩溃则该行留 `running`，启动时 `cleanupStaleSupervisorChecks()` 翻 `error`。
- `supervisor_sessions.next_check_at` 落库驱动调度；watchdog 启动时扫描 `status='active' AND next_check_at <= now` 的会话立即恢复。
- 心跳超时检测：若 `now - last_check_at > period_ms * 3` 且 `status='active'`，标 `degraded` 并强制恢复一次 check。
- 连续失败熔断：连续 5 次 check error → `status='failed'`，通知用户。

## 4. 功能需求

### F1 — Supervisor 会话生命周期
- **F1.1** 每个 group/chat 可创建一个 Supervisor 会话（同 group 同时只允许一个 `active` 会话；新建前若有 active 则拒绝并提示先关闭旧的）。
- **F1.2** 创建时必填：`goal`（监督目标）、`success_criteria`（达成判据）；可选：`strategy`（默认 `periodic`）、`period_ms`（默认 300000=5min，区间 [60000, 3600000]）、`max_checks`（默认 100，硬上限 500）、`bound_loop_run_id`（绑定某个 loop_run，用于 `on_iteration` 策略）。
- **F1.3** 会话 `status`：`active` / `paused` / `completed` / `failed` / `aborted`。
- **F1.4** 开关：`PATCH /api/supervisor/:id {enabled: bool}` —— `false` → `paused`（停止调度但保留状态），`true` → `active`（恢复调度，重算 `next_check_at`）。

### F2 — 监督检查（supervision check）
- **F2.1** 每次 check 采集证据：主 Agent 近 30 条消息（`buildRecentConversationHistoryContext`）、绑定 loop_run 的当前 `status`/`current_turn`/`max_turns`/最近 iteration 的 `review_result`+`review_reason`、trace 节点摘要。
- **F2.2** 调用 LLM（`SUPERVISOR_MODEL` 或默认模型，`maxTurns:1`，无工具）按 D3 决策策略输出严格 JSON。
- **F2.3** 落库一条 `supervisor_decisions` 行（含 evidence_json、conclusion、action、trace_summary）。
- **F2.4** 按 action 执行副作用：
  - `redirect`/`escalate` → `storePromptMessage`（sourceKind='supervisor'，sender='__supervisor__'）+ `queue.enqueueMessageCheck`，回喂主 Agent。
  - `complete` → 会话 `status='completed'`，发一条 supervisor 完成通知。
  - `abort` → 会话 `status='aborted'`，发人工介入通知。
  - `continue` → 仅记录。
- **F2.5** 推进 `next_check_at = now + period_ms`（periodic/hybrid）；`on_iteration` 策略等待事件，但设兜底 `next_check_at = now + period_ms*2` 防事件丢失。

### F3 — 事件订阅（on_iteration / hybrid）
- **F3.1** 监听 `loop_review_result` / `loop_end` StreamEvent；若事件的 `loop_run_id` 绑定到某 active supervisor 会话，触发一次 check。
- **F3.2** 去抖：同一会话 5s 内仅触发一次事件驱动 check。

### F4 — 长驻与自恢复
- **F4.1** `startSupervisorLoop()` 在后端 boot 时启动（`index.ts` main() 内，紧跟 `startSchedulerLoop`）。
- **F4.2** boot 恢复：`cleanupStaleSupervisorChecks()` 翻 stale `running` decisions → `error`；扫描 `status='active'` 会话，若 `next_check_at <= now` 则立即排一次 check。
- **F4.3** 心跳超时检测：tick 内对每个 active 会话检查 `now - last_check_at > period_ms*3` → 标 `degraded` 并强制 check。
- **F4.4** 连续失败熔断：会话累计 `consecutive_errors >= 5` → `status='failed'`，notify。
- **F4.5** shutdown：`stopSupervisorLoop()` 清 tick 定时器与内存 dedup set。

### F5 — Web API
- `POST   /api/supervisor`            创建会话
- `GET    /api/supervisor`             列表（按 group 可见性过滤）
- `GET    /api/supervisor/:id`         会话详情 + 最近 decisions
- `PATCH  /api/supervisor/:id`         更新（enabled / goal / period / strategy）
- `DELETE /api/supervisor/:id`         删除（active 会话需先 pause 或 force）
- `POST   /api/supervisor/:id/check`   手动触发一次 check
- `GET    /api/supervisor/:id/decisions` 决策时间线（分页）

### F6 — 前端可视化
- **F6.1** `SupervisorPage`：会话列表（状态 chip、goal、策略、周期、进度 current_checks/max_checks）+ 选中会话的决策时间线。
- **F6.2** 决策卡片：action 图标、conclusion、evidence 列表（type+ref+detail，可展开）、confidence、时间、trace_summary。
- **F6.3** 创建对话框：goal、success_criteria、strategy、period、可选 bound_loop_run_id。
- **F6.4** 顶部导航加入 "Supervisor" 入口；现有 `SupervisorToggle`（chat header）扩展为"打开 Supervisor 面板/快速创建"。
- **F6.5** 5s 轮询刷新 active 会话的 decisions（仿 `InlineLoopCard`）。

## 5. 验收标准

| ID | 验收点 | 验证手段 |
|----|--------|---------|
| AC1 | `POST /api/supervisor` 可创建会话，返回完整会话对象，`status='active'`，`next_check_at` 已算 | 单测 + curl |
| AC2 | 同 group 已有 active 会话时再创建返回 409 | 单测 |
| AC3 | periodic 策略下，到达 `next_check_at` 后 tick 触发一次 check，生成一条 `completed` decision，`next_check_at` 推进 | 单测（mock LLM） |
| AC4 | `redirect` 决策会向主 Agent 回喂一条 sourceKind='supervisor' 消息并触发 enqueueMessageCheck | 单测（mock queue） |
| AC5 | `complete` 决策将会话置 `completed` 并停止后续调度 | 单测 |
| AC6 | `cleanupStaleSupervisorChecks` 能把 stale `running` decision 翻 `error` | 单测 |
| AC7 | boot 恢复：`status='active'` 且 `next_check_at<=now` 的会话在 `startSupervisorLoop` 后被排入 check | 单测 |
| AC8 | 心跳超时（`now - last_check_at > period*3`）触发 `degraded` 标记 + 强制 check | 单测 |
| AC9 | 连续 5 次 check error → `status='failed'` | 单测 |
| AC10 | `on_iteration` 策略下，收到绑定 loop_run 的 `loop_review_result` 事件触发 check（5s 去抖） | 单测 |
| AC11 | `PATCH enabled=false` → `paused`，tick 不再调度；`enabled=true` → `active` 恢复 | 单测 |
| AC12 | `make typecheck` 全绿 | 编译 |
| AC13 | `make test` 通过（新增单测全绿，无回归） | 测试 |
| AC14 | 前端 `SupervisorPage` 渲染会话列表 + 决策时间线，创建对话框可创建 | 手动 + 截图 |

## 6. 测试用例（对应 AC）

详见 `docs/test_report/supervisor-longrunning/REPORT.md`，关键单测：
- `supervisor-session.test.ts`：创建 / 重复创建 409 / toggle / 状态机。
- `supervisor-check.test.ts`：periodic check 推进 / redirect 回喂 / complete 收尾 / 连续失败熔断。
- `supervisor-recovery.test.ts`：stale running 翻 error / boot 恢复 active / 心跳超时 degraded。
- `supervisor-event.test.ts`：on_iteration 事件触发 + 去抖。
- `supervisor-decision-parser.test.ts`：LLM JSON 解析（仿现有 `parseDecision` 风格）。

## 7. 交付物清单

- 后端：`src/supervisor-agent.ts`、`src/supervisor-config.ts`（扩展）、`src/routes/supervisor.ts`、`src/db.ts`（加表）、`src/index.ts`（boot wiring）、`src/types.ts`（类型）。
- 前端：`web/src/pages/SupervisorPage.tsx`、`web/src/stores/supervisor.ts`、`web/src/api/supervisor.ts`、`web/src/components/supervisor/*`、导航接线。
- 文档：本 PRD、技术方案、任务状态、测试报告。
