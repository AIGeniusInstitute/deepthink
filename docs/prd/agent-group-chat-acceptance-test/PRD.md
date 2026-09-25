# Agent Group Chat 多 Agent 群组协作 — 验收测试 PRD

## 1. 功能概述

多 Agent 群组协作（Agent Group Chat）是 DeepThink 的核心功能之一，允许多个 AI Agent 在群组内以辩论/协作方式进行充分沟通。每个 Agent 拥有与系统主 Agent 相同的能力（流式输出思考过程、工具调用、技能调用、token 消耗、执行摘要）。

## 2. 验收标准（Acceptance Criteria）

### AC1: 群组页面加载
- **Given**: 用户已登录 DeepThink 系统
- **When**: 用户导航到 Agent Group Chat 页面
- **Then**: 页面正常加载，显示群组名称、席位数量、消息列表、输入区域

### AC2: 消息发送
- **Given**: 用户在 Agent Group Chat 页面
- **When**: 用户在输入框输入消息并发送
- **Then**: 
  - 消息立即出现在消息列表中
  - 后端调用 `startSwarmRun` 开始群组运行

### AC3: 流式思考过程输出
- **Given**: 群组运行已触发
- **When**: Agent 开始处理任务
- **Then**:
  - 思考过程以流式方式实时出现在界面中
  - 思考块包含「思考过程」标题
  - 思考内容逐字显示（group_thinking_delta 事件）

### AC4: 流式文本输出
- **Given**: Agent 已完成思考
- **When**: Agent 开始输出回复文本
- **Then**:
  - 文本以流式方式实时出现在界面中
  - 文本内容逐字显示（group_message_delta 事件）
  - 每个 Agent 的消息带有「Agent #N」标识

### AC5: 工具调用卡片
- **Given**: Agent 执行过程中需要调用工具（如执行命令、读文件等）
- **When**: 工具被调用
- **Then**:
  - 界面上出现工具调用卡片（group_tool_call 事件）
  - 卡片显示工具名称、入参
  - 工具执行完成后显示结果（group_tool_result 事件）

### AC6: Token 消耗显示
- **Given**: Agent 任务执行中或完成
- **When**: 系统发送 token 使用量事件
- **Then**:
  - 每个 Agent 席位显示 token 输入/输出计数
  - 数值随 group_token_usage 事件更新

### AC7: 多 Agent 辩论完成
- **Given**: 多个 Agent 参与群组辩论
- **When**: 所有 Agent 完成任务
- **Then**:
  - 每个 Agent 的最终回复作为持久化消息出现（group_message_created 事件）
  - 群组运行状态变为 completed
  - 所有流式渲染的席位状态被清除

### AC8: 执行摘要
- **Given**: 群组运行完成
- **When**: 所有 Agent 完成任务
- **Then**:
  - 每个 Agent 消息包含执行摘要信息（token 消耗、执行时长等）

## 3. 测试用例

### Test Case 1: 文本辩论（无工具）
- **输入**: 「请简短讨论：微服务架构 vs 单体架构，哪个更适合初创公司？每个Agent用1-2句话给出观点。」
- **预期**:
  - 2 个 Agent 各自输出观点
  - 思考过程实时流式显示
  - 文本回复实时流式显示
  - Token 计数更新
  - 最终消息持久化

### Test Case 2: 工具调用辩论
- **输入**: 「请执行 ls 命令查看当前工作目录的文件，每个Agent用1句话汇报看到了什么。」
- **预期**:
  - Agent 执行 ls 命令
  - 工具调用卡片出现（显示命令名称、参数、结果）
  - 思考过程实时流式显示
  - 文本回复实时流式显示
  - 最终消息持久化

### Test Case 3: Token 消耗验证
- **输入**: 任意问题触发辩论
- **预期**:
  - 每个 Agent 的 token 输入/输出数值正确显示
  - 数值与 WS 事件中的 tokenIn/tokenOut 一致

### Test Case 4: 多轮对话
- **输入**: 连续发送两条消息
- **预期**:
  - 每条消息触发独立的群组运行
  - 历史消息保留在页面中
  - 新消息滚动到可见区域

## 4. 测试环境

- URL: http://127.0.0.1:9999
- 登录: admin / 88888888
- 测试群组: 验收测试群组 - UI验收测试用