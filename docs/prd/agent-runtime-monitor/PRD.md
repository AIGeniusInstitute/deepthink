# PRD — Agent 运行监控模块（Agent Runtime Monitor）

| 项 | 值 |
|---|---|
| 需求名 | `agent-runtime-monitor` |
| 来源意图 | [`docs/intent/agent-runtime-monitor/INTENT.md`](../../intent/agent-runtime-monitor/INTENT.md) |
| 目标实例 | `http://127.0.0.1:9999`（生产隔离实例，SQLite 后端） |
| 验收账号 | `admin / 88888888` |
| 日期 | 2026-10-13 |

---

## 1. 背景

DeepThink 的运行时 trace 数据**已经存在但高度割裂**：对话/IM 的 trace 落在 `chat_trace_nodes`，
图编排（Swarm / Workflow / Orchestrator）落在 `graph_runs` + `graph_node_runs`，
Loop Engineering 落在 `loop_runs`，监督者落在 `supervisor_sessions`，定时任务落在 `task_run_logs`……
每一处都有自己的读接口（`/api/groups/:jid/trace/*`、`/api/graph/runs/*`、`/api/loops/:id/trace`），
但**没有一个地方能回答"现在系统里有哪些 agent 在跑、跑得怎么样、最近趋势如何"**。

开放平台 AaaS（`/v1/agents/:id/chat/completions`）更极端：每次调用**只在 `usage_records` 落一行用量**，
**没有状态、没有错误、没有轨迹**，所以即便是最强的"agent 服务"也没有可监控的运行记录。

本需求交付一个**统一的 Agent 运行监控模块**：把全系统可观测的运行数据聚合成一个「运行」抽象，
提供总览 KPI、趋势汇总、统一运行列表、单次运行的时间线轨迹；并为开放平台 AaaS 补齐运行记录埋点。

---

## 2. 数据源审计（勘察结论，全部经 live DB 核实）

勘察时间 2026-10-13，样本为 `~/.deepthink-9999/db/messages.db`。

### 2.1 纳入监控的运行来源（8 个）

| # | 来源 key | 中文标签 | 主表 | 轨迹表 | 状态字段 | live 行数 |
|---|---------|---------|------|--------|---------|----------|
| S1 | `chat` | 对话 / IM Agent | `chat_trace_nodes`（`node_type='turn' AND parent_node_id IS NULL` 为一次运行） | `chat_trace_nodes` 子树 + `trace_tool_calls` | `status` = done/running/failed | 12005 / 23878 |
| S2 | `graph` | 图编排（Swarm / Workflow） | `graph_runs` | `graph_node_runs` | `status` = pending/running/paused/completed/failed/cancelled | 15 / 43 |
| S3 | `open-platform` | 开放平台 AaaS | **`open_platform_runs`（本次新增）** | `trace_steps`（`trace_id = run_id`） | 新增 `status` = pending/running/completed/failed | 0 → 本次埋点后产生 |
| S4 | `loop` | Loop Engineering | `loop_runs` | `loop_trace_nodes` + `loop_iterations` | `status` = pending/running/reviewing/iterating/completed/failed/cancelled | 0 |
| S5 | `supervisor` | 监督者（Supervisor） | `supervisor_sessions` | `supervisor_decisions` | `status` = active/paused/completed/failed/aborted | 0 |
| S6 | `task` | 定时任务运行 | `task_run_logs` | 自身（每行即一次运行） | `status` | 0 |
| S7 | `sandbox` | 沙箱代码执行 | `sandbox_executions` | 自身 | `status` + `exit_code` | 0 |
| S8 | `harness-eval` | Harness 评测运行 | `harness_eval_runs` | 自身（+ `trace_node_root_id`） | `status` = pending/running/completed/failed | 0 |

### 2.2 明确排除的来源与理由

| 来源 | 排除理由 |
|------|---------|
| Eval Center `agent_trace` / `trace_span` | `src/eval-center/eval-db.ts:19,32` 是**独立 `pg.Pool`**，表只在 PostgreSQL 建；目标实例是 SQLite，`~/.deepthink-9999/db/messages.db` 中**不存在这两张表**。Eval Center 已有自己的轨迹 UI（`/eval-center` → `ResultsTab`）。 |
| `trace_steps` 作为独立来源 | 它是**步骤明细**（thinking/compact/llm_call/…），不是运行；live 数据仅 161 行且绝大多数 `status='running'` 无 `ended_at`。作为 S1/S3 的轨迹明细并入。 |
| `flm_events` / `sw_events` | 是事件流而非运行记录；FLM 已有自己的控制台页面（`/feedback-learning`）。 |
| `tool_call_audit_log` / `webhook_calls` | 治理审计，非 agent 运行。 |

