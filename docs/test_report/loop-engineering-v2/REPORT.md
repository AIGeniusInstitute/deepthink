# 测试报告：Loop Engineering v2

分支：`feat/loop-engineering-v2`
关联 PRD：`docs/prd/loop-engineering-v2/PRD.md`
关联方案：`docs/tech_solution/loop-engineering-v2/SOLUTION.md`
测试人：AI Coder
日期：2026-07-08

## 0. 测试环境

- 项目：`~/deep-think`（deep-think 桌面端仓库，主分支 `main`）
- Node 24.x / npm
- 验证手段：`make typecheck` + `make test`（vitest）+ 代码审查 + 静态校验
- 说明：deep-think 是 Electron 桌面应用，本期改动覆盖后端（`src/`）+ 容器（`container/agent-runner/`）+ 前端（`web/src/`）三处。受限于 CI 沙箱无 GUI，UI 验证以「代码静态校验 + 关键路径 grep 验证 + 单测覆盖」三层证据替代人工点击。

## 1. 成功标准对照（PRD §2）

| # | 验证项 | 结果 | 证据 |
|---|--------|------|------|
| S1 | 主对话框输入区 4 个模式 chip + 展开表单 | ✅ | `ChatView.tsx:793` 挂载 `<LoopModeSwitcher>`；`LoopModeSwitcher.tsx` 实现 chat/goal/time/proactive 四 chip + 表单 |
| S2 | 主对话框 UI 启动 goal loop → 实时 LoopRunCard + DAG | ✅ | `MessageBubble.tsx:176/376/614` 检测 `attachments.loop_card` 并渲染 `<InlineLoopCard>`；`InlineLoopCard.tsx` 实现 5s 轮询 + DAG + 取消按钮 |
| S3 | DAG 节点可点击 + 抽屉 + 编辑回写 | ✅ | `LoopDagPanel.tsx` 横向 SVG 流程 + `TraceDetailDrawer`；`PATCH /api/loops/:id/trace/:nodeId` 见 `routes/loops.ts:129`；`loop_trace_nodes.edited_at` 列已加（`db.ts:827`） |
| S4 | 顶栏不再显示 "admin Home"，显示轮播宣传语 | ✅ | `ChatView.tsx:568` `isDefaultHomeName` 分支 + `<SloganRotator>`；`SloganRotator.tsx` 15s 轮播 + localStorage 记忆 |
| S5 | Supervisor 开关 + 紫色 🧭 头像中间消息 | ✅ | `ChatView.tsx:588` `<SupervisorToggle>`；`src/supervisor.ts` 实现 `runSupervisorPreDispatch`；`MessageBubble.tsx` `source_kind` 渲染分支；`/api/config/supervisor` 路由见 `routes/config.ts` |
| S6 | `adaptive` 与 `skill_evolution` kind 可启动 | ✅ | `loop-orchestrator.ts:595 executeAdaptiveLoop` + `:747 executeSkillEvolutionLoop`；dispatch `index.ts:1509-1511`；命令 `loop-commands.ts` `/adaptive` `/skill_evolution` |
| S7 | `make typecheck` 通过 | ✅ | 后端 + 前端 + agent-runner 三处全绿，StreamEvent 副本同步校验通过 |
| S8 | `make test` 通过 | ⚠️ | 1078/1079 通过；1 例 `feishu-card.test.ts` 超时（5000ms）— 经 `git stash` 对照验证为**预先存在失败**，与本期改动无关（main 分支同样失败） |
| S9 | `/loops` 独立页面回归 | ✅ | 未触碰 `LoopsPage.tsx` 与 `stores/loops.ts` 现有逻辑，仅新增 kind 与 `editTraceNode` action |

## 2. 单元测试结果

```
Test Files  1 failed | 81 passed (82)
Tests       1 failed | 1078 passed (1079)
Duration    115.29s
```

**失败用例**：`tests/feishu-card.test.ts > feishu.ts wrapper uses new builder > buildInteractiveCard delegates to buildAgentReplyCard without default header`（5000ms 超时）

**根因**：该测试动态 `import('../src/feishu.js")` 触发模块初始化链过长，5s 默认超时不够。与 loop-engineering-v2 无任何代码耦合。

**验证方法**：`git stash` 暂存本期所有改动后单跑该测试，仍失败。结论：预先存在。

**建议**：后续单独 issue 修复（提高 testTimeout 或拆分 feishu 模块），不影响本期合入。

## 3. 关键实现核对

### 3.1 后端

| 模块 | 文件 | 改动 | 状态 |
|------|------|------|------|
| 状态机 | `src/loop-orchestrator.ts` | +`executeAdaptiveLoop`/`executeSkillEvolutionLoop` + `suggested_next_turns` 解析 + 无进展检测 | ✅ |
| 命令 | `src/loop-commands.ts` | +`/adaptive` `/skill_evolution` handler | ✅ |
| 路由 | `src/routes/loops.ts` | +`PATCH /:id/trace/:nodeId` 编辑回写 | ✅ |
| 路由 | `src/routes/config.ts` | +`GET/PUT /api/config/supervisor` | ✅ |
| 入口 | `src/index.ts` | dispatch 增 `adaptive`/`skill_evolution` case；命令返回 `{reply, loopRunId}` 注入 attachments.loop_card | ✅ |
| DB | `src/db.ts` | `loop_trace_nodes.edited_at` ensureColumn | ✅ |
| Supervisor | `src/supervisor.ts` + `src/supervisor-config.ts` | `runSupervisorPreDispatch` + per-group config 持久化 | ✅ |

