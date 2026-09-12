# PRD — Agent 评测中心（Eval Center）

> Branch: `feat/eval-center` · Worktree: `~/deepthink/.worktrees/feat-eval-center`
> 决策依据见 `docs/intent/eval-center/DECISIONS.md`（用户 2026-09-12 确认：PG + 全套功能 + 复用 sdkQuery）

## 1. 产品定位

为 DeepThink Agent 平台提供一套**可审计、可复现、可持续演进**的 Agent 质量评估基础设施。将评测集当作受版本控制的软件制品——有 owner、有变更流程、有发布门禁、有线上回流闭环。**所有数据（数据集、用例、Rubric、运行、Trace、评分、发布日志）持久化在 PostgreSQL**。

## 2. 架构决策（用户确认）

| 项 | 决策 |
|---|---|
| 数据库 | 专属 PostgreSQL（Docker `deepthink-eval-pg`，pgvector:pg16，数据挂载 `/home/me/.deepthink-eval-pg`，重部署不丢） |
| 集成方式 | 自包含 PG 原生子系统：专属 `pg.Pool` 连接（`postgresql://eval:eval123@localhost:5436/eval_center`），PG 原生 schema（UUID/JSONB/TEXT[]/NUMERIC），挂在同一 9999 Hono 服务下 |
| Agent 执行 | 复用 `sdkQuery`，流式事件落 PG 的 `agent_trace`/`trace_span` 表（不落主 SQLite trace 表） |
| 评分 | 确定性评分器（8 种断言）+ LLM-as-Judge（CoT）+ 加权聚合（含置信度补偿） |
| 实现形态 | 单进程 TS 应用内功能全集。**不做**微服务/MQ/Daytona 沙箱池/OTel Collector 架构仪式 |
| 验收 | 测试专家 Agent 全量跑用例 + 截图 + HTML 报告 + bugfix loop |

## 3. 数据模型（PostgreSQL 原生 schema）

完全按用户 PRD schema 落地（见 §3.1–3.14），主键 UUID `DEFAULT gen_random_uuid()`，JSON 字段用 JSONB，数组用 TEXT[]，评分用 NUMERIC。表清单：

1. `eval_project` — 项目
2. `eval_dataset` — 数据集（逻辑容器，指向 latest_version）
3. `eval_dataset_version` — 数据集版本（不可变快照，draft/review/published/deprecated，content_hash SHA-256）
4. `eval_test_case` — 测试用例（input/expected_output/expected_trajectory/expected_tool_calls/tags TEXT[]/difficulty/category/is_golden）
5. `eval_rubric` — Rubric 逻辑实体
6. `eval_rubric_version` — Rubric 版本（dimensions JSONB/judge_prompt/judge_model/pass_threshold/status）
7. `eval_run` — 评测运行（config_snapshot JSONB/overall_score/pass_rate）
8. `eval_result` — 单用例结果（agent_output/dimension_scores JSONB/overall_score/is_pass/judge_reasoning）
9. `agent_trace` — Trace 顶层（一次完整交互，span_count/total_tokens）
10. `trace_span` — Span（span_type CHECK llm_call/tool_call/retrieval/agent_handoff/decision/error，input_data/output_data JSONB，parent_span_id 自引用）
11. `eval_publish_log` — 版本发布审计
12. `eval_dataset_clone_log` — 克隆关系
13. `eval_golden_annotation` — Golden Set 双人标注 + 仲裁（§3.2 生命周期）
14. `eval_drift_report` — 漂移检测报告（§3.2.2）

## 4. 功能需求

### 4.1 数据集管理

| ID | 功能 | 验收标准 |
|---|---|---|
| F1.1 | 创建数据集（名称/类型 golden,probe,red_team,regression/所属项目） | AC1.1 POST 创建返回 dataset_id，GET 列表含新项 |
| F1.2 | 导入用例（JSONL/CSV 批量 + 手动逐条） | AC1.2 JSONL 批量导入 N 条，count=N；手动创建 1 条可查 |
| F1.3 | 编辑用例（单条 + 批量编辑 tags/category/difficulty） | AC1.3 编辑后 GET 反映新值；批量编辑 M 条全更新 |
| F1.4 | 软删除用例（status=deprecated，保留审计） | AC1.4 DELETE 后 status=deprecated，列表默认不显示，历史 run 引用仍可查 |
| F1.5 | 用例搜索（tags/category/difficulty/状态/关键词） | AC1.5 按 tag 过滤返回子集；关键词命中 input_text |
| F1.6 | 多版本（draft→review→published→deprecated，content_hash 寻址） | AC1.6 同内容二次发布 content_hash 相同；published 后不可编辑用例 |
| F1.7 | 版本间 Diff（新增/修改/删除用例） | AC1.7 v1→v2 diff 返回 added/modified/removed 列表 |
| F1.8 | 完整克隆 / 部分克隆（按 tags/category 筛选）/ Fork | AC1.8 full 克隆新 dataset+version+全用例；partial 按 tag 子集；fork 记 clone_log |
| F1.9 | 版本发布管理（publish/rollback/deprecate，记 publish_log） | AC1.9 publish 后 latest_version 更新；rollback 回退 latest；log 记录 |

