# 技术方案 — Agent 运行监控模块

| 项 | 值 |
|---|---|
| 需求名 | `agent-runtime-monitor` |
| PRD | [`docs/prd/agent-runtime-monitor/PRD.md`](../../prd/agent-runtime-monitor/PRD.md) |
| 测试用例 | [`docs/prd/agent-runtime-monitor/TEST_CASES.md`](../../prd/agent-runtime-monitor/TEST_CASES.md) |
| 日期 | 2026-10-13 |

---

## 1. 方案总览

三件事：

1. **读侧 —— 统一运行视图**：把 8 个来源的运行数据在 SQL 层 `UNION ALL` 成一张「运行」宽表，
   归一化 `status` 词表，外面套一层筛选/排序/分页。**不新建汇总表，不做 ETL，不改任何现有写入路径**。
2. **写侧 —— 只补一个缺口**：开放平台 AaaS 目前没有任何运行记录，新增 `open_platform_runs` 表 +
   在 `agent-service.ts` 两个执行函数里埋点（状态 + 轨迹 span）。
3. **展示侧 —— 一个新页面**：`/runtime-monitor`，KPI 卡片 + 趋势图 + 统一运行列表 + 运行详情轨迹面板。

设计原则：**读侧零侵入**（现有 6 个来源一个字都不改），**写侧最小侵入**（只碰 AaaS 这一条本就缺失的路径）。

```
                    ┌──────────────── /runtime-monitor (React) ───────────────┐
                    │  KPI 卡片 │ 趋势图(recharts) │ 运行列表 │ 详情轨迹面板     │
                    └───────────────────────┬─────────────────────────────────┘
                                            │ GET /api/runtime-monitor/{overview,runs,runs/:id}
                    ┌───────────────────────▼─────────────────────────────────┐
                    │  src/routes/runtime-monitor.ts  (Hono, authMiddleware)  │
                    │  + 权限过滤：admin 全量 / member 仅可访问工作区            │
                    └───────────────────────┬─────────────────────────────────┘
                    ┌───────────────────────▼─────────────────────────────────┐
                    │  src/runtime-monitor/                                    │
                    │    sources.ts  运行来源注册表（SQL 片段 + 状态映射）        │
                    │    queries.ts  UNION ALL 统一运行视图 / 轨迹查询 / 聚合     │
                    │    types.ts    RunSummary / RunStatus / TraceItem         │
                    └───────────────────────┬─────────────────────────────────┘
                                            │ getDb()
   ┌────────────────────────────────────────▼──────────────────────────────────┐
   │ chat_trace_nodes  graph_runs  open_platform_runs(新)  loop_runs            │
   │ supervisor_sessions  task_run_logs  sandbox_executions  harness_eval_runs  │
   └───────────────────────────────────────────────────────────────────────────┘
                                            ▲ 写入（仅 AaaS 新增）
                    ┌───────────────────────┴─────────────────────────────────┐
                    │ src/open-platform/run-recorder.ts ← agent-service.ts     │
                    │   open_platform_runs(状态/用量/错误) + trace_steps(轨迹)  │
                    └─────────────────────────────────────────────────────────┘
```

---

## 2. 数据层

### 2.1 新表 `open_platform_runs`

追加到 `src/db.ts` 的 `initDatabase()` 尾部（与 v67 `group_seats` 块同构：`try { db.exec(...) } catch { logger.warn }`），
`SCHEMA_VERSION` 由 `'71'` → `'72'`。

```sql
CREATE TABLE IF NOT EXISTS open_platform_runs (
  id            TEXT PRIMARY KEY,          -- runId (uuid)
  agent_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  key_id        TEXT,                      -- 发起调用的 API key（debug 路径为 NULL）
  channel       TEXT NOT NULL DEFAULT 'api', -- 'api' | 'debug' | 'sse'
  model         TEXT NOT NULL DEFAULT 'agent',
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK(status IN ('pending','running','completed','failed')),
  started_at    TEXT NOT NULL,             -- ISO 8601 UTC（与 chat_trace_nodes 同格式）
  ended_at      TEXT,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  num_turns     INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  request_summary  TEXT,                   -- 用户输入，截断 500 字符
  response_summary TEXT,                   -- 最终文本，截断 500 字符
  trace_id      TEXT NOT NULL              -- = id，用于关联 trace_steps
);
CREATE INDEX IF NOT EXISTS idx_opr_started ON open_platform_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_opr_agent   ON open_platform_runs(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_opr_user    ON open_platform_runs(user_id, started_at DESC);
```