### 2.3 关键字段语义勘误（避免踩坑）

- **`chat_trace_nodes.session_id` 恒为 NULL**（`src/flm/flm-collect.ts:11` 有实测注释）。会话对齐必须用 `chat_jid` + 时间窗口，**不能**用 `session_id`。
- `chat_trace_nodes` 的 `id` 是 **per-jid 自增**（`UNIQUE(chat_jid, id)`），跨 jid 不唯一，运行 id 必须带 `chat_jid` 前缀。
- `graph_node_runs.status` 的 CHECK 在 v57 迁移后含 `cancelled`（`src/db.ts:2403`），早期 DDL 注释不含。
- 状态词表**每源不同**（`done` vs `completed` vs `success`），必须归一到统一词表后才能聚合。

---

## 3. 统一「运行」抽象（本次核心设计）

所有来源归一为一个 `RunSummary`：

```ts
type RunSource =
  | 'chat' | 'graph' | 'open-platform' | 'loop'
  | 'supervisor' | 'task' | 'sandbox' | 'harness-eval';

type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'pending';

interface RunSummary {
  runId: string;            // "{source}:{nativeId}"，chat 为 "chat:{chat_jid}#{nodeId}"
  source: RunSource;
  title: string;            // 目标 / prompt / turn 标题
  workspace: string;        // group_folder 或 chat_jid
  workspaceLabel: string;   // chats.name / registered_groups.name 解析后的可读名
  ownerUserId: string | null;
  ownerUsername: string | null;
  agentId: string | null;   // agent_definitions.id
  agentName: string | null;
  status: RunStatus;        // 归一化
  rawStatus: string;        // 原表原值（可追溯）
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: string | null;
  stale: boolean;           // status==='running' 且已运行超过阈值 → 疑似卡住
}
```

**状态归一映射表**（P0 正确性要求）：

| source | → running | → success | → failed | → cancelled | → pending |
|---|---|---|---|---|---|
| chat | running | done | failed | — | — |
| graph | running, paused | completed | failed | cancelled | pending |
| open-platform | running | completed | failed | — | pending |
| loop | running, reviewing, iterating | completed | failed | cancelled | pending |
| supervisor | active, paused | completed | failed | aborted | — |
| task | running | success, done | failed, error | cancelled | pending |
| sandbox | running | success, ok, completed | failed, error, timeout | — | pending |
| harness-eval | running | completed | failed | — | pending |

---

## 4. 功能需求与验收标准

### F1 — 总览 KPI

**需求**：页面顶部展示所选时间窗（24h / 7d / 30d，默认 7d）内的关键指标：

| KPI | 定义 |
|---|---|
| 运行中 | `status='running'` 的运行数（跨全部来源） |
| 疑似卡住 | `status='running'` 且 `now - startedAt > 30min` 的运行数（**警示色高亮**） |
| 总运行数 | 窗口内全部运行数 |
| 成功率 | `success / (success + failed)`，无终态运行显示 `—` |
| 成功数 | `status='success'` |
| 失败数 | `status='failed'` |
| 总 tokens | `sum(inputTokens + outputTokens)` |
| 总成本 | `sum(costUsd)`，无成本数据时显示 `—` |
| P95 耗时 | 已完成运行的耗时 95 分位 |

> **实现说明（2026-10-13）**：卡片共 **8** 张 = 运行中 / 疑似卡住 / 成功 / 失败 / 成功率 / Token / 总成本 / P95 耗时。
> 「总运行数」不单独占卡片，而是作为「运行中」卡片的副标题（`共 N 次运行`）——它是个恒增的计数，
> 单独占一张卡的边际信息量最低。首版实现漏渲染了已算好的 `kpis.costUsd`（API 有、页面没有），
> 已补齐；校验方式见 [`TEST_CASES.md`](./TEST_CASES.md) 的 UC-02（UI 断言 8 个标签齐全）。

**验收标准**
- AC-F1.1 8 个 KPI 卡片全部渲染，数值来自 `GET /api/runtime-monitor/overview`，**不硬编码**。
- AC-F1.2 KPI 的「运行中」「总运行数」与直接 SQL 查询结果**一致**（见 TEST_CASES T1）。
- AC-F1.3 切换 24h/7d/30d 窗口后，KPI 数值**随之变化**且与 SQL 一致。
- AC-F1.4 「疑似卡住」数 > 0 时卡片呈警示色。

