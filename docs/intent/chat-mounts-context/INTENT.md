# Intent: Agent 对话挂载上下文修复

## 用户原始意图

Agent 对话输入框，选中某个具体"技能"后对话，技能没有带到对话上下文中。同理，MCP 工具、知识库的选中也没有带到对话上下文。

## 需求

1. Agent 对话输入框做一个单独的技能选择区域，支持下拉选择存储在 PostgreSQL 数据库中的技能，搜索技能，多选选中技能，加载选中的技能实时进行对话。
2. 同时做一个 MCP 工具选择区域、知识库选择区域。
3. Agent 对话时，技能、MCP 工具、知识库检索等都可以挂载运行时使用。
4. 创建测试者 Agent 全面测试验收，遇到 bug 执行 issue 修复流程循环直到全部通过。

## 根因分析（6 个 bug）

| # | Bug | 位置 |
|---|-----|------|
| 1 | getSkillContents 只查 DB，用户技能存在磁盘 SKILL.md | db.ts:10383 + container-runner.ts:1229 |
| 2 | WebSocket handler 丢弃 selectedMounts | web.ts:1482-1487, 1654-1661 |
| 3 | handleAgentConversationMessage 不调 setPendingTurnMounts | web.ts:947-1190 |
| 4 | IPC 注入路径不支持 per-turn mounts | web.ts:692-693 |
| 5 | Agent 子对话无 ChatToolbar | ChatView.tsx:780-803 |
| 6 | sendAgentMessage 不传 selectedMounts | chat.ts:3042-3063 |
