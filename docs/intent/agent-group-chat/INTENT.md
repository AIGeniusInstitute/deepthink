# 需求意图：DeepThink 多 Agent 群组协作（Agent Group Chat）与 Pipeline 可追溯执行面板

**版本**: v1.0  
**日期**: 2026-09-21  
**来源**: 用户原始需求  

---

## 用户原始意图

将 DeepThink 从「用户 ↔ 一个 Agent」的单线对话，升级为「用户 ↔ 一群 Agent」的群聊式协作平台。同时，将后台任务执行链路以 Pipeline 节点的形式实时呈现在主对话右侧面板中，每个节点可点开查看完整 Trace，支持从任意节点重跑或回放。

用户期望的核心体验：

1. **群组化**：创建包含多个 Agent 的协作群组，成员来自 Agent Studio
2. **群聊化**：主对话区以微信群/飞书群的形态呈现多 Agent 协作过程
3. **链路可见**：右侧面板实时呈现任务 Pipeline 的节点状态、耗时、成本
4. **全程可追溯**：任意节点可点开查看完整 Trace
5. **可定点重跑与回放**：从任意节点回放或重跑，支持编辑后重跑

## 核心痛点

- **P1 协作不可见**：多 Agent 输出混在单一流中，用户分不清来源
- **P2 过程不可追溯**：中间推理散落在容器日志中
- **P3 试错成本极高**：链路中任一节点失败需全部重跑

## 产品命题

把「用户 ↔ 一个 Agent」升级为「用户 ↔ 一群 Agent」的群聊式协作，并提供 Pipeline 执行面板实现全过程可观测。

## 技术约束

- 复用现有 Orchestrator–Workers 编排引擎
- 复用现有 Team Graph 事件系统
- 复用 Agent Studio 的 Agent 定义与版本管理
- 扩展 registered_groups 而非新建独立实体
- 遵循 Surgical Changes 原则，最小化对既有代码的侵入

## 部署环境

- 源代码：~/deepthink
- K8s 集群：kind deepthink (http://192.168.1.25:30080)
- 数据库：PostgreSQL（pgvector/pgvector:pg16）
- 模型服务：dashscope deepseek-v4-pro

## 参考

- 用户提供的完整 PRD 文档（含 15 节详细需求规格）
- DeepThink v1.2.0 现有架构