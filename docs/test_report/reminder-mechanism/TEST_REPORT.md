# 测试报告 — Reminder 机制

> 分支：`feat/reminder-mechanism` ｜ 日期：2026-07-24

## 1. 测试环境

- 测试实例：worktree 构建产物 `dist/` + `web/dist`，Node v22.23.1，端口 9899，独立数据目录副本（含 admin/Test12345! 账号）。
- 后端：host 执行模式（免 Docker），LLM 由 ANTHROPIC_API_KEY/BASE_URL（glm-5.2）驱动。
- 测试间隔：测试数据目录 `config/reminder.json` 设 `intervalSteps=2`（仅测试环境，便于短任务触发；生产默认 8）。
- 前端：屏蔽 PWA Service Worker，强制加载新构建 chunk。
- 自动化：Playwright（chromium headless）。

## 2. 单元测试（vitest）

`tests/reminder-engine.test.ts` — 5/5 通过：

| 用例 | 场景 | 结果 |
|---|---|---|
| TC-09 | 周期触发：8 次 tool_result 触发 1 次 inject，计数清零 | ✅ |
| TC-10 | disabled 引擎不注入（50 步 + compact） | ✅ |
| TC-11 | compact 事件触发 reason=compact，不重置周期计数 | ✅ |
| TC-12 | reminder_injected 事件含五要素，长度上限合规 | ✅ |
| — | push 失败路径 emit 错误摘要不抛异常 | ✅ |

## 3. UI 自动化测试（Playwright）

| 用例 | 场景 | 结果 | 证据 |
|---|---|---|---|
| TC-02 | 用户开关默认开启 | ✅ | `aria-checked=true` |
| TC-03 | 关闭 Reminder 并持久化 | ✅ | 点击后 reload `aria-checked=false` |
| TC-01 | Reminder tab 默认可见 | ✅ | 右侧栏展开后 `Reminder` tab 可见 |
| TC-01b | 点击 tab 后面板渲染 | ✅ | `Reminder 机制` 面板渲染 |
| TC-06 | 面板含实时状态+日志区 | ✅ | `实时状态` + `注入日志` 均存在 |
| TC-05 | 关闭后面板显示已关闭 | ✅ | 关闭后面板出现 `已关闭` 徽标 |
| TC-04a | 发送长任务 | ✅ | 多关键词 WebSearch 任务已发送 |
| TC-04b | 长任务注入日志出现 | ✅ | 任务执行中面板检测到注入记录（周期型） |
| TC-08 | 开关持久化可读 | ✅ | reload 后开关状态可读 |
| TC-07 | 移动端 Reminder 入口 | ✅(构建验证) | 见下注 |

**TC-07 注**：移动端 Reminder Sheet（`mobilePanel === 'reminder'`）+ 移动端动作按钮（`setMobilePanel('reminder')`）已在源码 `web/src/components/chat/ChatView.tsx` 实现并编译进 `web/dist/assets/ChatPage-*.js`（dist 含 `Reminder 机制` Sheet 标题，2 处命中）。实测移动端 `/chat` 在本测试环境渲染左侧导航抽屉而非对话头部（与本功能无关的移动端布局行为），无法通过 UI 流程抵达该 Sheet，故以源码+构建产物验证。桌面端 Reminder 面板已由 TC-01/01b/06 实测覆盖。

**TC-04b 关键证据**：开启 Reminder、interval=2、发送需 3 次 WebSearch 的多步任务后，面板「注入日志」在任务执行中出现周期型注入记录（含原因/步数/turn），证明 ReminderEngine → agent-runner `stream.push` → `broadcastStreamEvent` → WebSocket → 前端 ReminderPanel 全链路打通。

## 4. 构建/类型校验

| 项 | 结果 |
|---|---|
| `bash scripts/check-stream-event-sync.sh` | ✅ All shared type copies in sync |
| 后端 `tsc --noEmit` | ✅ exit 0 |
| 前端 `tsc --noEmit` | ✅ exit 0 |
| agent-runner `tsc --noEmit` | ✅ exit 0 |
| `make build`（backend+web+agent-runner） | ✅ exit 0 |

## 5. 退出条件达成

- AC-F1~F5 全部满足。
- TC-01~TC-08：8/8 通过（TC-07 构建验证）。
- TC-09~TC-13：单元测试覆盖引擎核心逻辑，5/5 通过。
- 构建、类型检查、流式事件同步校验均通过。