### F2 — 趋势汇总

**需求**：按时间桶（24h → 小时桶，7d/30d → 天桶）展示运行数、失败数、token、成本的趋势；另按来源维度给出分布。

**验收标准**
- AC-F2.1 趋势图渲染折线/柱状，x 轴为时间桶，与 `GET /api/runtime-monitor/trend` 返回的桶一一对应。
- AC-F2.2 桶内运行数之和 == 同窗口 KPI 总运行数（除窗口边界截断）。
- AC-F2.3 来源分布展示 8 个来源（有数据的显示数值，无数据显示 0）。
- AC-F2.4 无数据的时间桶**不塌陷**（x 轴连续，缺桶补 0）。

### F3 — 统一运行列表

**需求**：一张跨全部来源的运行列表，列：开始时间 / 来源 / 标题 / 工作区 / Agent / 状态 / 耗时 / tokens / 成本。
支持筛选：来源（多选）、状态、时间范围、关键词（标题/工作区）；支持分页（默认 20/页）。

**验收标准**
- AC-F3.1 列表默认按 `startedAt` 倒序，首屏 20 条。
- AC-F3.2 按来源筛选后，列表**只含**该来源的运行，且条数 == SQL 计数。
- AC-F3.3 按状态筛选（尤其 `failed`）生效且计数一致。
- AC-F3.4 分页可翻到第 2 页，条目不重复、不丢失；`total` 正确。
- AC-F3.5 关键词搜索命中标题或工作区。
- AC-F3.6 空结果时展示空状态，不报错。
- AC-F3.7 列表行点击进入详情（F4）。

### F4 — 单次运行详情与轨迹时间线

**需求**：点击列表任一行，展示该次运行的完整信息 + **轨迹时间线**（该次运行内部的步骤链路：节点类型、标题、状态、起止时间、耗时、tokens、输入/输出摘要）。

**验收标准**
- AC-F4.1 详情展示 `RunSummary` 全部字段。
- AC-F4.2 轨迹时间线条目数 == 该运行在轨迹表中的实际行数（S1 为 turn 子树 + 时间窗内 tool call；见 T4）。
- AC-F4.3 时间线按 `startedAt` 升序，父子层级（若有 `parentSpanId`）可辨识。
- AC-F4.4 失败运行展示 error 文本。
- AC-F4.5 打开详情不整页刷新（抽屉/面板），关闭后列表滚动位置保持。

### F5 — 开放平台 AaaS 运行记录埋点（决策 A）

**需求**：新增 `open_platform_runs` 表，在 `src/open-platform/agent-service.ts` 的 `runAgent()` / `streamAgent()` 中记录每次调用的运行记录：

- 运行开始即插入 `status='running'` 行；成功/失败/流中断时更新为终态
- 记录：`agent_id`、`user_id`、`model`、`status`、`started_at`、`ended_at`、`duration_ms`、`input_tokens`、`output_tokens`、`cost_usd`、`num_turns`、`error`、`request_summary`、`response_summary`、`trace_id`
- 埋点写入**不得影响** AaaS 主链路：任何写库异常仅 `logger.warn`，不抛给调用方

**验收标准**
- AC-F5.1 调用一次 `POST /api/open-platform/debug/agent`（或 `/v1/agents/:id/chat/completions`）后，`open_platform_runs` **新增一行**且 `status='completed'`。
- AC-F5.2 该行 `input_tokens`/`output_tokens`/`cost_usd`/`num_turns` 与同一调用产生的 `usage_records` 行**一致**（同源 SDK result）。
- AC-F5.3 运行**开始之后**失败（上游报错 / 超时 / 流提前关闭）时落 `status='failed'` 且 `error` 非空。
  > **勘误（2026-10-13 实测）**：原表述举例「无效 agent id」，但被拒请求（404 `Agent not found` / 403 `You do not have access`）
  > **不会**落行 —— 运行记录在 `resolveAgent` 通过之后才建（`agent-service.ts:256`），被拒的请求没有运行过，留痕只会污染监控。
  > 实测：无效 agent id 与越权调用，`open_platform_runs` 行数均 +0。详见 [`TEST_CASES.md`](./TEST_CASES.md) 的 T5 勘误。