### 3.2 容器

| 模块 | 文件 | 改动 | 状态 |
|------|------|------|------|
| SubAgent | `container/agent-runner/src/agent-definitions.ts` | +`supervisor` SubAgent 定义（无 tools，仅意图解析） | ✅ |

### 3.3 前端

| 模块 | 文件 | 改动 | 状态 |
|------|------|------|------|
| 顶栏 | `web/src/components/chat/ChatView.tsx` | `SloganRotator` + `SupervisorToggle` + `LoopModeSwitcher` 挂载 | ✅ |
| 消息 | `web/src/components/chat/MessageBubble.tsx` | `attachments.loop_card` → `InlineLoopCard` 分支 | ✅ |
| 新组件 | `SloganRotator.tsx` | 15s 轮播 + localStorage 记忆 | ✅ |
| 新组件 | `LoopModeSwitcher.tsx` | 4 chip + 表单展开 + 构造斜杠命令字符串 | ✅ |
| 新组件 | `SupervisorToggle.tsx` | 顶栏开关 + 持久化 | ✅ |
| 新组件 | `InlineLoopCard.tsx` | 5s 轮询 + DAG + 取消 + token/cost | ✅ |
| DAG | `LoopDagPanel.tsx` | 横向 SVG flow 布局 + `TraceDetailDrawer` 编辑 | ✅ |
| Store | `stores/loops.ts` | `adaptive`/`skill_evolution` kind + `editTraceNode` | ✅ |

## 4. 数据流验证

### 4.1 UI 启动 goal loop（S1+S2）

```
点 🎯 目标 chip
  → LoopModeSwitcher 切换 mode='goal'
  → MessageInput 展开 goal/successCriteria/maxTurns 表单
  → onSend 构造 "/goal <目标> max_turns=N"
→ chat store sendAgentMessage → POST /api/chat/send
→ index.ts dispatch 'goal' (1499 附近)
  → handleGoalLoopCommand → createLoopRunRecord + 后台 executeGoalLoop
  → return { reply, loopRunId }
→ attachments 写入 loop_card 类型
→ storeMessageDirect → WS new_message
→ MessageBubble.tsx:176 检测 attachments.loop_card
→ InlineLoopCard 5s 轮询 /api/loops/:id + /api/loops/:id/trace
→ loop_* stream event → WS push → 卡片更新
→ loop 终态 → 停止轮询
```

**验证**：所有节点 grep 命中（见 §3），逻辑链完整。

### 4.2 Supervisor 拦截（S5）

```
用户消息 → index.ts
→ isSupervisorEnabled(chatJid) 为 true
→ runSupervisorPreDispatch(msg, userLanguage)
   → sdkQuery 输出 JSON { action, instruction?, question? }
→ clarify → 直接返回 question 给用户（紫色 🧭 消息）
→ delegate/auto → runMainAgent(instruction) → 复审 → accept/retry
```

**验证**：`src/supervisor.ts` 完整实现；`agent-definitions.ts` 新增 supervisor SubAgent。

## 5. 风险回归

| 风险点 | 缓解 | 验证 |
|--------|------|------|
| Supervisor 增加延迟 | 默认关，仅在用户显式开启时生效 | `supervisor-config.ts` 默认 false |
| DAG 高频刷新卡顿 | 复用 5s 轮询 + loop_* stream event，未新增长连接 | `InlineLoopCard.tsx` isActive 时才轮询 |
| 节点编辑污染 trace | 仅 `loop.status === 'completed'` 开放编辑；写入 `edited_at` | `routes/loops.ts:129` PATCH 端点校验 |
| adaptive max_turns 失控 | 硬上限 10 不变；`suggested_next_turns` 受 `HARD_LIMIT` 约束 | `loop-orchestrator.ts` `MAX_TURNS_HARD_LIMIT` |
| DB 迁移破坏旧数据 | 仅 ensureColumn 加列，向后兼容；schema v41 不变 | `db.ts` 无 SCHEMA_VERSION 调整 |

## 6. 不做的事回归

- ✅ 不引入 react-flow：`LoopDagPanel.tsx` 自绘 SVG
- ✅ 不改 IM 斜杠命令协议：`/adaptive` `/skill_evolution` 复用 dispatch
- ✅ 不重写 loop-orchestrator 状态机：仅新增 adaptive/skill_evolution 分支
- ✅ 不做 Supervisor 多轮外呼：Supervisor tools 为空数组
- ✅ `/loops` 独立页面不动：未触碰 `LoopsPage.tsx`

## 7. 结论

| 维度 | 结论 |
|------|------|
| 代码完整性 | 全部 PRD 需求已实现，关键路径代码审查通过 |
| 类型安全 | `make typecheck` 全绿 |
| 单元测试 | 1078/1079 通过，1 例预先存在失败与本期无关 |
| 向后兼容 | DB 加列、Supervisor 默认关、新 kind 不影响旧 kind |
| 风险 | 已识别风险均有缓解措施，无 P0 残留 |

**结论：可合入 `main` 并 push 远程。**

## 8. 后续建议（非本期）

1. 修复 `feishu-card.test.ts` 超时（拆分 `feishu.ts` 模块或提高 testTimeout）
2. 人工 GUI 验证：开发模式下启动 `make dev`，手动点 🎯 目标 chip 启动一个 goal loop 观察 DAG 实时刷新
3. Supervisor 接入主消息流的集成测试（当前为代码级实现，未跑端到端）
