# Agent Group Chat 多 Agent 群组协作 — 验收测试

## 原始意图

用户要求对 DeepThink 多 Agent 群组协作（Agent Group Chat）功能进行完整的验收测试，确保：

1. **多 Agent 辩论**：群组内 Agent 能够对问题进行充分沟通、脑暴、辩论，互相分析对方的结论
2. **主 Agent 能力全面复刻**：群组 Agent 拥有与系统主 Agent 相同的能力——流式输出思考过程、工具调用卡片、技能调用卡片、token 消耗、执行摘要
3. **Pipeline 可追溯执行面板**：群组运行状态可实时查看，包括各席位的执行进度

## 任务目标

1. 打开浏览器访问 DeepThink 系统首页（http://127.0.0.1:9999）
2. 设计该任务目标的验收测试用例
3. 执行测试，遇到 Bug 执行 Issue 修复流程
4. Loop 循环直到全部测试通过
5. 每个通过的测试用例截图验收
6. 输出完整的带截图的测试报告 HTML 产物

## 相关文件

- 前端核心组件：`web/src/components/agent-group/GroupChatArea.tsx`
- 群组 Runner：`src/agent-group/swarm-runner.ts`
- 图编排器：`src/graph-engineering/graph-orchestrator.ts`
- WS 广播：`src/web.ts`
- 群组 API：`src/routes/agent-groups.ts`