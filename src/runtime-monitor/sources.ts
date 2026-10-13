/**
 * 运行来源注册表 —— 本模块的核心抽象。
 *
 * 每个来源是一条**声明**（一段产出统一列的 SELECT + 若干元信息），而不是一段
 * 自定义代码。新增一个可监控的运行来源 = 加一条注册项，不需要动 `queries.ts`。
 *
 * 注册项产出的列**必须严格对齐 `UNIFIED_COLUMNS`**，缺失的统一用字面量补齐
 * （`0` / `NULL`）。这是 UNION ALL 的前提，写成别的列数会让整条查询报错。
 *
 * 状态归一在 SQL 里用 CASE 完成（而不是取回后在 TS 里映射）：外层要按归一化
 * 状态做 `WHERE status IN (...)`，如果映射发生在 TS 侧，筛选与分页就会打架
 * （先分页再过滤 ⇒ 每页条数对不上）。
 *
 * 纯 SQL 构造，不依赖运行中的 DB，便于单测直接断言生成的 SQL 片段。
 */

import type { RunSource } from './types.js';
import { epochMsToIso } from './time.js';

/** 统一列（顺序即 UNION 的列序，注册项必须一致）。 */
export const UNIFIED_COLUMNS = [
  'source',
  'native_id',
  'title',
  'workspace',
  'status',
  'raw_status',
  'started_at',
  'ended_at',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'error',
  'agent_id',
  'owner_user_id',
] as const;

export interface SourceDef {
  key: RunSource;
  /** UI 上的中文标签。 */
  label: string;
  /** 产出统一列的子查询（不含 WHERE 时间过滤，过滤由外层统一施加）。 */
  sql: string;
  /**
   * 该来源的 `running` 是否可能是**正常的长跑**而不是卡住。
   *
   * 监督者是设计上的长驻会话（`period_ms` 默认 5 分钟，一个会话可以活跃数天），
   * 把它算进「疑似卡住」会产生持续误报。其余来源的 running 都应尽快收尾，
   * 长时间停在 running 是真实的异常信号。
   */
  staleEligible: boolean;
}

/**
 * 对话 / IM Agent 运行。
 *
 * **一次运行 = 一个 turn 根节点**。`chat_trace_nodes.session_id` 在实践中恒为 NULL
 * （见 `src/flm/flm-collect.ts` 的实测注释），所以 session 不能用作运行边界；
 * `node_type='turn' AND parent_node_id IS NULL` 是这张表里唯一稳定的运行根。
 *
 * 该表只有一个聚合的 `tokens` 列，没有 input/output 拆分 —— 统一记到 output 侧，
 * 编造一个拆分比例等于伪造数据。
 */
const CHAT_SQL = `
  SELECT
    'chat' AS source,
    chat_jid || '#' || CAST(id AS TEXT) AS native_id,
    COALESCE(NULLIF(title, ''), 'Turn') AS title,
    chat_jid AS workspace,
    CASE status
      WHEN 'done' THEN 'success'
      WHEN 'failed' THEN 'failed'
      WHEN 'running' THEN 'running'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE COALESCE(status, 'pending')
    END AS status,
    COALESCE(status, '') AS raw_status,
    started_at AS started_at,
    ended_at AS ended_at,
    0 AS input_tokens,
    COALESCE(tokens, 0) AS output_tokens,
    NULL AS cost_usd,
    NULL AS error,
    NULL AS agent_id,
    NULL AS owner_user_id
  FROM chat_trace_nodes
  WHERE node_type = 'turn' AND parent_node_id IS NULL
`;

/** 图编排运行（Swarm / Workflow / Orchestrator-Workers）。 */
const GRAPH_SQL = `
  SELECT
    'graph' AS source,
    id AS native_id,
    COALESCE(NULLIF(goal_text, ''), definition_id) AS title,
    group_folder AS workspace,
    CASE status
      WHEN 'completed' THEN 'success'
      WHEN 'paused' THEN 'running'
      WHEN 'running' THEN 'running'
      WHEN 'failed' THEN 'failed'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE COALESCE(status, 'pending')
    END AS status,
    COALESCE(status, '') AS raw_status,
    started_at AS started_at,
    ended_at AS ended_at,
    total_input_tokens AS input_tokens,
    total_output_tokens AS output_tokens,
    total_cost_usd AS cost_usd,
    CASE WHEN status = 'failed' OR status = 'cancelled' THEN cancel_reason ELSE NULL END AS error,
    NULL AS agent_id,
    owner_user_id AS owner_user_id
  FROM graph_runs
`;