**选型理由**
- 独立表而非复用 `usage_records`：`usage_records` 是**计费账本**（幂等、可对账、不可含失败记录），
  而运行记录需要 status/error/request/response，语义不同。混表会让计费账本出现"失败但计费 0"的噪音行。
- 不复用 `graph_runs`：语义不同（graph 是 DAG 编排，AaaS 是单 Agent 调用），强行合并会污染 graph 的状态机与 CHECK 约束。
- `trace_id` 冗余存一份 = `id`，是为了让轨迹查询只用 `trace_steps` 一张表即可（该表本来就按 `trace_id` 索引）。

**轨迹 span** 写入既有 `trace_steps`（`UNIQUE(trace_id, span_id)`，`node_type` 无 CHECK 约束）：
- `chat_jid` **留空** —— 显式不写，避免污染既有 `/api/groups/:jid/trace/*` 与 FLM 的 `trace_steps` 消费方
  （`src/flm/flm-collect.ts:163` 的 `findTraceId` 会按 `chat_jid` 反查）。
- `graph_run_id` / `graph_node_id` **留空**，同理。

### 2.2 追加索引

`chat_trace_nodes` 已有 `idx_chat_trace_jid(chat_jid, started_at)`，`graph_runs` 已有 `idx_graph_runs_status`。
新增的 `idx_opr_*` 覆盖 AaaS。其余来源 live 为 0 行，暂不加索引（避免为 0 行表建索引的投机改动）。

---

## 3. 后端模块 `src/runtime-monitor/`

### 3.1 `types.ts`

```ts
export type RunSource =
  | 'chat' | 'graph' | 'open-platform' | 'loop'
  | 'supervisor' | 'task' | 'sandbox' | 'harness-eval';

export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'pending';

export interface RunSummary { /* 见 PRD §3 */ }

export interface TraceItem {
  spanId: string;
  parentSpanId: string | null;
  nodeType: string;         // turn/tool/subagent/llm_call/...
  title: string | null;
  status: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  tokens: number;
  toolName: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
}
```

### 3.2 `sources.ts` —— 来源注册表（本方案的核心抽象）

每个来源是一条**声明**，而不是一段自定义代码：

```ts
interface SourceDef {
  key: RunSource;
  label: string;                     // '对话 / IM Agent'
  /** 产出统一列的子查询；列名必须与 COLS 对齐 */
  sql: string;
  /** native_id → 详情/轨迹时如何反查 */
  parseNativeId?: (nativeId: string) => Record<string, string>;
}
```

每条 `sql` 都必须 SELECT 出同一组列（缺失的用字面量补 NULL/0）：

```
source, native_id, title, workspace, status, started_at, ended_at,
input_tokens, output_tokens, cost_usd, error, agent_id, owner_user_id, tool_hint
```

**status 归一在 SQL 内用 `CASE WHEN` 完成**（这样外层可以直接 `WHERE status IN (...)`）：

| source | SQL 片段（节选） |
|---|---|
| chat | `node_type='turn' AND parent_node_id IS NULL`；`native_id = chat_jid \|\| '#' \|\| id`；`title = COALESCE(title,'Turn')`；`workspace = chat_jid`；`CASE status WHEN 'done' THEN 'success' ELSE status END`；`output_tokens = tokens`（chat 无 input/output 拆分，统一记在 output 侧并在 UI 标注）；`cost_usd = NULL` |
| graph | `graph_runs`；`native_id = id`；`title = COALESCE(goal_text, definition_id)`；`workspace = group_folder`；`CASE status WHEN 'completed' THEN 'success' WHEN 'paused' THEN 'running' ELSE status END`；tokens/cost 直取；`owner_user_id` 直取 |
| open-platform | `open_platform_runs`；`native_id = id`；`title = COALESCE(request_summary, agent_id)`；`workspace = 'open-platform'`；`CASE status WHEN 'completed' THEN 'success' ELSE status END` |
| loop | `loop_runs`；`title = goal_text`；`CASE status WHEN 'completed' THEN 'success' WHEN 'reviewing' THEN 'running' WHEN 'iterating' THEN 'running' ELSE status END` |
| supervisor | `supervisor_sessions`；`title = goal_text`；`CASE status WHEN 'active' THEN 'running' WHEN 'completed' THEN 'success' WHEN 'aborted' THEN 'cancelled' WHEN 'paused' THEN 'running' ELSE status END` |
| task | `task_run_logs`；`native_id = id`；`title = 'Task ' \|\| task_id`；`workspace = (SELECT group_folder FROM scheduled_tasks t WHERE t.id = task_id)`；`started_at = run_at`；`ended_at = NULL`（只有 duration_ms） |
| sandbox | `sandbox_executions`；epoch→ISO 见 §3.5；`title = language \|\| ' sandbox'`；`CASE WHEN status IN ('success','ok','completed') THEN 'success' WHEN status IN ('failed','error','timeout') THEN 'failed' ELSE status END` |
| harness-eval | `harness_eval_runs`；`title = case_id`；`CASE status WHEN 'completed' THEN 'success' ELSE status END`；`error` 直取 |

