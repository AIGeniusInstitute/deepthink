# DeepThink 全量重新部署 & 功能验收测试

**日期**：2026-09-13
**来源**：用户飞书消息
**分支**：.worktrees/deepthink-full-verify

## 用户原始意图

把 DeepThink 系统重新编译、构建、打包、部署到 K8s 集群，然后全量验收 DeepThink 全部核心模块功能：

1. 主对话 Agent — 输入消息，查看对话流式输出
2. 新建会话 Tab — 输入消息，监控 Agent 输出
3. 全面回归测试 — 所有核心模块功能

要求：
- 配置第三方模型服务商（DashScope deepseek-v4-pro）
- 每个测试通过的用例截图验收
- 输出完整的带截图测试报告 HTML
- 遇到 bug 执行 issue 修复流程，Loop 循环直到全部通过

## K8s 集群信息

- 集群：kind-desktop
- Namespace：deepthink
- 外部端口：30080
- Pods：2 web-server + 2 agent-runner

## 模型配置

- Provider：DashScope (dashscope.aliyuncs.com)
- Model：deepseek-v4-pro
- Base URL：https://dashscope.aliyuncs.com/apps/anthropic

## 验收范围

1. 登录/认证
2. 主对话 Agent 流式输出
3. 多会话 Tab
4. 文件管理（网盘）
5. Agent Studio
6. 知识库 RAG
7. 协作编排
8. 审批中心
9. 用量统计
10. 策略管理
11. 评测中心
12. 审计日志
13. 连接器市场
14. Skills 市场