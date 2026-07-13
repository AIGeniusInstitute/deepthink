# PRD：Loop Engineering v3 — 验收加固与单测补齐

分支：`feat/loop-engineering-v3`
需求来源：用户 2026-07-08 飞书指令（与 v2 PRD 同源，本期为 v2 合入后的验收 + 补强）
作者：AI Coder
日期：2026-07-08

## 0. 背景与 v2 现状

`feat/loop-engineering-v2` 已于 2026-07-08 合入 `main`（commit `c8a7407` + merge `a926119`），交付物完整覆盖用户 4 项需求：

| 用户需求 | v2 实现位置 | 状态 |
|----------|-------------|------|
| 1. 主对话框四类循环（Turn/Goal/Time/Proactive） | `LoopModeSwitcher.tsx`（4 chip）+ `loop-commands.ts`（`/goal /loop /schedule /proactive /adaptive /skill_evolution`）+ `loop-orchestrator.ts`（6 种 `kind` 状态机） | ✅ 已合入 |
| 2. 任务执行 DAG 实时渲染 + 节点点击查看/编辑 Trace + 自适应循环 + 技能自进化循环 | `InlineLoopCard.tsx`（5s 轮询 + SVG 横向流程）+ `LoopDagPanel.tsx`（`TraceDetailDrawer` 编辑）+ `executeAdaptiveLoop` / `executeSkillEvolutionLoop` | ✅ 已合入 |
| 3. Supervisor Agent（人类托管） | `supervisor.ts` + `supervisor-config.ts` + `SupervisorToggle.tsx` + `agent-definitions.ts` supervisor SubAgent | ✅ 已合入 |
| 4. 顶栏去掉 "admin Home" 改哲学宣传语 | `ChatView.tsx:568` `isDefaultHomeName` 分支 + `SloganRotator.tsx`（5 条宣传语，15s 轮播，localStorage 记忆） | ✅ 已合入 |

v2 测试报告（`docs/test_report/loop-engineering-v2/REPORT.md`）声明 `make typecheck` 全绿、`make test` 1078/1079 通过（1 例 `feishu-card.test.ts` 超时为预先存在失败）。

## 1. 本期定位（为什么还要 v3）

用户重发同一指令，存在两种可能：
- 不知 v2 已合入 → 期望看到功能落地
- 知 v2 已合入 → 期望验收或补强

v3 选择「验收 + 补强」路径，**不重写 v2 任何业务代码**，只做两件事：

1. **独立验收**：在 v3 分支上重新跑 `make typecheck` + `make test`，并对 4 项需求逐条做静态代码证据复核，输出验收报告
2. **单测补齐**：v2 引入了 6 种 `kind` 状态机和 Supervisor 决策逻辑，但 `parseSuggestedExt` / `parseWorkflow` / `parseMaxTurns` / `parseDecision` 四个纯函数未导出、未测试，存在回归盲区。本期导出并补单测

## 2. 需求拆解

### 需求 1：四类循环（Turn/Goal/Time/Proactive）验收

**验收方法**：

| 子项 | 验证手段 | 期望 |
|------|---------|------|
| Turn-based loop（`/goal X max_turns=N`） | grep `handleGoalCommand` + `executeGoalLoop` | 命中 |
| Goal-based loop（`/goal X` 不带 N） | grep `clampMaxTurns` 默认值 5 | 命中 |
| Time-based loop（`/loop 5m X` 与 `/schedule cron X`） | grep `parseInterval` + `isValidCron` | 命中 |
| Proactive loop（`/proactive cron X workflow=parallel`） | grep `parseWorkflow` + `executeProactiveLoop` | 命中 |
| 主对话框 UI 入口 | grep `LoopModeSwitcher` 挂载点 | 命中 `ChatView.tsx` |

**对比表**（与 v2 PRD §1.1 一致，此处不重复）：

| 维度 | Turn-based | Goal-based | Time-based | Proactive |
|------|-----------|-----------|-----------|----------|
| 触发 | `/goal X max_turns=N` | `/goal X` | `/loop` `/schedule` | `/proactive` |
| 停止 | 达 N 轮 | 评审通过 | 时间到 / cron 失效 | 撤销 / cron 失效 |
| 评审 | 每轮 | 每轮 | 不评审 | 每轮 |
| 调度 | 立即 | 立即 | 间隔 / cron | cron |
| 并行 | 否 | 否 | 否 | 可选 parallel |

### 需求 2：DAG 实时渲染 + 节点可点击 + 自适应 + 技能自进化验收

| 子项 | 验证手段 | 期望 |
|------|---------|------|
| 内联 LoopRunCard | `MessageBubble.tsx` 检测 `attachments.loop_card` | 命中 |
| 实时 DAG（SVG 横向流程） | `LoopDagPanel.tsx` 渲染 `<svg>` + 节点边 | 命中 |
| 节点点击抽屉 | `TraceDetailDrawer` 组件存在 | 命中 |
| 节点编辑回写 | `PATCH /api/loops/:id/trace/:nodeId` 路由 | 命中 `routes/loops.ts:129` |
| 自适应循环 | `executeAdaptiveLoop` + `parseSuggestedExt` | 命中 |
| 技能自进化循环 | `executeSkillEvolutionLoop` | 命中 |

### 需求 3：Supervisor Agent 验收