- AC-F5.4 监控页「开放平台」来源筛选能查到上述运行，且详情时间线非空。
- AC-F5.5 埋点异常不影响 AaaS 返回（可用单测注入失败验证）。
- AC-F5.6 `open_platform_runs` 不影响既有 `usage_records` 计费结果（计费仍以 `usage_records` 为准）。

### F6 — 实时刷新

**需求**：运行中状态与 KPI 自动刷新（默认 5s 轮询）；页面切到后台时暂停轮询。

**验收标准**
- AC-F6.1 页面停留 15s 内至少自动发起 2 次刷新请求（可从网络面板/日志观察）。
- AC-F6.2 手动刷新按钮可用。
- AC-F6.3 `document.hidden` 时不再轮询。

### F7 — 权限与隔离

**需求**：沿用平台 RBAC。admin 可见全部运行；member **只能看到自己有权访问的工作区的运行**，不得越权看到他人运行。

**验收标准**
- AC-F7.1 未登录访问 `/api/runtime-monitor/*` 返回 401。
- AC-F7.2 admin 看到的运行总数 == 全量 SQL 计数。
- AC-F7.3 非 admin 用户（如新建测试 member）看到的运行集合是 admin 结果的**子集**，且不包含他人 `chat_jid`/`group_folder` 的运行。
- AC-F7.4 直接按他人 runId 请求详情返回 404/403（不得返回数据）。

### F8 — 导航入口

**需求**：新增 `/runtime-monitor` 页面路由与左侧导航入口「运行监控」。

**验收标准**
- AC-F8.1 左侧导航出现「运行监控」条目，点击进入 `/runtime-monitor`。
- AC-F8.2 移动端底栏 / 响应式布局可用。
- AC-F8.3 刷新 `/runtime-monitor` 直达该页（不 404）。

---

## 5. 非功能需求

| 项 | 要求 |
|---|---|
| NFR-1 | `GET /api/runtime-monitor/runs` 在 12005 行 `chat_trace_nodes` 规模下 P95 < 500ms |
| NFR-2 | 双后端兼容：SQLite 与 PostgreSQL 均可用（`src/sqlite-compat.ts` + `src/sql-translator.ts` 路径），不使用 SQLite 专有语法 |
| NFR-3 | 缺表/空表来源**降级为空集**，不 500（目标实例上 S4–S8 共 5 个来源为 0 行） |
| NFR-4 | 新增表必须 bump `src/db.ts` 的 `SCHEMA_VERSION` 并附迁移语句 |
| NFR-5 | `make typecheck` + `make test` 全绿；新增核心能力同步进 `make test-smoke` 清单 |
| NFR-6 | 前端不引入新依赖（复用已有 `recharts`） |

---

## 6. 交付物清单

| 交付物 | 路径 |
|---|---|
| 后端聚合模块 | `src/runtime-monitor/`（新目录） |
| 后端路由 | `src/routes/runtime-monitor.ts`（新）+ `src/web.ts` 挂载 |
| 新表 | `open_platform_runs`（`src/db.ts`） |
| AaaS 埋点 | `src/open-platform/agent-service.ts` |
| 前端页面 | `web/src/pages/AgentRuntimeMonitorPage.tsx` |
| 前端 store | `web/src/stores/runtime-monitor.ts` |
| 前端组件 | `web/src/components/runtime-monitor/*` |
| 路由/导航 | `web/src/App.tsx`、`web/src/components/layout/nav-items.ts` |
| 测试 | `tests/runtime-monitor.test.ts`、`tests/units/runtime-monitor-*.test.ts` |
| 测试报告 | `docs/test_report/agent-runtime-monitor/` |

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| chat 运行无权威"运行"边界（无 session_id） | 列表口径可能有歧义 | 以 `node_type='turn' AND parent_node_id IS NULL` 为运行根，且文档明示口径 |
| 8 个来源中 5 个 live 为 0 行 | 无法用真实数据验收 | 隔离实例中通过真实调用生成（open-platform / task / loop / supervisor / sandbox），并在测试用例中标注数据构造方式 |
| AaaS 埋点侵入热路径 | 可能拖慢或影响 AaaS | 埋点全 try/catch 吞异常；不 await 阻塞主链路（终态更新 fire-and-forget + warn） |
| 跨源 UNION 查询在 PG 下方言差异 | PG 模式报错 | 仅用两后端通用语法（`||` 拼接、`CASE WHEN`、`CAST`），跑 `make test` 兜底 |
| 老数据 `ended_at` 为空导致耗时统计失真 | 趋势图失真 | 耗时/成本仅对"已完成且有 ended_at"的运行计入 P95，UI 标注样本量 |