> `task` / `sandbox` / `harness-eval` 三个来源的表在目标实例上是 0 行，但**注册表条目照常保留**——
> 每条的实现成本是一行 SQL 片段，成本远低于"以后再加"时重新理解这套抽象的成本。

### 3.3 `queries.ts`

#### `listRuns(filter, pagination)`

```sql
SELECT * FROM (
  <branch open-platform-UNION...>   -- 只拼入 filter.sources 命中的分支
) AS r
WHERE 1=1
  AND (:statuses 为空 OR status IN (...))
  AND (:from 为空 OR started_at >= :from)
  AND (:to   为空 OR started_at <  :to)
  AND (:q    为空 OR title LIKE :q OR workspace LIKE :q)
  AND (:stale 为空 OR (status='running' AND started_at < :staleCutoff))
ORDER BY started_at DESC
LIMIT :limit OFFSET :offset
```

`total` 用同一子查询 + 同样的 WHERE 做 `COUNT(*)`。

**为什么把时间/状态/关键词过滤放外层而不是下推到各分支**：下推需要按分支重复参数占位符，
让 SQL 构造复杂一倍，而收益是省一次 1.3 万行的扫描——在全量基线（chat 78 + graph 15 行运行记录）
下毫无意义。源筛选是唯一下推到分支级（决定拼哪些分支）的过滤条件。

**分页与排序的风险点**：`started_at` 全部是 ISO 8601 字符串，字典序 == 时间序，两种后端都成立。
不同来源的格式必须严格统一为 `YYYY-MM-DDTHH:MM:SS.sssZ`，**否则跨源排序会错**——这是本模块最脆弱的假设，
在 §3.5 用 epoch 换算函数统一保证，并有单测覆盖（`tests/units/runtime-monitor-sources.test.ts`）。

#### `enrich(rows)` —— TS 侧补可读名

取回一页（≤100 行）后，一次性加载三张小表到 Map，避免在 UNION 里做 8 次 JOIN：

```ts
const groupName = new Map(getAllRegisteredGroups().map(g => [g.jid, g.name]));       // jid → 名称
const chatName  = new Map(listChats().map(c => [c.jid, c.name]));                     // jid → 名称
const agents    = new Map(listAllAgentDefinitions().map(a => [a.id, a.name]));        // agent → 名称
const users     = new Map(listUsers().map(u => [u.id, u.username]));
```

解析顺序：`workspaceLabel = groupName.get(workspace) ?? chatName.get(workspace) ?? workspace`。
`agentName` 对 chat 来源额外经 `registered_groups.agent_def_id` 反查（该 jid 的群组绑定了哪个 agent）。

#### `getRun(runId)` / `getTrace(source, nativeId)`

`runId` 形如 `{source}:{nativeId}`，**按第一个 `:` 切分**（chat 的 nativeId 含 `:`，如 `web:main#701`）。

轨迹按来源分派：

| source | 轨迹来源 |
|---|---|
| chat | `WITH RECURSIVE` 取 turn 子树（`parent_node_id`）+ 时间窗内 `trace_tool_calls`，按 `started_at` 升序合并去重 |
| graph | `graph_node_runs WHERE graph_run_id = ?`（含 `parent_node_run_id` 层级、error、tokens、cost） |
| open-platform | `trace_steps WHERE trace_id = ?` |
| loop | `loop_trace_nodes WHERE loop_run_id = ?` |
| supervisor | `supervisor_decisions WHERE session_id = ?` |
| task / sandbox / harness-eval | 单节点轨迹（该运行自身一行即可，返回长度 1 的数组） |

#### `getOverview(windowMs)` / `getTrend(windowMs, bucket)`

在同一个 UNION 子查询上做聚合：