### 4.2 Golden Set 管理

| ID | 功能 | 验收标准 |
|---|---|---|
| F2.1 | 标记用例为 golden（is_golden=true） | AC2.1 promote 后用例 is_golden=true |
| F2.2 | 双人标注（两独立 expected_output 标注） | AC2.2 两条标注入库，status=review |
| F2.3 | 仲裁（不一致时第三方仲裁，记仲裁结论） | AC2.3 仲裁后 status=resolved，golden 用 expected_output 取仲裁值 |
| F2.4 | 版本化冻结（golden 子集随 dataset_version 冻结） | AC2.4 published version 的 golden 用例集不可变 |
| F2.5 | 漂移检测（输入分布 Embedding 质心 / Prompt 模板 hash / 检索语料 overlap） | AC2.5 触发漂移检测生成 drift_report，含三类信号分；月度可触发 |

### 4.3 评测运行

| ID | 功能 | 验收标准 |
|---|---|---|
| F3.1 | 配置选择（数据集版本必须是 published + Agent + LLM 模型 + Rubric + 运行参数） | AC3.1 选 draft 版本被拒 400；config_snapshot 落库 |
| F3.2 | 评测执行（配置校验→逐用例跑 Agent→采 Trace→评分→聚合） | AC3.2 run completed，total_cases=N，completed_cases=N |
| F3.3 | Trace 全量持久化（LLM 调用/工具调用/检索/决策落 trace_span） | AC3.3 每用例 agent_trace + trace_span 可查，span 树 parent_span_id 可重建 |
| F3.4 | 多维度评分（Rubric 各维度 1-5 分，LLM-as-Judge CoT） | AC3.4 eval_result.dimension_scores 含各维度分；judge_reasoning 非空 |
| F3.5 | 总体评分（加权聚合 `OverallScore = Σ(w×s×conf)/Σ(w×conf)`，缺失维度置信度补偿） | AC3.5 overall_score 计算正确；缺失维度不静默记 0 |
| F3.6 | 多模型对比（同数据集+Agent，多 LLM 并行运行，对比报告） | AC3.6 compare API 返回各运行维度分 + Win/Loss/Tie |
| F3.7 | 运行可恢复（中断/失败用例可重跑，幂等） | AC3.7 失败用例重跑后 status=completed，result 更新 |

### 4.4 版本发布管理

| ID | 功能 | 验收标准 |
|---|---|---|
| F4.1 | 数据集发布门禁（Golden Set 回归评测，劣化阈值阻断） | AC4.1 新版本劣化超阈值→publish 拒绝 400 |
| F4.2 | 用例覆盖度检查 + 格式校验 | AC4.2 缺必填字段的用例→publish 拒绝 |
| F4.3 | Rubric 语义版本化（major.minor，权重变更算 major） | AC4.3 publish rubric version+1，权重变 major bump |
| F4.4 | 回滚（数据集/Rubric 回滚到任意历史版本） | AC4.4 rollback 后 latest_version 回退，publish_log 记录 |

### 4.5 Web UI

| ID | 功能 | 验收标准 |
|---|---|---|
| F5.1 | 数据集管理页（列表/创建/编辑用例/版本/Diff/克隆） | AC5.1 页面渲染，可创建+导入+编辑+Diff 可视化 |
| F5.2 | Golden Set 页（标注/仲裁/标记） | AC5.2 双人标注 UI，仲裁流程可视 |
| F5.3 | Rubric 页（CRUD/维度/版本） | AC5.3 创建 Rubric+维度+权重，发布版本 |
| F5.4 | 评测运行页（配置选择+执行+状态） | AC5.4 选数据集+Agent+模型+Rubric 启动运行，状态轮询 |
| F5.5 | 结果页（用例级明细 + 雷达图 + 总分柱图，SVG/CSS 自写） | AC5.5 雷达图渲染各维度，柱图总分，用例明细表 |
| F5.6 | 多模型对比页（维度雷达叠加 + Win/Loss/Tie） | AC5.6 多运行雷达叠加对比 |
| F5.7 | Trace 回放页（span 树 + 输入输出） | AC5.7 span 树可展开，input/output 可查 |
| F5.8 | 漂移报告页 | AC5.8 三类漂移信号分可视化 |

