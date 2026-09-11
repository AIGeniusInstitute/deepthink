# Intent — Agent 评测中心（Eval Center）

> 用户原始意图，来自 2026-09-11 飞书消息。原文转写，不做解读。

## 用户原始需求

为 deepthink 系统开发 Agent 评测中心。支持：

1. 数据集管理，支持多版本
2. 评测集管理、golden set 管理
3. 选择数据集和选择 Agent，支持选择大模型
4. 在平台上的评测中心执行自动化评测，给出量化的多维度的评测分，计算总体评分
5. 支持用例集的复制、克隆、编辑、多版本发布管理等等功能
6. 评测过程的运行中间过程的全部数据，全部都要存在 postgreSQL

开发测试完成之后，新创建一个测试专家 Agent，全面测试验收该任务的完成质量。如果遇到 bug，执行 issue 修复流程，Loop 循环，直到全部任务需求通过验收。每个测试通过的用例请截图验收，最终输出完整的带截图的测试报告的 HTML 产物。

## 用户随附的 PRD/技术方案摘要

用户随消息附了一份完整的企业级 Agent 评测中心 PRD 与技术方案，要点：

- 数据模型：Project / Dataset / DatasetVersion / TestCase / GoldenSet / EvaluationConfig / EvalRun / EvalResult / AgentTrace / TraceSpan / Rubric / RubricVersion / eval_publish_log / eval_dataset_clone_log。Schema 用 PG 原生类型（UUID PK、JSONB、TEXT[]、NUMERIC）。
- 数据集：多版本（draft/review/published/deprecated）、内容哈希寻址、版本间 Diff、完整克隆/部分克隆/Fork。
- Golden Set：策展→双人标注→仲裁→版本化→CI 集成→线上回流；漂移检测（输入分布/Prompt 模板/检索语料）。
- 评测运行：配置校验→任务分发→Agent 执行（沙箱隔离）→Trace 采集→评分聚合；加权聚合 `OverallScore = Σ(weight×score×confidence)/Σ(weight×confidence)`；多模型对比。
- 评分：LLM-as-Judge（CoT 强制推理）+ 确定性评分器 + 人工评分器；人机对齐校准（Cohen's Kappa）。
- 架构：微服务（数据集/Rubric/调度/Trace 采集/评分/聚合 6 服务）+ 消息队列（RabbitMQ/Kafka）+ 沙箱池（Docker/Daytona）+ LLM 网关 + PostgreSQL 主存储 + OTel Collector。
- 路线图：Phase 1 基础 6 周 / Phase 2 智能化 6 周 / Phase 3 治理 4 周 / Phase 4 规模化 4 周（合计约 20 周）。

## 工程现实约束（勘察结论）

勘察 DeepThink 现有代码库后发现的硬约束，与上述 PRD 存在冲突，需在 PRD 阶段对齐：

1. **已有评测地基**：`src/harness-eval.ts`（497 行）已实现 8 种断言（contains/not_contains/regex/no_error/json_schema/json_path/numeric_range/llm_judge）、版本快照/diff/promote/rollback、EvalDashboard 前端。表 `harness_versions`/`harness_proposals`/`harness_eval_runs`/`harness_eval_cases` 已存在。**应演进而非重写。**
2. **已有 Trace 基础设施**：三表 `chat_trace_nodes`/`trace_steps`/`trace_tool_calls`，span 树（trace_id/span_id/parent_span_id）+ 64KB 内联 + 大 I/O 落盘 `data/trace-io/`。评测 Trace 应复用，而非新建 agent_trace/trace_span 两张表。
3. **PostgreSQL 与测试目标冲突**：9999 服务跑 SQLite（`DEEPTHINK_DATA_DIR=/home/me/.deepthink-9999`），无 PG 配置。PG 原生类型（UUID/JSONB/TEXT[]）在 SQLite 下 `db.exec` 报错。全仓单 `db` 单例，无第二 PG 连接机制。PG 模式本身未完工（7 处 `json_extract` 运行时崩）。
4. **单进程 TS 应用**：无消息队列、无独立沙箱池、无 OTel Collector。PRD 的 6 服务微服务架构与本仓现实不符。

## 决策点（待用户确认后进入 PRD 详写）

见 `DECISIONS.md`（同目录）。