```sql
-- KPI
SELECT
  SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN status='running' AND started_at < :staleCutoff THEN 1 ELSE 0 END) AS stale,
  COUNT(*) AS total,
  SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
  SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS failed,
  SUM(input_tokens + output_tokens) AS tokens,
  SUM(COALESCE(cost_usd,0)) AS cost
FROM (...) AS r WHERE started_at >= :from
```

P95 耗时：取已完成且有 `ended_at` 的 `durationMs` 列表在 TS 侧排序取分位（样本量小，避免后端分位函数的方言差异），
并在响应里带 `durationSampleSize`，UI 标注「样本 N」。

趋势桶：`substr(started_at, 1, 13)`（小时桶 → `2026-10-12T03`）或 `substr(started_at,1,10)`（天桶）。
`substr` 在 SQLite 与 PG 均可用。**空桶由 TS 侧补齐为 0**（AC-F2.4）。

### 3.4 路由 `src/routes/runtime-monitor.ts`

```ts
router.use('*', authMiddleware);

GET /overview?window=24h|7d|30d   → { window, kpis, bySource[], byWorkspace[], trend[], durationSampleSize }
GET /runs?source=&status=&from=&to=&q=&stale=&limit=&offset=  → { runs[], total, limit, offset }
GET /runs/:runId                   → { run, trace[] }
```

挂载：`src/web.ts` 增加 `app.route('/api/runtime-monitor', runtimeMonitorRoutes);`
（与既有 `app.route('/api', monitorRoutes)` 不冲突——后者挂在 `/api` 下，路径为 `/api/status` 等）。

**权限过滤实现**（F7）

```ts
function allowedScope(user: AuthUser): { allJids: string[] | null; userId: string } {
  if (user.role === 'admin') return { allJids: null, userId: user.id };   // 全量
  const jids = getAllRegisteredGroups()
    .filter(g => canAccessGroup(user, g))
    .map(g => g.jid);
  return { allJids: jids, userId: user.id };
}
```

- `allJids === null` → 不加 workspace 过滤
- 否则 → 追加 `AND (workspace IN (:jids) OR (source='open-platform' AND owner_user_id = :userId))`
  （AaaS 运行的 workspace 是常量 `'open-platform'`，因此按 `owner_user_id` 判定归属）

**详情越权**：`getRun` 命中后复用同一 scope 判定，不在范围内返回 404（不返回 403，避免泄露"该 runId 存在"）。

### 3.5 时间归一工具（方言差异的唯一收口点）

`src/runtime-monitor/time.ts`：

