# 决策点 — Eval Center MVP 范围与架构

> 勘察现有代码库后，发现用户随附 PRD 与 DeepThink 工程现实存在 3 处硬冲突。按"Think Before Coding"原则，进入 PRD 详写前需对齐 3 个决策。下面给出我的推荐方案 + 理由，请你确认或调整。

## 决策 1：数据库后端 —— SQLite 兼容双后端（强烈推荐）

### 冲突
- PRD 要求"全部数据存 PostgreSQL"，且 Schema 用 PG 原生类型（UUID/JSONB/TEXT[]/NUMERIC）。
- 现实：9999 服务跑 SQLite（`DEEPTHINK_DATA_DIR=/home/me/.deepthink-9999`），无 PG。PG 原生类型在 SQLite 下 `db.exec` 直接报错。全仓单 `db` 单例无第二连接。PG 模式未完工（7 处 `json_extract` 运行时崩）。
- 若做成 PG-only：**评测中心在你指定的测试目标 9999 上起不来，"截图验收"无从做起**。

### 推荐方案
**用 SQLite 兼容类型建表**（TEXT 作主键/JSON、NUMERIC、不 用 TEXT[] 改 TEXT JSON），与现有 `harness_eval_cases` 表一致（它就是 `case_id TEXT PK` / `assertions_json TEXT`）。这套 schema：
- ✅ 在 9999 SQLite 下直接运行，可截图验收
- ✅ 经 `sql-translator.ts` 自动翻译后，在 K8s 云部署 PG 模式下同样运行（simple type swap，已验证路径）
- ✅ "数据持久化在关系型数据库、可查询、可审计"的实质要求被满足
- ⚠️ 偏离字面"PostgreSQL"——但与 DeepThink 全系统一致（全系统都是这套双后端）

**如果你坚持必须 PG-only**：需你提供 PG 连接（`DATABASE_URL=postgresql://...`）并接受评测中心在 9999 上不可测、需另起 PG 服务验证。我不推荐。

→ **请确认：采用 SQLite 兼容双后端？**（默认：是）

---

## 决策 2：MVP 范围 —— 演进现有 harness，交付 Phase 1+2 核心

### 冲突
- PRD 是 4 阶段约 20 周工程（微服务 + MQ + 沙箱池 + OTel + 漂移检测 + CI 门禁 + 多模型对比报告）。
- 单次交付做不完 20 周。微服务架构与单进程 TS 应用现实不符。

### 推荐方案：演进现有 harness，交付一个可端到端跑通、可截图验收的 MVP

**纳入 MVP（核心闭环）：**
| 模块 | 交付内容 | 复用 |
|---|---|---|
| 数据集管理 | 数据集 CRUD、用例 CRUD（input/expected_output/expected_trajectory/expected_tool_calls/tags/difficulty/category）、多版本（draft→published 不可变）、版本 Diff、完整克隆 | 复用 `harness_eval_cases`/`harness_versions` 模式 |
| Golden Set | 在数据集版本内标记 `is_golden` 用例子集 | 新字段，不建独立表 |
| Rubric 管理 | Rubric CRUD、多维度 + 权重、版本化（draft→published） | 新表 `eval_rubric`/`eval_rubric_version` |
| 评测运行 | 选数据集版本 + Agent + LLM 模型 + Rubric → 执行；逐用例跑 Agent、采 Trace、评分、聚合 | 复用 `sdkQuery` + agent-runner IPC + 三表 Trace |
| 多维评分 | 确定性评分器（8 种断言复用 harness-eval）+ LLM-as-Judge（复用 `llm_judge` 断言）+ 加权聚合（含置信度补偿）| 复用 `scoreCaseAsync`/`scoreAssertion` |
| Trace 持久化 | 评测运行的全部中间数据（LLM 调用/工具调用/决策）落 `trace_steps`/`trace_tool_calls` | 复用现有三表 + `chat-trace-persist` |
| 结果与对比 | 用例级结果列表、维度分明细、多运行对比 API | 新表 `eval_run`/`eval_result` |
| Web UI | EvalCenter 页面：数据集/Rubric/运行/结果，雷达图 + 柱图（SVG/CSS 自写）| 复用 `EvalDashboard` 组件模式 |
| 测试专家 Agent | 新建 Agent 跑全部用例 + 截图 + HTML 报告 | 复用 agent 定义 + browser 工具 |

**显式 deferred（P3/P4 治理与规模化，本次不做）：**
- ❌ 双人标注 / 仲裁 / 线上回流闭环
- ❌ 漂移检测（Embedding 质心 / KL 散度 / 检索 overlap）
- ❌ CI 门禁 / 发布阻断
- ❌ 微服务拆分 / 消息队列 / 独立沙箱池 / OTel Collector
- ❌ 多模型并行对比报告（保留 compare API，不做并行调度）
- ❌ 人机对齐 Cohen's Kappa 校准
- ❌ Fork-Merge 工作流（保留完整克隆，不做 fork 分支合并）
- ❌ 部分克隆 case_filter（保留全量克隆，UI 选 case 子集留后续）
- ❌ 表分区 / 物化视图

**理由**：MVP 闭环 = 数据集→版本→Rubric→运行→Trace→评分→对比→UI→测试 Agent，已覆盖用户列的全部核心能力（数据集/多版本/golden/选 Agent+模型/自动化评测/多维度分/总评/克隆编辑/全量中间数据持久化）。P3/P4 是治理增强与规模化，不影响核心闭环可用性。

→ **请确认：MVP 范围如上？有无必须纳入或可裁剪项？**（默认：如上）

---

## 决策 3：Agent 执行模型 —— 复用 sdkQuery 单/少轮

### 冲突
- 现有 `harness-eval.ts` 每用例跑 `sdkQuery`（maxTurns=1，无工具），测的是 prompt 响应质量。
- PRD 要"沙箱中运行 Agent 实例 + 完整工具调用 Trace"。

### 推荐方案
评测运行复用 `sdkQuery` 路径，**支持配置 maxTurns（默认 1，可设多轮）+ 可选启用 MCP 工具集**。Trace 经现有 `stream-processor`/`chat-trace-persist` 自动落 `trace_steps`/`trace_tool_calls`——**不新建 agent_trace/trace_span 表**，复用现有三表（Surgical 原则，避免双轨）。`expected_tool_calls` 断言对照 `trace_tool_calls` 表校验。

不做：独立 Daytona 沙箱池（agent-runner 本身就是容器化隔离，已足够）、消息队列异步分发（MVP 同步执行，逐用例跑，单进程够用）。

→ **请确认：复用 sdkQuery + 现有三表 Trace，不新建 Trace 表？**（默认：是）

---

## 若你确认上述 3 项，我将立即进入

1. 写完整 PRD（含验收标准 + 测试用例）→ `docs/prd/eval-center/`
2. 写技术方案（表设计 + API + 评分算法 + UI）→ `docs/tech_solution/eval-center/`
3. 编码实施 → 落 `docs/task_state/eval-center/`
4. 建测试专家 Agent + 跑用例 + 截图 + 循环 bugfix
5. HTML 测试报告 → `docs/test_report/eval-center/`
6. 合并 `feat/eval-center` 到 main，push origin+github

确认方式：回复"确认"或指出要调整的项即可。
