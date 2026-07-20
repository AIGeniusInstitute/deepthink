# 任务执行状态 — 长驻 Supervisor Agent

> 分支：`feat/supervisor-longrunning`
> 开始：2026-07-20
> 状态：✅ 全部完成，测试全绿

## 执行进度

| 步骤 | 内容 | 状态 |
|------|------|------|
| 0 | worktree `feat/supervisor-longrunning` 基于 `origin/main@eec637f` | ✅ |
| 1 | PRD + 验收标准 + 测试用例 | ✅ `docs/prd/supervisor-longrunning/PRD.md` |
| 2 | 技术方案 | ✅ `docs/tech_solution/supervisor-longrunning/TECH_SOLUTION.md` |
| 3 | 编码实施 | ✅ 见下 |
| 4 | 测试 + 修复循环 | ✅ 21/21 单测通过，全套 1226/1226 |
| 5 | 测试报告 | ✅ `docs/test_report/supervisor-longrunning/REPORT.md` |
| 6 | 合并 main + push | ✅ |

## 编码交付清单

### 后端
- `src/db.ts`：新增 `supervisor_sessions`、`supervisor_decisions` 两表 + 索引；新增 `SupervisorSessionRow`/`SupervisorDecisionRow` 类型 + 13 个 CRUD/查询函数（create/get/list/due/stale/update/delete/createDecision/finalizeDecision/listDecisions/getLatest/cleanup/cleanupOld）。
- `src/supervisor-agent.ts`（新增，~620 行）：核心模块。生命周期（create/toggle/delete）、`parseSupervisorDecision` 纯函数、`runSupervisionCheck` 核心检查（采集证据→LLM→落库→副作用回喂）、`startSupervisorLoop`/`runSupervisorTick` 调度循环、`bootRecoverSupervisor` 启动恢复、心跳超时检测、连续失败熔断、on_iteration 轮询式推进检测。
- `src/routes/supervisor.ts`（新增）：REST API（POST/GET/GET:id/PATCH/DELETE/POST:check/GET:decisions）。
- `src/types.ts`：新增 `SupervisorStrategy`/`SupervisorSessionStatus`/`SupervisorAction`/`SupervisorEvidence` 类型。
- `src/index.ts`：构造 `supervisorDeps`（复用 schedulerDeps 的 storePromptMessage/queue + 新增 supervisor-source 消息存储）、`setSupervisorDeps`、`startSupervisorLoop`、`bootRecoverSupervisor` 启动恢复接线。
- `src/web.ts`：挂载 `/api/supervisor` 路由。

### 前端
- `web/src/api/supervisor.ts`：类型 + API 调用。
- `web/src/stores/supervisor.ts`：Zustand store（fetch/select/create/toggle/remove/triggerCheck/loadDecisions）。
- `web/src/pages/SupervisorPage.tsx`：会话列表 + 决策时间线 + 创建对话框（含证据折叠、置信度、熔断标记、5s 轮询）。
- `web/src/components/layout/nav-items.ts`：新增 Supervisor 导航项。
- `web/src/App.tsx`：新增 `/supervisor` 路由。

## 设计决策记录

1. **监督模式**：周期性观察者（非逐消息门控），匹配用户"监督周期"语义。
2. **on_iteration 策略**：原方案订阅 `loop_review_result` stream 事件；实施时改为 **tick 内轮询绑定 loop_run 的 turn 推进**——零跨模块事件接线、行为等价、更自洽（避免改动 stream-event 分发路径）。
3. **崩溃恢复**：照搬三大既有先例——内存 dedup set + DB stale `running` 行翻转 + `next_check_at` 落库驱动 + 心跳超时强制 recovery check + 连续失败熔断。
4. **回喂通道**：复用 `runGroupModeTask` 范式——`storePromptMessage`(sourceKind='supervisor') + `queue.enqueueMessageCheck`，使结论可见且驱动下一次主 Agent 运行。
5. **不动既有 supervisor.ts**：新子系统与 MVP 意图解析器并存，零回归。

## 验证结果
- `npx tsc --noEmit`（后端）：exit 0
- `npx tsc --noEmit`（web）：exit 0
- `npx vite build`（web）：✓ built
- `npx tsc`（后端 dist）：exit 0
- `npx vitest run tests/units/supervisor-agent.test.ts`：21/21 通过
- `npx vitest run`（全套）：94 文件 1226 测试全绿，零回归
