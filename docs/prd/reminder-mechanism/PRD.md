# PRD — DeepThink Reminder 机制

> 分支：`feat/reminder-mechanism` ｜ worktree：`.claude/worktrees/feat-reminder-mechanism`
> 创建日期：2026-07-24 ｜ 状态：实施中

## 1. 背景与目标

DeepThink Agent 在执行长任务时存在三个核心痛点（详见用户提供的参考资料《Agent Reminder 机制深度解析》）：

1. **上下文窗口限制**：历史对话撑爆窗口，早期指令/关键信息被截断或挤出，Agent「失忆」。
2. **注意力分散**：LLM 注意力偏向最近输入，长对话中 Agent 容易迷失在琐碎细节，忘记核心目标。
3. **指令遵循衰减**：多轮复杂任务中，Agent 随步骤增加逐渐放松对初始约束的遵守。

**Reminder 机制**的作用：在 LLM 产生「遗忘」或「偏离」之前，主动将关键信息（最终目标、约束、步数、状态摘要）重新注入到当前上下文，作为维持长期目标一致性的「锚点」。

### 目标（生产可用）

在 DeepThink Agent 中加入 Reminder 机制，使长任务执行过程中：

- 周期性（每 N 个工具步骤）+ 事件驱动（上下文压缩后）地将 Reminder 重新注入 LLM 上下文。
- Reminder 的实时状态与注入日志全部保留在聊天对话框的**独立区域**显式呈现给用户。
- 默认开启，用户可在设置中关闭 Reminder 机制。

### 非目标（本期不做）

- 不做 RAG 检索增强型 Reminder（无长期记忆库检索需求）。
- 不做独立于 loop 的「定时器型」Reminder（已有 task-scheduler 覆盖 cron/interval 场景）。
- 不重构 loop-orchestrator 既有的 `buildIterationPrompt` 每轮 goal 注入（那是 loop 场景的既有 reminder，保持外科手术式不动）。

## 2. 名词定义

| 术语 | 定义 |
|---|---|
| Reminder | 重新注入到 LLM 上下文的关键信息片段（目标+约束+步数+状态） |
| 注入（Inject） | 通过 `MessageStream.push()` 向运行中的 SDK query 追加一条 user message，SDK 在下一 turn 边界读取并据此开新 turn |
| 工具步骤（tool step） | 一次 `tool_result` 事件 = 一个完成的工具调用步骤 |
| Turn | SDK 的一次 assistant 响应周期（`result` 事件为 turn 边界） |
| 注入日志 | 每次 Reminder 注入的记录（时间、触发原因、步数、目标摘要、注入内容摘要） |

## 3. 功能点与验收标准

### F1 — Reminder 引擎（agent-runner 内，通用注入）

**描述**：在 `container/agent-runner` 的 SDK `query()` 主循环中，新建 ReminderEngine，按触发条件将 Reminder 注入运行中的 query。

**触发条件**：
- **周期性（periodic）**：每 `intervalSteps`（默认 8）个工具步骤注入一次。计数源 = `tool_result` 事件计数。
- **压缩驱动（compact）**：SDK `PreCompact` hook 触发后（历史被摘要、关键信息易丢失），立即注入一次。

**Reminder 内容**（压缩摘要，非原文复述；含措辞变化避免「习惯性忽略」）：
```
*** Reminder · 已执行 {steps} 步 / turn {n} ***
任务目标：{goalSnippet}
{rotatedNudge}
```
其中 `goalSnippet` = 原 prompt 截断前 500 字；`rotatedNudge` 从一组提示语中按步数轮转（如「请核对进度是否偏离目标」「若已完成可输出最终结果，否则继续」「牢记输出格式与约束」）。

**验收标准 AC-F1**：
- AC-F1.1：agent-runner 启动 query 时读取 `containerInput.reminderConfig`；`enabled=false` 时引擎不注入任何 Reminder。
- AC-F1.2：每达到 `intervalSteps` 个 `tool_result` 事件，引擎调用 `stream.push(reminderText)` 注入一条 user message，并 emit 一条 `reminder_injected` 流式事件。
- AC-F1.3：`PreCompact` hook 执行后，引擎注入一次 compact 型 Reminder 并 emit 事件。
- AC-F1.4：Reminder 文本被 `stream.push` 后，SDK 在下一 turn 边界读取它（与既有 IPC follow-up 同机制，不引入新传输路径）。
- AC-F1.5：注入日志（reason/steps/turnIndex/goalSnippet/summary）通过 `reminder_injected` 事件的 `reminder` 字段承载，经既有 `broadcastStreamEvent` 通路广播，不新增传输通道。
- AC-F1.6：引擎在 query 结束（`stream.end()`）后 `push()` 为 no-op（既有 MessageStream 行为），不会抛错。

### F2 — 流式事件类型扩展

**描述**：在 canonical 源 `shared/stream-event.ts` 新增 `reminder_injected` 事件类型与 `reminder` payload 字段，`make sync-types` 同步到 3 处副本。

**验收标准 AC-F2**：
- AC-F2.1：`StreamEventType` 联合类型包含 `'reminder_injected'`。
- AC-F2.2：`StreamEvent` 接口新增可选字段 `reminder?: { reason; turnIndex; stepsSinceLast; goalSnippet; summary }`。
- AC-F2.3：`scripts/sync-stream-event.sh` 运行后，`src/`、`container/agent-runner/src/`、`web/src/` 三处副本内容一致（`make sync-types` 校验脚本通过）。

### F3 — 宿主配置传递

**描述**：宿主在装配 `ContainerInput` 时注入 `reminderConfig`（enabled + intervalSteps + goalSnippet），透传到 agent-runner。

