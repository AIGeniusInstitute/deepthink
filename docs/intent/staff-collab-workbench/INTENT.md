# Intent: 企业数字员工多人协作工作台

## 原始意图

用户要求在 DeepThink 中开发一个**企业数字员工多人协作工作台**，功能设计和源代码实现参考 `~/StaffDeck` 项目。

## 用户原话

> 任务1:在DeepThink中开发一个企业数字员工多人协作工作台。企业数字员工协作工作台的功能设计和源代码实现，请参考这个项目的源代码：~/StaffDeck
>
> 任务2:开发完成之后，创建一个测试者Agent，全面测试验收该任务的完成质量：如果遇到bug，执行issue修复流程，Loop循环，直到全部任务需求通过验收。

## 意图拆解

1. **数字员工管理**：创建/编辑/删除数字员工（Agent），每个员工有角色（如开发/分析/写作）、人设提示词、绑定模型、技能、知识库、工具
2. **团队协作**：组建团队（队长+成员），创建任务并分配，任务有状态流转（待处理→进行中→评审→完成/返工），团队共享黑板（知识沉淀）
3. **工作台 UI**：企业级管理控制台——数字员工列表页、团队列表+详情页（成员/任务/黑板）、仪表盘概览
4. **测试验收**：开发完成后创建测试者 Agent 全面验收，遇 bug 走 issue 修复流程循环至全通过

## 参考项目关键特性（StaffDeck）

- AgentProfile：name, persona_prompt, role, model bindings, resource bindings (skills/KB/tools)
- Team：owner, members (leader/member), team runs, tasks with state machine, bidding arena, blackboard
- Dashboard：work records, conversation logs, memories, scheduled tasks
- 60+ 表的完整系统，但 DeepThink 已有 agent_definitions/collaborations/graph/skills/KB/MCP

## 范围决策（Simplicity First）

不重实现 StaffDeck 全部 60+ 表。聚焦 DeepThink 缺失的 3 个核心能力：
1. 数字员工概念层（员工元数据 + 绑定 agent_definition）
2. 持久化团队 + 任务状态机 + 黑板（DeepThink 的 collaborations 是一次性 run，不是持久团队）
3. 企业工作台 UI（员工管理、团队详情、仪表盘）