/**
 * 开放平台的「工作区」哨兵值。
 *
 * AaaS 没有工作区概念 —— 一次调用属于某个 **Agent**，不属于某个会话目录，
 * 所以 `workspace` 列只能填这个常量占位。导出成常量是因为两处都要认它：
 * 源 SQL 填它，`queries.ts` 的按工作区分布拿它当**来源判别符**——命中就改按
 * `agent_id` 分组（见 `byWorkspace` 的注释）。
 */
export const OPEN_PLATFORM_WORKSPACE = 'open-platform';

/** 开放平台 AaaS —— v72 起由 `open-platform/run-recorder.ts` 写入。 */
const OPEN_PLATFORM_SQL = `
  SELECT
    'open-platform' AS source,
    id AS native_id,
    COALESCE(NULLIF(request_summary, ''), agent_id) AS title,
    '${OPEN_PLATFORM_WORKSPACE}' AS workspace,
    CASE status
      WHEN 'completed' THEN 'success'
      WHEN 'pending' THEN 'pending'
      ELSE COALESCE(status, 'pending')
    END AS status,
    COALESCE(status, '') AS raw_status,
    started_at AS started_at,
    ended_at AS ended_at,
    input_tokens AS input_tokens,
    output_tokens AS output_tokens,
    cost_usd AS cost_usd,
    error AS error,
    agent_id AS agent_id,
    user_id AS owner_user_id
  FROM open_platform_runs
`;

/** Loop Engineering 运行（goal / loop / schedule / proactive）。 */
const LOOP_SQL = `
  SELECT
    'loop' AS source,
    id AS native_id,
    COALESCE(NULLIF(goal_text, ''), kind) AS title,
    group_folder AS workspace,
    CASE status
      WHEN 'completed' THEN 'success'
      WHEN 'failed' THEN 'failed'
      WHEN 'cancelled' THEN 'cancelled'
      WHEN 'pending' THEN 'pending'
      ELSE 'running'
    END AS status,
    COALESCE(status, '') AS raw_status,
    started_at AS started_at,
    ended_at AS ended_at,
    total_input_tokens AS input_tokens,
    total_output_tokens AS output_tokens,
    total_cost_usd AS cost_usd,
    CASE WHEN status IN ('failed', 'cancelled') THEN cancel_reason ELSE NULL END AS error,
    NULL AS agent_id,
    owner_user_id AS owner_user_id
  FROM loop_runs
`;

/**
 * 监督者会话。
 *
 * `staleEligible: false` —— 见 SourceDef 的说明，这是长驻会话而非一次性运行。
 * 该表没有 token / cost 列，统一记 0 / NULL（NULL 让 UI 显示 "—" 而不是伪造的 "$0.00"）。
 */
const SUPERVISOR_SQL = `
  SELECT
    'supervisor' AS source,
    id AS native_id,
    COALESCE(NULLIF(goal_text, ''), id) AS title,
    group_folder AS workspace,
    CASE status
      WHEN 'completed' THEN 'success'
      WHEN 'failed' THEN 'failed'
      WHEN 'aborted' THEN 'cancelled'
      ELSE 'running'
    END AS status,
    COALESCE(status, '') AS raw_status,
    started_at AS started_at,
    ended_at AS ended_at,
    0 AS input_tokens,
    0 AS output_tokens,
    NULL AS cost_usd,
    NULL AS error,
    NULL AS agent_id,
    owner_user_id AS owner_user_id
  FROM supervisor_sessions
`;

/**
 * 定时任务运行。
 *
 * `task_run_logs` 一行就是一次运行，没有分步轨迹（`run_at` + `duration_ms` + `result`）。
 * 工作区与归属从 `scheduled_tasks` 反查 —— 日志表自身不带这两个字段。
 */
const TASK_SQL = `
  SELECT
    'task' AS source,
    l.id AS native_id,
    'Task: ' || COALESCE(NULLIF(substr(t.prompt, 1, 80), ''), t.id) AS title,
    COALESCE(t.group_folder, '') AS workspace,
    CASE l.status
      WHEN 'success' THEN 'success'
      WHEN 'done' THEN 'success'
      WHEN 'failed' THEN 'failed'
      WHEN 'error' THEN 'failed'
      WHEN 'running' THEN 'running'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE COALESCE(l.status, 'pending')
    END AS status,
    COALESCE(l.status, '') AS raw_status,
    l.run_at AS started_at,
    NULL AS ended_at,
    0 AS input_tokens,
    0 AS output_tokens,
    NULL AS cost_usd,
    l.error AS error,
    NULL AS agent_id,
    t.created_by AS owner_user_id
  FROM task_run_logs l
  LEFT JOIN scheduled_tasks t ON t.id = l.task_id
`;

