# 技术方案 — Agent 评测中心（Eval Center）

> Branch: `feat/eval-center`. 决策见 `docs/intent/eval-center/DECISIONS.md`。PRD 见 `docs/prd/eval-center/PRD.md`。

## 1. 模块结构

```
src/eval-center/
├── eval-schema.sql      # PG 建表 DDL（14 表 + 扩展 + 索引，已落）
├── eval-db.ts           # pg.Pool 单例 + schema 初始化 + 全部查询函数
├── eval-scoring.ts      # 确定性评分器 + LLM-as-Judge + 加权聚合(置信度补偿)
├── eval-runner.ts       # 评测运行编排：逐用例跑 Agent + 采 Trace 落 PG + 评分
├── eval-query.ts        # SDK query() 包装：迭代事件流 → trace_span
├── eval-drift.ts        # 漂移检测（Embedding 质心 / Prompt hash / 检索 overlap）
└── eval-types.ts        # 共享类型
src/routes/eval-center.ts  # 全部 API 路由（Hono，挂 /api/eval-center）
web/src/pages/EvalCenterPage.tsx  # 前端
web/src/api-eval.ts                # API 客户端
```

## 2. 数据库连接

- 专属 `pg.Pool`（async），独立于主 SQLite `db` 单例。
- env `EVAL_PG_URL`，默认 `postgresql://eval:eval123@localhost:5436/eval_center`。
- `initEvalDb()`：建池 → 执行 `eval-schema.sql`（幂等 CREATE IF NOT EXISTS + 扩展）→ 标记 ready。
- 启动钩子：`index.ts main()` 10857 后 best-effort import + init（失败仅 warn，不阻断主服务）。
- 所有 eval 查询走 `pool.query()` / `pool.connect()` 事务。UUID/JSONB/TEXT[]/NUMERIC 原生类型。

## 3. 评分算法（eval-scoring.ts）

### 3.1 维度模型
Rubric `dimensions: [{name, weight, description, scale, judge_criteria, scorer}]`。`scorer ∈ {deterministic, llm_judge}`。

### 3.2 确定性评分器
复用 `harness-eval.ts scoreAssertion` 的 7 种断言（contains/not_contains/regex/no_error/json_schema/json_path/numeric_range）作为 `deterministic` 维度的判定。维度原始分 = 命中断言占比 × scale。

### 3.3 LLM-as-Judge
对 `llm_judge` 维度，构建 judge prompt（含 Rubric 维度描述 + 1-5 分等级 + CoT 指令 + test_case input/expected/agent_output），调 `sdkQuery(judgePrompt, {model: rubric.judge_model})`，要求返回严格 JSON：
```json
{"reasoning":"...","scores":{"任务完成度":4,"工具选择":3,...}}
```
解析 JSON（容错：正则提取首个 `{...}`）。每维度分 + confidence（judge 是否给出该维度，缺失→confidence=0）。

### 3.4 加权聚合（置信度补偿）
```
归一化: S_norm_i = (S_raw_i / scale_i) × 100
OverallScore = Σ(w_i × S_norm_i × conf_i) / Σ(w_i × conf_i)
```
缺失维度 conf=0 不计入分母，避免静默记 0。pass_rate = passed_cases / total（passed = overall >= rubric.pass_threshold×100）。

## 4. Agent 执行 + Trace（eval-query.ts + eval-runner.ts）

### 4.1 evalQuery 包装
直接调 SDK `query({prompt, options:{model, systemPrompt, maxTurns, allowedTools:[], permissionMode, env, abortController}})`，`for await (const event of conversation)` 逐事件：
- `assistant_text` / `result` → 收集最终 output
- 映射为 trace_span（llm_call/tool_call/decision/error），写 PG `trace_span`（parent_span_id 维护栈）
- 记 token_usage、latency

`sdkQuery` 不暴露事件流且 maxTurns=1 无 tools，故自写包装（满足"全量中间数据存 PG"）。Agent 的 systemPrompt/model/max_turns 取自 `agent_definitions` 表。

### 4.2 eval-runner 流程
```
startEvalRun(config):
  1. 校验 dataset_version.status='published'（否则 400）
  2. INSERT eval_run(pending) + config_snapshot
  3. UPDATE running, started_at=now
  4. for each test_case in version:
     a. INSERT eval_result(pending)
     b. t0=now; agent_output = evalQuery(case.input, agent.systemPrompt, agent.model, maxTurns)
     c. INSERT agent_trace + trace_spans
     d. scores = scoreCase(case, agent_output, rubric, trace)
     e. UPDATE eval_result(completed, dimension_scores, overall_score, is_pass, judge_reasoning)
     f. UPDATE eval_run completed_cases++ / passed_cases++
  5. aggregate: overall_score=avg, pass_rate
  6. UPDATE eval_run(completed)
```
同步执行（MVP 单进程够用）；失败用例可 `retry` 重跑（幂等 UNIQUE(run_id,test_case_id) ON CONFLICT DO UPDATE）。

### 4.3 expected_tool_calls 校验
对照 `trace_span WHERE span_type='tool_call'` 的 name 序列 vs `test_case.expected_tool_calls`，作为"工具选择准确性"维度的确定性输入。

## 5. 路由（src/routes/eval-center.ts）

Hono `<{Variables}>` + authMiddleware（非 admin-only，用户管自己的 project）。从 ctx 取 `user`（authMiddleware 注入）作 owner_id。全部 `/api/eval-center` 前缀。30+ 端点见 PRD §5。错误统一 `{error}` + 状态码。

## 6. 前端（EvalCenterPage.tsx）

- 单页多 tab：项目/数据集/Golden/Rubric/运行/结果/对比/漂移/Trace
- SVG 雷达图（维度分）+ CSS 柱图（总分/pass_rate）自写，零重依赖
- lazy import + Route `/eval-center` + nav-items 加项
- API 客户端 `web/src/api-eval.ts`

## 7. 测试专家 Agent + 验收

- 新建 agent_definition「评测中心测试专家」，system_prompt 指令：跑全部 TC1-TC25 + playwright 截图 + 生成 HTML 报告
- `scripts/eval-center-gate.sh`：login → 串 TC1-TC20 API → 启动 UI 截图 TC21-24
- 截图用 playwright-core + 系统 chrome（/usr/bin/google-chrome --no-sandbox）
- HTML 报告 archify 风格：双主题 + AC 矩阵 + 截图 + SVG 数据流图

## 8. 部署到 9999

worktree build → `cp dist/* ~/deepthink/dist/` + `cp web/dist/* ~/deepthink/web/dist/` → 带 `EVAL_PG_URL` env 重启 9999。PG 容器 `--restart unless-stopped` 已自启。