## 5. API 设计

前缀 `/api/eval-center`，全部走 Hono authMiddleware。

- 数据集：`POST/GET /datasets`、`GET /datasets/{id}`、`GET /datasets/{id}/versions`、`POST /datasets/{id}/versions`（发布）、`POST /datasets/{id}/clone`、`GET /datasets/{id}/diff?from=&to=`、`POST /datasets/{id}/rollback/{ver}`
- 用例：`POST/GET /test-cases`、`PUT/DELETE /test-cases/{id}`、`POST /test-cases/import`（JSONL/CSV）、`POST /test-cases/batch-edit`
- Golden：`POST /golden/{id}/promote`、`POST /golden/{id}/annotations`（标注）、`POST /golden/{id}/arbitrate`
- Rubric：`POST/GET /rubrics`、`POST /rubrics/{id}/versions`、`POST /rubrics/{id}/rollback/{ver}`
- 运行：`POST /eval-runs`、`GET /eval-runs/{id}`、`GET /eval-runs/{id}/results`、`GET /eval-runs/{id}/traces/{resultId}`、`GET /eval-runs/compare?ids=a,b`、`POST /eval-runs/{id}/retry/{caseId}`
- 漂移：`POST /drift/detect`、`GET /drift/reports`
- 发布门禁：`POST /datasets/{id}/publish-check`

## 6. 测试用例（验收集）

| TC | 场景 | 预期 |
|---|---|---|
| TC1 | 创建 project + dataset(golden) | 200，返回 id |
| TC2 | 批量导入 5 用例（JSONL） | count=5 |
| TC3 | 发布 dataset v1（draft→published） | status=published，content_hash 生成 |
| TC4 | 同内容二次发布 | hash 相同，不产生重复版本 |
| TC5 | 编辑 published 版本用例 | 400 拒绝 |
| TC6 | v1→v2 diff | 返回 added/modified/removed |
| TC7 | full 克隆 | 新 dataset + 全用例 |
| TC8 | partial 克隆（tag=边界） | 仅该 tag 子集 |
| TC9 | promote 用例为 golden | is_golden=true |
| TC10 | 双人标注 + 仲裁 | status=resolved |
| TC11 | 创建 Rubric + 6 维度 + 发布 | version=1.0.0 |
| TC12 | 创建 eval-run（选 published 版本 + Agent + 模型 + Rubric） | run pending→running→completed |
| TC13 | 选 draft 版本建 run | 400 拒绝 |
| TC14 | run 完成后查 eval_result | dimension_scores + overall_score 非空 |
| TC15 | 查 trace_span | span 树可重建 |
| TC16 | 缺失维度置信度补偿 | overall 不为 0，公式正确 |
| TC17 | 多模型对比 | compare 返回 Win/Loss/Tie |
| TC18 | publish 门禁劣化阻断 | 400 |
| TC19 | Rubric rollback | latest_version 回退 |
| TC20 | 漂移检测 | drift_report 含 3 信号分 |
| TC21 | UI 数据集页 | 截图 |
| TC22 | UI 结果页雷达图 | 截图 |
| TC23 | UI 对比页 | 截图 |
| TC24 | UI Trace 回放 | 截图 |
| TC25 | 测试专家 Agent 跑全部 + HTML 报告 | 报告含 25 用例截图 |

## 7. 不做项（显式排除架构仪式，功能不缺）

- 微服务拆分 / RabbitMQ/Kafka / Daytona 沙箱池 / OTel Collector —— 单进程内实现等价功能
- 表分区 / 物化视图（PG 原生 + GIN 索引足够 MVP+ 性能）
- 线上 badcase 自动回流管道（保留 API + 手动回流，自动抓取留后续）

## 8. 交付物

1. 代码：`src/eval-center/`（eval-db/scoring/runner/drift）+ `src/routes/eval-center.ts` + `web/src/pages/EvalCenter/`
2. PG schema：`src/eval-center/eval-schema.sql`（建表 + 扩展 + 索引）
3. 测试专家 Agent 定义 + `scripts/eval-center-gate.sh`
4. 截图（playwright-core + 系统 chrome）
5. HTML 测试报告：`docs/test_report/eval-center/TEST_REPORT.html`
6. 文档：PRD/TECH-SOLUTION/TASK_STATE