```ts
import { isPostgresBackend } from '../sqlite-compat.js';

/** epoch 毫秒列 → ISO 8601 字符串（两种后端语义一致） */
export const epochToIso = (col: string): string =>
  isPostgresBackend
    ? `to_char(to_timestamp(${col} / 1000.0), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    : `strftime('%Y-%m-%dT%H:%M:%fZ', ${col} / 1000.0, 'unixepoch')`;

/** 统一 all-ISO 的时长计算（TS 侧） */
export function durationMs(startedAt: string, endedAt: string | null): number | null;
```

只有 `sandbox_executions.created_at`（INTEGER epoch）走 `epochToIso`，其余来源本来就是 ISO 字符串。
这是全模块**唯一**需要区分方言的地方。

---

## 4. 开放平台 AaaS 埋点

### 4.1 新文件 `src/open-platform/run-recorder.ts`

```ts
export interface RunRecorder {
  runId: string;
  traceId: string;
  onCreate(): void;                                   // INSERT status='running'
  onSdkEvent(event: unknown): void;                   // 采集 tool_use / assistant → trace_steps span
  onResult(event: unknown): void;                     // 取 SDK result 的 usage → 更新用量
  finish(status: 'completed' | 'failed', err?: unknown): void;  // UPDATE 终态 + 收尾 span
}

export function createRunRecorder(opts: {
  agentId: string; userId: string; keyId?: string | null;
  channel: 'api' | 'debug' | 'sse'; model: string; userText: string;
}): RunRecorder;
```

**铁律：recorder 内部所有写库操作整体 `try/catch`，异常只 `logger.warn`。**

理由：AaaS 是被外部 SDK 直接调用的付费接口，监控是**旁路**。任何写库异常都不允许让客户拿到 500。
（对应 AC-F5.5，单测里用 mock 让 `getDb()` 抛错来验证调用方仍正常返回。）

`onSdkEvent` 采集的 span：
- 每个 `stream_event` 里 `content_block_start` 且 `content_block.type === 'tool_use'` → 一条
  `node_type='tool'`，`tool_name = content_block.name`，`span_id = s{n}`
- `result` 事件 → 一条 `node_type='llm_call'`，`tokens = usage.input_tokens + output_tokens`
- `finish()` → 一条 `node_type='turn'` 收尾（闭合整次运行）

> 非流式 `runAgent` 没开 `includePartialMessages`，拿不到 `stream_event`——所以它的轨迹只有
> `llm_call` + `turn` 两条 span。这是**已知且可接受**的差异（流式路径才有工具级可见性），
> 在 UI 与测试报告中明示，不假装两者一致。

### 4.2 `agent-service.ts` 改动点

| 位置 | 改动 |
|---|---|
| `runAgent()` 入口（`resolveAgent` 成功之后） | `const rec = createRunRecorder({...}); rec.onCreate();` |
| `runAgent()` 的 `for await` 循环内 | `rec.onSdkEvent(event)`；`event.type==='result'` 分支里 `rec.onResult(event)` |
| `runAgent()` catch / return / finally | 成功 `rec.finish('completed')`；失败 `rec.finish('failed', err)` |
| `streamAgent()` | 同上（`channel:'sse'`，因为它确实有 `stream_event`，能采到 tool span） |

**关键约束：`resolveAgent` 失败（404/403/400）时不记 run** —— 此时没有真正启动 Agent 运行，
记一行 `failed` 会污染"运行记录"的语义（那是**请求被拒**，不是**运行失败**）。
该路径的拒绝仍由既有 HTTP 状态码表达。

`billAgentResult` 保持原样不动，`usage_records` 仍是计费唯一真相源；`open_platform_runs` 只是**旁路镜像**。
两者由同一次 SDK `result` 事件驱动，因此数值必然一致（AC-F5.2）。

### 4.3 调用方接线

`src/routes/open-platform.ts`（`/v1/agents/:id/chat/completions`）、
`src/routes/open-platform-debug.ts`（`/api/open-platform/debug/agent`）已分别调用
`runAgent` / `streamAgent`，**无需改动**——keyId / channel 通过可选参数传入，默认 `'api'`。
debug 路由传 `channel:'debug'`（用于区分调试台的调用），并传 `keyId: null`。

---

## 5. 前端

### 5.1 新增文件

| 文件 | 说明 |
|---|---|
| `web/src/stores/runtime-monitor.ts` | Zustand store：`overview` / `runs` / `filters` / `page` / `selectedRun` / `trace`；`loadOverview()`、`loadRuns()`、`openRun(runId)`、`setFilter()`；5s 轮询（`document.hidden` 时跳过） |
| `web/src/pages/AgentRuntimeMonitorPage.tsx` | 页面骨架（`PageHeader` + KPI 行 + 趋势区 + 列表 + 详情抽屉） |
| `web/src/components/runtime-monitor/KpiCards.tsx` | 8 张 KPI 卡（复用 `components/ui/card` + `common/Skeletons`） |
| `web/src/components/runtime-monitor/TrendChart.tsx` | `recharts` 组合图（柱=运行数、折线=失败数、次轴=tokens） |
| `web/src/components/runtime-monitor/SourceBreakdown.tsx` | 来源分布条（纯 CSS 横条，不引新依赖） |
| `web/src/components/runtime-monitor/RunsTable.tsx` | 统一运行列表 + 筛选栏（来源多选 / 状态 / 时间窗 / 关键词）+ 分页 |
| `web/src/components/runtime-monitor/RunDetailPanel.tsx` | 详情抽屉（用手写 fixed 侧栏，仓库无 `table.tsx`/drawer 抽象，`sheet` 组件已存在但为表单场景 → 用最简单的一层 fixed 布局）+ 轨迹时间线 |

**复用而非新造**：图表用已装好的 `recharts@^3.7`（`EvalDashboard.tsx` 同款用法）；
时间线布局参考 `components/graph/GanttView.tsx`（纯 SVG 条）但**简化为列表式时间线**——
本模块要展示的是"步骤链路 + 每一步的摘要"，不是甘特对齐，列表更省事也更可读。

### 5.2 路由与导航

- `web/src/App.tsx`：新增 lazy import + `<Route path="/runtime-monitor" element={<AgentRuntimeMonitorPage />} />`
  （放在 `/eval-center` 附近，同属「运行与治理」面）
- `web/src/components/layout/nav-items.ts`：`baseNavItems` 插入 `{ path: '/runtime-monitor', icon: Activity, label: '运行监控' }`

### 5.3 状态色与可读性

| 状态 | 颜色 |
|---|---|
| `running` | teal（主色） |
| `success` | emerald |
| `failed` | red |
| `cancelled` | slate |
| `pending` | amber |

`stale === true` 的行叠加一个红色「疑似卡住」badge + 该行左侧红色竖条。这是本模块**最有运维价值**的信号：
生产基线里 5 条 `running` 的 chat 运行全部始于 2026-10-10 及更早（最老 2026-09-23），
即 `ended_at` 从未回写。UI 必须让它一眼可见。

---

## 6. 测试方案

| 层 | 文件 | 覆盖 |
|---|---|---|
| 单元 · 状态归一 | `tests/units/runtime-monitor-status.test.ts` | 8 个来源 × 全部原值 → 期望归一值（表驱动，穷举） |
| 单元 · 运行 id 编解码 | `tests/units/runtime-monitor-runid.test.ts` | `web:main#701`、`feishu:oc_xxx#12` 含 `:` 的 nativeId 往返 |
| 单元 · 时间归一 | `tests/units/runtime-monitor-time.test.ts` | `epochToIso` 输出严格 `YYYY-MM-DDTHH:MM:SS.sssZ`；跨格式字典序 == 时间序 |
| 单元 · 埋点旁路性 | `tests/units/open-platform-run-recorder.test.ts` | 写库抛错时 `runAgent` 仍正常返回（AC-F5.5） |
| 集成 · 统一查询 | `tests/runtime-monitor.test.ts` | 起临时 SQLite DB 播种 8 个来源各若干行 → 断言 listRuns/overview/trend/getTrace 的计数与顺序 |
| 约束回归 | `make test` / `make test-smoke` | 全量基线不退化 |

`make test-smoke` 清单新增 `tests/runtime-monitor.test.ts`（PRD NFR-5：新增核心能力必须进门禁）。

**先红后绿**：每条新断言在写完实现前先跑一次确认失败（`new-assertions-must-fail-on-old-code` 的教训）。
对纯新增模块，等价做法是：断言先对着"空实现/未挂载路由"跑，确认 404/空结果让它红，再接实现。

---

## 7. 验收路径（与 TEST_CASES 对应）

1. `make build` → `make start-prod PORT=9998`，数据目录由 `~/.deepthink-9999` **复制**
   （不复制则没有 12005 行真实 trace，KPI 全是 0，验收无意义）
2. API 层：`curl` 三个端点 + 等价 SQL 交叉验证（TEST_CASES T1/T3/T4）
3. 生成 AaaS 数据：页面 `/open-platform` 调试台跑一次 Agent → `open_platform_runs` 出现 `completed` 行（T5）
4. UI 层：Playwright 打开 `/runtime-monitor`，逐条走 T1–T10，**每步截图**
5. 回归：`make typecheck` + `make test` + `make test-smoke`（T11）

---

## 8. 风险与取舍（显式记录）

| 取舍 | 决定 | 理由 |
|---|---|---|
| chat 来源的"一次运行"边界 | 以 `turn` 根节点为准 | `session_id` 恒 NULL（`flm-collect.ts:11`），turn 是唯一稳定的运行根 |
| chat 的 tokens 无 input/output 拆分 | 统一落 `output_tokens`，`input_tokens=0`，UI 列头写「tokens」 | 原表只有单个 `tokens` 列，编造拆分是造假数据 |
| 5 个 live 0 行来源是否纳入 | 纳入 | 注册表一条 = 一行 SQL；不纳入则日后接入要重推整个抽象 |
| 是否给 0 行表建索引 | 不建 | 投机优化 |
| AaaS 非流式路径轨迹只有 2 条 span | 明示差异 | `includePartialMessages` 未开，拿不到工具事件；开它会改变 SDK 行为，超出本需求范围 |
| 实时性 | 5s 轮询，不做 WebSocket 推送 | 已有 3 个 WS 事件面（stream/graph/group），再加一套推送的复杂度远超收益；轮询对本场景足够 |
| 是否修 `ended_at` 不回写的老 bug | **本次不修，只在 UI 显式暴露** | 属独立缺陷（涉及 agent-runner 的 turn 收尾），混进本需求会破坏"surgical changes"边界；已在测试报告中作为发现项列出 |