**配置来源**：
- `enabled`：用户 `reminder_enabled` 偏好（默认 true）。
- `intervalSteps`：全局 `reminder.json`（`runtime-config.ts`，默认 8）。
- `goalSnippet`：截断 `prompt` 前 500 字。

**验收标准 AC-F3**：
- AC-F3.1：`ContainerInput` 接口（host `src/container-runner.ts` 与 agent-runner `container/agent-runner/src/types.ts`）新增 `reminderConfig?` 字段，经 `...input` spread 透传至 docker/host input。
- AC-F3.2：`runtime-config.ts` 新增 `getReminderConfig()/saveReminderConfig()`，读写 `config/reminder.json`，仿 `getAppearanceConfig` 模式。
- AC-F3.3：`index.ts` 主调度点（runHostAgent/runContainerAgent）与 `loop-orchestrator.ts` 调度点均构建 `reminderConfig` 注入 input。

### F4 — 前端 Reminder 面板（独立区域）

**描述**：在聊天页右侧折叠面板新增「Reminder」tab，显式呈现实时状态与注入日志。

**面板内容**：
- **实时状态**：开关状态、当前步数、距下次注入剩余步数、最近一次注入原因/时间。
- **注入日志**：列表，每条含 时间、触发原因（periodic/compact）、步数、目标摘要、注入内容摘要。

**验收标准 AC-F4**：
- AC-F4.1：`ChatView.tsx` `SIDEBAR_TABS` 新增 `reminder` tab（Bell 图标），`SidebarTab` 类型同步，面板内容 switch 渲染 `<ReminderPanel>`。
- AC-F4.2：移动端 Sheet 同步新增 reminder 入口。
- AC-F4.3：`chat.ts` `StreamingState` 新增 `reminderLog` 字段；`applyStreamEvent` 新增 `case 'reminder_injected'` 写入日志；`handleStreamSnapshot` 恢复该字段；新 turn/重置时正确清空。
- AC-F4.4：ReminderPanel 数据来自 chat store，仿 `TracePanel`/`FilePanel` 写法（接收 groupJid）。
- AC-F4.5：面板默认可见（tab 列表含 reminder）；Reminder 关闭时面板仍可见但显示「已关闭」状态。

### F5 — 用户开关（默认开启，可关闭）

**描述**：用户可在「设置 → 个人偏好」关闭 Reminder 机制，默认开启。

**验收标准 AC-F5**：
- AC-F5.1：`ProfileSection.tsx` 新增 `Switch`「Reminder 机制」（默认 on），镜像 `defaultRequireMention` 写法。
- AC-F5.2：`auth.ts` store `UserPublic` + `updateProfile` payload 新增 `reminder_enabled` 字段。
- AC-F5.3：后端 `routes/auth.ts` PUT `/api/auth/profile`、`schemas.ts`、`db.ts`（建表列/insert/select/映射/update allowlist/迁移）、`types.ts`（UserPublic/UserRow）全链路同步新增 `reminder_enabled`（默认 1/true）。
- AC-F5.4：关闭后，该用户后续 agent 运行的 `reminderConfig.enabled=false`，不再注入 Reminder；面板状态显示「已关闭」。
- AC-F5.5：新注册用户默认 `reminder_enabled=1`。

## 4. 测试用例

### UI 自动化测试（Playwright，登录 admin / Test12345!）

| 用例 ID | 场景 | 步骤 | 预期 |
|---|---|---|---|
| TC-01 | Reminder 面板默认可见 | 登录 → 打开任一会话 → 打开右侧面板 | tab 列表含「Reminder」 |
| TC-02 | 用户开关默认开启 | 设置 → 个人偏好 | Reminder 开关为 on |
| TC-03 | 关闭 Reminder | 切换开关 off → 保存 | toast 成功；刷新后仍 off |
| TC-04 | 开启 Reminder 长任务注入 | 开启 Reminder → 发送一个需多步工具调用的长任务（如「研究 X 并写报告」）→ 观察面板 | 面板「注入日志」出现 ≥1 条 periodic 记录，含原因/步数/摘要 |
| TC-05 | 关闭 Reminder 无注入 | 关闭 Reminder → 发送同长任务 → 观察面板 | 无新注入记录，状态显示「已关闭」 |
| TC-06 | 面板实时状态 | 长任务执行中查看面板 | 显示当前步数、距下次注入剩余步数 |
| TC-07 | 移动端面板 | 窄屏 → 打开 Sheet | 含 Reminder 入口，可展开 |
| TC-08 | 关闭后重启会话 | 关闭 Reminder → 新开会话 → 跑任务 | 仍无注入（开关持久化） |

### 单元/集成测试（vitest）

| 用例 ID | 场景 | 预期 |
|---|---|---|
| TC-09 | ReminderEngine 周期触发 | 模拟 8 次 tool_result → 触发 1 次 inject，计数清零 |
| TC-10 | ReminderEngine disabled | enabled=false → 8 次 tool_result 无 inject |
| TC-11 | ReminderEngine compact 触发 | onCompact() → 触发 1 次 inject，reason='compact' |
| TC-12 | reminder_injected 事件结构 | 事件含 reminder 字段五要素 |
| TC-13 | getReminderConfig 默认值 | 无 reminder.json → 返回默认 enabled=true/interval=8 |

## 5. 退出条件

- 全部 AC-F1~F5 满足。
- TC-01~TC-08 UI 自动化通过、TC-09~TC-13 单元测试通过。
- `make build`（含 sync-types 校验）成功。
- `make typecheck` / 前端 `tsc` 无新增错误。
- worktree 合并到 main 并 push 成功。
