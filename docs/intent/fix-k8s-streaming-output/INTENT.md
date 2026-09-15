# Intent: K8s DeepThink 流式输出修复与重新部署

## 用户需求

重新编译、构建、打包、部署 DeepThink 到本机 K8s 集群，修复以下问题：

### Bug 1: Agent 对话无中间流式输出
- Agent 对话输出无中间思考推理、工具调用、技能调用等中间过程流式输出
- 用户只能看到最终回复，缺少中间交互可见性

### Bug 2: 新建会话 Tab 无响应
- 新建 Agent 会话 Tab 后发送消息，Agent 完全无响应

## 验收标准

1. 主对话 Agent 输入消息后能看到：流式输出、思考过程输出、工具调用输出、技能调用输出等中间流式输出
2. 主对话输入框"技能"选择区域选择技能后对话，技能能正常加载到上下文并被执行
3. 新建会话 Tab 后输入消息，Agent 能正常响应输出

## 根因分析

详见 `docs/issues/2026-09-15-agent-streaming-new-chat-fix.md`：

- Bug 1: `processAgentConversation` 的 `wrappedOnOutput` 缺少 `persistTraceNodeFromStreamEvent` 调用
- Bug 2: `processAgentConversation` 缺少分布式调度检查，K8s 环境下任务未被分发到 agent-runner pods

修复已在 main 分支 commit `7536f07`，但 K8s 集群运行的是旧镜像 `deepthink-server:phase2`。

## 执行计划

1. 从最新 main 代码构建 Docker 镜像
2. 加载镜像到 kind 集群
3. 滚动更新 K8s 部署
4. 使用 Playwright 浏览器自动化验收测试