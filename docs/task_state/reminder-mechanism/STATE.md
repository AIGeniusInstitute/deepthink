# 任务执行状态 — Reminder 机制

> 分支：`feat/reminder-mechanism` ｜ 更新：2026-07-24

## 进度

- [x] 0. worktree 创建
- [x] 1. PRD + 验收标准 + 测试用例（docs/prd/reminder-mechanism/PRD.md）
- [x] 2. 技术方案（docs/tech_solution/reminder-mechanism/TECH_SOLUTION.md）
- [x] 3. 编码实施（F1~F5 全部完成）
  - [x] F2 流式事件类型扩展（shared/stream-event.ts + 三副本同步）
  - [x] F1 ReminderEngine + agent-runner 集成（tool_result 计数 + PreCompact hook）
  - [x] F3 宿主配置传递（ContainerInput.reminderConfig + runtime-config reminder.json + buildReminderConfig）
  - [x] F5 用户开关全链路（ProfileSection → auth → schemas → routes → db → types）
  - [x] F4 前端 store + ReminderPanel + ChatView 挂载（桌面+移动）
- [x] 4. 测试 + 修复循环
  - 单元测试 5/5 通过
  - UI 自动化 9/10 实测通过 + TC-07 构建验证（详见测试报告）
  - 调试中发现并修复：测试实例 WEB_DIST_DIR 环境变量导致服务旧前端（仅测试环境问题，非代码缺陷）；tab 按钮缺 aria-label（顺手补可访问性）
- [x] 5. 测试报告（docs/test_report/reminder-mechanism/TEST_REPORT.md）+ 合并推送

## 关键文件

- 新增：`container/agent-runner/src/reminder-engine.ts`、`src/reminder-config.ts`、`web/src/components/chat/ReminderPanel.tsx`、`tests/reminder-engine.test.ts`
- 修改：shared/stream-event.ts、agent-runner（index.ts/stream-processor.ts/types.ts）、src（container-runner.ts/db.ts/index.ts/loop-orchestrator.ts/routes/auth.ts/runtime-config.ts/schemas.ts/types.ts/web.ts）、web（ChatView.tsx/ProfileSection.tsx/stores/auth.ts/stores/chat.ts）

## 决策记录

- 注入点选 `tool_result` 事件计数（非 `result`）：粒度匹配"每 N 步"语义，触发于工具返回后，避免在最终 result 停止点注入。
- 注入车辆 `MessageStream.push()`：与既有 IPC follow-up 同通道，不改 system prompt、不新增传输层。
- 注入日志不新建 DB 表：归属 StreamingState + 服务端 streamingSnapshots，断线重连恢复，避免过度工程。
- 用户开关镜像 `default_require_mention` 全链路；全局间隔走文件配置 reminder.json（默认 8）。