| 子项 | 验证手段 | 期望 |
|------|---------|------|
| 顶栏开关 | `SupervisorToggle.tsx` 挂载于 `ChatView.tsx` | 命中 |
| 决策逻辑 | `supervisor.ts::runSupervisorPreDispatch` 输出 `{action, instruction?, question?}` | 命中 |
| 三种动作 | `clarify` / `delegate` / `auto` 分支 | 命中 |
| 紫色 🧭 消息渲染 | `MessageBubble.tsx` `source_kind` 分支 | 命中 |
| 默认关闭 | `supervisor-config.ts` 默认 false | 命中 |

### 需求 4：顶栏宣传语验收

| 子项 | 验证手段 | 期望 |
|------|---------|------|
| "admin Home" 不再硬渲染 | `ChatView.tsx:568` 走 `isDefaultHomeName` 判断 | 命中 |
| 5 条宣传语 | `SloganRotator.tsx::SLOGANS` | 5 条 |
| 15s 轮播 | `ROTATE_MS = 15_000` | 命中 |
| localStorage 记忆 | `STORAGE_KEY = 'deepthink:slogan-index'` | 命中 |
| 自定义组名保留 | `isDefaultHomeName` false 时显示 `group.name` | 命中 |

## 3. 本期新增工作（补强）

### 3.1 导出 4 个纯函数

为补单测，将以下函数从「文件私有」改为「模块导出」（每个函数加 `export` 关键字，零行为变更）：

| 函数 | 文件 | 行号 | 用途 |
|------|------|------|------|
| `parseMaxTurns` | `src/loop-commands.ts` | ~37 | 解析 `/goal X max_turns=N` 尾参 |
| `parseWorkflow` | `src/loop-commands.ts` | ~67 | 解析 `/proactive cron X workflow=parallel` 尾参 |
| `parseSuggestedExt` | `src/loop-orchestrator.ts` | 717 | 解析 adaptive 评审 `suggested_next_turns` |
| `parseDecision` | `src/supervisor.ts` | ~54 | 解析 Supervisor 输出 JSON 决策 |

### 3.2 补 4 组单测

在 `tests/units/loop-engineering.test.ts` 末尾追加 3 个 describe 块，新建 `tests/units/supervisor-decision.test.ts` 1 个 describe 块：

| describe | 覆盖 | 用例数 |
|----------|------|--------|
| `loop-commands: parseMaxTurns` | 显式 N / 默认 5 / N=0 clamp 到 1 / N>10 clamp 到 10 | 4 |
| `loop-commands: parseWorkflow` | parallel / sequential / 默认 sequential | 3 |
| `loop-orchestrator: parseSuggestedExt` | `next_turns=3` / 数字前缀 / 空串 / 无效串 | 4 |
| `supervisor: parseDecision` | clarify / delegate / auto / markdown 包裹 / 无效 JSON / 缺 action | 6 |

## 4. 成功标准（Goal-Driven）

| # | 验证项 | 验证方法 |
|---|--------|---------|
| S1 | v2 的 4 项需求在 main 当前 HEAD 静态复核全部通过 | grep 证据 + 报告 |
| S2 | `make typecheck` 通过 | CI |
| S3 | `make test` 通过率 ≥ v2 baseline（1078/1079） | CI |
| S4 | 新增 17 个单测全部通过 | vitest |
| S5 | 不破坏 v2 任何既有功能（不重写业务代码） | 代码 diff 仅含 `export` 关键字 + 测试文件 |

## 5. 非目标（Out of Scope）

- 不重写 v2 状态机、UI、路由
- 不引入 react-flow 等图库
- 不改 IM 斜杠命令协议
- 不修 `feishu-card.test.ts` 超时（v2 已声明为预先存在失败，后续 issue 单独处理）
- 不做 GUI 人工点击验证（沙箱无 GUI，以静态证据 + 单测替代）

## 6. 风险与权衡

| 风险 | 缓解 |
|------|------|
| 导出私有函数破坏封装 | 4 个函数均为纯解析函数，无副作用，导出不影响行为 |
| 新增测试可能暴露 v2 bug | 若发现，作为 v3 修复项；若无，纯加固 |
| 验收证据静态化无法验证运行时 | 复用 v2 已有的 typecheck + test + 代码审查三层证据 |

## 7. 里程碑

| 阶段 | 内容 | 估时 |
|------|------|------|
| M1 | 拉取 main + 建 v3 分支 | 5 min |
| M2 | 跑 typecheck + test 验证 v2 | 10 min |
| M3 | 写 PRD（本文件） | 30 min |
| M4 | 写技术方案 | 30 min |
| M5 | 导出 4 函数 + 补 17 单测 | 1 h |
| M6 | typecheck + test 全绿 | 10 min |
| M7 | 测试报告 | 30 min |
| M8 | commit + push + 合并 main + push | 15 min |

总计 ~3.5 h。

## 8. 文档关联

- 技术方案：`docs/tech_solution/loop-engineering-v3/SOLUTION.md`
- 测试报告：`docs/test_report/loop-engineering-v3/REPORT.md`
- v2 PRD（本期验收基线）：`docs/prd/loop-engineering-v2/PRD.md`
- v2 测试报告：`docs/test_report/loop-engineering-v2/REPORT.md`
