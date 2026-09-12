# Task State — Agent 评测中心（Eval Center）

## 任务
构建生产级 Agent 评测中心：数据集多版本管理 + Golden Set + Rubric 多维评分 + 选 Agent+模型自动评测 + 多维评分与总分 + 用例克隆/编辑 + 多版本发布 + 全部中间运行数据落 PostgreSQL（Docker 本机部署，数据盘挂载本机磁盘）。

## 状态：✅ 全部完成

## 交付物

### 后端（`src/eval-center/` + `src/routes/eval-center.ts`）
- **eval-db.ts**：PG Pool（EVAL_PG_URL）+ 14 表 schema（projects/datasets/dataset_versions/test_cases/golden_annotations/rubrics/rubric_versions/eval_runs/eval_results/agent_traces/trace_spans/drift_reports/eval_publish_log + pgvector HNSW），所有 CRUD 函数。
- **eval-scoring.ts**：确定性断言 8 种（contains/not_contains/regex/no_error/json_schema/json_path/numeric_range/tool_call_match）+ LLM-as-Judge（CoT 1-5 scale）+ 置信度补偿加权聚合 `OverallScore = Σ(w×S_norm×conf)/Σ(w×conf)`。
- **eval-runner.ts**：startEvalRun 逐 case 执行（createResult→evalQuery→scoreCase→updateResult）+ 聚合。
- **eval-query.ts**：SDK query() 包装，事件流落 trace_span。
- **eval-drift.ts**：embedding centroid 余弦距离 + prompt hash + retrieval top-k 重叠。
- **eval-center.ts 路由**：44+ 端点，挂载 /api/eval-center，authMiddleware 鉴权。

### 前端（`web/src/pages/EvalCenterPage.tsx` + `web/src/api/eval-center.ts`）
- 7 tab：概览（统计+最近运行）/ 数据集（卡片+版本+发布/回滚/克隆）/ 用例（CRUD+Golden）/ 评分标准（维度+发布）/ 运行（发起+列表）/ 结果分析（SVG 雷达+CSS 柱图+Judge 推理+断言+Trace）/ 漂移检测。
- 接入 App.tsx（lazy + /eval-center 路由）+ nav-items.ts（FlaskConical 图标）。

### 部署
- **PG 容器**：`evalpg-5436`（pgvector/pgvector:pg16），bind mount `/home/me/.deepthink-eval-pg → /var/lib/postgresql/data`，端口 5436，unless-stopped。数据落本机磁盘，重新部署不丢。
- **9999 服务**：watchdog 守护，env 注入 EVAL_PG_URL + DEEPTHINK_WEB_DIST_DIR。
- **CI 门禁**：`scripts/eval-center-gate.sh`（17 后端用例，exit 0）。

## 验收结果
- **后端**：17/17 PASS（TC1-TC17，真实 PG + 真实 session cookie）。
- **前端**：11/11 PASS（UI-1~UI-11，playwright-core + Chrome 截图）。
- **真实模型联调**：glm-5.2，运行 68ddd18c 总分 75，2/2 通过，trace 落库 span_count + tokens。
- **Bug 修复**：1 个（Drift 评分 toFixed 崩溃，PG NUMERIC 返回字符串），已修复，零回归。

## 关键决策
1. **独立 PG 子系统**：eval-center 用专用 pg.Pool（EVAL_PG_URL），不侵入主 SQLite/PG，零侵入主业务。
2. **PG 容器改名 evalpg-5436**：避开桌面 DeepThink 应用 `deepthink-*` 前缀清理逻辑（曾致容器被 fast shutdown）。
3. **HTTP self-call 复用 SDK query**：不重构主 turn_start，外科手术原则。
4. **置信度补偿聚合**：低置信维度（judge 未给分）权重自动衰减，避免拉偏总分。
5. **drift_score Number() 强转**：PG NUMERIC → JSON 是字符串，前端 toFixed 须先 Number()。

## 文档
- PRD：`docs/intent/eval-center/`（用户原始需求）
- 测试报告：`docs/test_report/eval-center/TEST_REPORT.html`（archify 风格，28/28，base64 内嵌 21 截图）
- Issue：`docs/issues/2026-09-12-eval-center-drift-tofixed-crash.md`（8 节结构）