/** 沙箱代码执行。`created_at` 是 epoch 毫秒，必须走 epochMsToIso 才能参与跨源排序。 */
const SANDBOX_SQL = `
  SELECT
    'sandbox' AS source,
    CAST(id AS TEXT) AS native_id,
    language || ' 沙箱执行' AS title,
    session_id AS workspace,
    CASE
      WHEN status IN ('success', 'ok', 'completed') THEN 'success'
      WHEN status IN ('failed', 'error', 'timeout') THEN 'failed'
      WHEN status = 'running' THEN 'running'
      ELSE COALESCE(status, 'pending')
    END AS status,
    COALESCE(status, '') AS raw_status,
    ${epochMsToIso('created_at')} AS started_at,
    ${epochMsToIso('created_at + duration_ms')} AS ended_at,
    0 AS input_tokens,
    0 AS output_tokens,
    NULL AS cost_usd,
    CASE WHEN exit_code IS NOT NULL AND exit_code <> 0
         THEN 'exit code ' || CAST(exit_code AS TEXT) ELSE NULL END AS error,
    NULL AS agent_id,
    user_id AS owner_user_id
  FROM sandbox_executions
`;

/** Harness 评测运行。 */
const HARNESS_EVAL_SQL = `
  SELECT
    'harness-eval' AS source,
    id AS native_id,
    'Eval: ' || case_id AS title,
    'harness' AS workspace,
    CASE status
      WHEN 'completed' THEN 'success'
      ELSE COALESCE(status, 'pending')
    END AS status,
    COALESCE(status, '') AS raw_status,
    started_at AS started_at,
    finished_at AS ended_at,
    0 AS input_tokens,
    0 AS output_tokens,
    NULL AS cost_usd,
    error AS error,
    NULL AS agent_id,
    NULL AS owner_user_id
  FROM harness_eval_runs
`;

export const SOURCES: Record<RunSource, SourceDef> = {
  chat: { key: 'chat', label: '对话 / IM Agent', sql: CHAT_SQL, staleEligible: true },
  graph: { key: 'graph', label: '图编排', sql: GRAPH_SQL, staleEligible: true },
  'open-platform': {
    key: 'open-platform',
    label: '开放平台 AaaS',
    sql: OPEN_PLATFORM_SQL,
    staleEligible: true,
  },
  loop: { key: 'loop', label: 'Loop Engineering', sql: LOOP_SQL, staleEligible: true },
  supervisor: { key: 'supervisor', label: '监督者', sql: SUPERVISOR_SQL, staleEligible: false },
  task: { key: 'task', label: '定时任务', sql: TASK_SQL, staleEligible: true },
  sandbox: { key: 'sandbox', label: '沙箱执行', sql: SANDBOX_SQL, staleEligible: true },
  'harness-eval': {
    key: 'harness-eval',
    label: 'Harness 评测',
    sql: HARNESS_EVAL_SQL,
    staleEligible: true,
  },
};

export function sourceLabel(source: string): string {
  return SOURCES[source as RunSource]?.label ?? source;
}

/**
 * 拼出统一运行视图的子查询。
 *
 * `sources` 为空/未指定 → 全量拼入；否则只拼选中的来源。**来源筛选在分支级下推**
 * （决定拼哪些分支），而状态/时间/关键词过滤交给外层 —— 后者若也下推，参数占位符
 * 要按分支重复一遍，SQL 构造复杂度翻倍，换来的只是省一次万行级扫描。
 *
 * ⚠️ 每个分支必须写成 `SELECT * FROM (…)`，**不能**只包一层括号。
 * SQLite 的 compound SELECT **不接受带括号的操作数**：
 *   `SELECT * FROM ((SELECT 1) UNION ALL (SELECT 2))` → near "UNION": syntax error
 * PostgreSQL 接受这种写法，所以只在 SQLite 后端暴露 —— 而 SQLite 是默认后端，
 * 也即"本地全对、线上全挂"的反向版本。
 * `SELECT * FROM (…)` 包裹在两个后端都合法（见 tests/runtime-monitor.test.ts）。
 */
export function buildUnionSubquery(sources?: RunSource[]): string {
  const keys = sources && sources.length > 0 ? sources : (Object.keys(SOURCES) as RunSource[]);
  return keys.map((k) => `SELECT * FROM (${SOURCES[k].sql.trim()})`).join('\nUNION ALL\n');
}
