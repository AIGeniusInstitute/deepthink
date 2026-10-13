/**
 * 统一运行视图的查询层。
 *
 * 全部查询都建在 `sources.ts` 拼出的 UNION 子查询之上，因此新增来源不需要改这里。
 * 唯一的例外是**轨迹查询**（`getTrace`）—— 每个来源的轨迹表结构完全不同，只能分派。
 */

import {
  getAgentDefinitionById,
  getAllChats,
  getAllRegisteredGroups,
  getAllUsers,
  getDb,
} from '../db.js';
import type { RegisteredGroup } from '../types.js';
import {
  OPEN_PLATFORM_WORKSPACE,
  SOURCES,
  buildUnionSubquery,
  sourceLabel,
} from './sources.js';
import {
  STALE_AFTER_MS,
  WINDOW_MS,
  type MonitorOverview,
  type RunDetail,
  type RunFilter,
  type RunPage,
  type RunSource,
  type RunStatus,
  type RunSummary,
  type RunWindow,
  type SourceBreakdownItem,
  type TraceItem,
  type TrendBucket,
  type WorkspaceBreakdownItem,
} from './types.js';
import { durationMsBetween, enumerateBuckets } from './time.js';

const MAX_LIMIT = 200;
const P95_SAMPLE_CAP = 5000;

/** 统一列的 JSON 行形状（SQL 别名 → 字段）。 */
interface UnifiedRow {
  source: string;
  native_id: string;
  title: string | null;
  workspace: string | null;
  status: string;
  raw_status: string | null;
  started_at: string;
  ended_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  agent_id: string | null;
  owner_user_id: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 可读名补全
// ─────────────────────────────────────────────────────────────────────────────

interface Lookups {
  byJid: Map<string, RegisteredGroup>;
  byFolder: Map<string, RegisteredGroup>;
  chatNames: Map<string, string>;
  userNames: Map<string, string>;
  /** agent id → 名称，按需懒加载（一页里最多几十个不同 agent）。 */
  agentNames: Map<string, string>;
}

/**
 * 一次性把三张小表读进内存，避免在 UNION 里做 8 次 JOIN。
 *
 * 规模假设：`registered_groups` / `chats` / `users` 都是几十行量级，
 * 相比让 8 个分支各 JOIN 一次，这样更快也更好读。
 */
function buildLookups(): Lookups {
  const byJid = new Map<string, RegisteredGroup>();
  const byFolder = new Map<string, RegisteredGroup>();
  for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
    byJid.set(jid, group);
    if (!byFolder.has(group.folder)) byFolder.set(group.folder, group);
  }
  const chatNames = new Map<string, string>();
  for (const chat of getAllChats()) {
    if (chat.name) chatNames.set(chat.jid, chat.name);
  }
  const userNames = new Map<string, string>();
  for (const user of getAllUsers()) userNames.set(user.id, user.username);
  return { byJid, byFolder, chatNames, userNames, agentNames: new Map() };
}

function agentName(lk: Lookups, agentId: string | null): string | null {
  if (!agentId) return null;
  const cached = lk.agentNames.get(agentId);
  if (cached !== undefined) return cached;
  let name: string | null = null;
  try {
    name = getAgentDefinitionById(agentId)?.name ?? null;
  } catch {
    name = null;
  }
  if (name) lk.agentNames.set(agentId, name);
  return name;
}

function toRunSummary(row: UnifiedRow, lk: Lookups, nowMs: number): RunSummary {
  const source = row.source as RunSource;
  const workspace = row.workspace ?? '';
  const group = lk.byJid.get(workspace) ?? lk.byFolder.get(workspace) ?? null;

  // chat 来源的 workspace 是 chat_jid，其群组可能绑定了 Agent 定义
  const agentId = row.agent_id ?? group?.agentDefId ?? null;
  const agent = agentName(lk, agentId);

  let workspaceLabel: string;
  if (source === 'open-platform') {
    // 开放平台没有工作区概念，用 Agent 名代替（比显示常量 'open-platform' 有用得多）
    workspaceLabel = agent ?? '开放平台 AaaS';
  } else {
    workspaceLabel =
      group?.name ?? lk.chatNames.get(workspace) ?? workspace ?? '未知工作区';
  }

  const durationMs = durationMsBetween(row.started_at, row.ended_at);
  const status = row.status as RunStatus;
  const age = nowMs - (Date.parse(row.started_at) || nowMs);
  const stale =
    status === 'running' && SOURCES[source]?.staleEligible === true && age > STALE_AFTER_MS;

  return {
    runId: `${source}:${row.native_id}`,
    source,
    sourceLabel: sourceLabel(source),
    title: row.title ?? '',
    workspace,
    workspaceLabel,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_user_id ? (lk.userNames.get(row.owner_user_id) ?? null) : null,
    agentId,
    agentName: agent,
    status,
    rawStatus: row.raw_status ?? '',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    costUsd: row.cost_usd,
    error: row.error,
    stale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 过滤条件
// ─────────────────────────────────────────────────────────────────────────────

function staleCutoffIso(nowMs: number): string {
  return new Date(nowMs - STALE_AFTER_MS).toISOString();
}

/**
 * 归一化状态字符串 → 是否「疑似卡住的候选状态」。
 * 见 `SourceDef.staleEligible`：长驻会话（监督者）不参与卡住判定。
 */
function staleEligiblePredicate(): string {
  const ineligible = (Object.keys(SOURCES) as RunSource[]).filter(
    (k) => !SOURCES[k].staleEligible,
  );
  if (ineligible.length === 0) return '1=1';
  return `source NOT IN (${ineligible.map((s) => `'${s}'`).join(', ')})`;
}

function buildWhere(filter: RunFilter, nowMs: number): { sql: string; params: unknown[] } {
  const clauses: string[] = ['1=1'];
  const params: unknown[] = [];

  if (filter.statuses && filter.statuses.length > 0) {
    clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
    params.push(...filter.statuses);
  }
  if (filter.from) {
    clauses.push('started_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push('started_at < ?');
    params.push(filter.to);
  }
  if (filter.q && filter.q.trim()) {
    clauses.push('(title LIKE ? OR workspace LIKE ?)');
    const like = `%${filter.q.trim()}%`;
    params.push(like, like);
  }
  if (filter.staleOnly) {
    clauses.push(`(status = 'running' AND started_at < ? AND ${staleEligiblePredicate()})`);
    params.push(staleCutoffIso(nowMs));
  }
  // fail-closed：只有**显式** null 表示不限范围；未指定（undefined）与空数组都按
  // "什么都看不到"处理，见 RunFilter.allowedWorkspaces 的说明。
  if (filter.allowedWorkspaces !== null) {
    const ws = filter.allowedWorkspaces ?? [];
    const orParts: string[] = [];
    if (ws.length > 0) {
      orParts.push(`workspace IN (${ws.map(() => '?').join(', ')})`);
      params.push(...ws);
    }
    if (filter.viewerUserId) {
      // 沙箱 / 开放平台这类没有工作区的运行，按归属人放行
      orParts.push('owner_user_id = ?');
      params.push(filter.viewerUserId);
    }
    clauses.push(orParts.length > 0 ? `(${orParts.join(' OR ')})` : '1=0');
  }

  return { sql: clauses.join(' AND '), params };
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行列表
// ─────────────────────────────────────────────────────────────────────────────

export function listRuns(filter: RunFilter, limit = 20, offset = 0): RunPage {
  const db = getDb();
  const nowMs = Date.parse(filter.now ?? new Date().toISOString()) || Date.now();
  const union = buildUnionSubquery(filter.sources);
  const where = buildWhere(filter, nowMs);
  const lim = Math.min(Math.max(1, limit), MAX_LIMIT);
  const off = Math.max(0, offset);

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM (${union}) AS r WHERE ${where.sql}`)
    .get(...(where.params as never[])) as { c: number } | undefined;

  const rows = db
    .prepare(
      `SELECT * FROM (${union}) AS r WHERE ${where.sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...(where.params as never[]), lim, off) as UnifiedRow[];

  const lk = buildLookups();
  return {
    runs: rows.map((r) => toRunSummary(r, lk, nowMs)),
    total: totalRow?.c ?? 0,
    limit: lim,
    offset: off,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 单次运行 + 轨迹
// ─────────────────────────────────────────────────────────────────────────────

export function parseRunId(runId: string): { source: RunSource; nativeId: string } | null {
  const i = runId.indexOf(':');
  if (i <= 0) return null;
  const source = runId.slice(0, i) as RunSource;
  if (!SOURCES[source]) return null;
  return { source, nativeId: runId.slice(i + 1) };
}

export function getRunDetail(runId: string, filter: RunFilter): RunDetail | null {
  const parsed = parseRunId(runId);
  if (!parsed) return null;

  const db = getDb();
  const nowMs = Date.parse(filter.now ?? new Date().toISOString()) || Date.now();
  const union = buildUnionSubquery([parsed.source]);
  const where = buildWhere(filter, nowMs);

  const row = db
    .prepare(
      `SELECT * FROM (${union}) AS r WHERE ${where.sql} AND native_id = ? LIMIT 1`,
    )
    .get(...(where.params as never[]), parsed.nativeId) as UnifiedRow | undefined;
  if (!row) return null;

  const lk = buildLookups();
  const run = toRunSummary(row, lk, nowMs);
  const { trace, traceNote } = getTrace(parsed.source, parsed.nativeId, row);
  return { run, trace, traceNote };
}

/** 轨迹查询分派。每个来源的轨迹表结构不同，无法在 UNION 层统一。 */
function getTrace(
  source: RunSource,
  nativeId: string,
  row: UnifiedRow,
): { trace: TraceItem[]; traceNote: string | null } {
  const db = getDb();

  if (source === 'chat') {
    const hash = nativeId.lastIndexOf('#');
    const jid = nativeId.slice(0, hash);
    const nodeId = Number(nativeId.slice(hash + 1));
    if (!jid || !Number.isFinite(nodeId)) return { trace: [], traceNote: '运行标识无法解析' };

    const nodes = db
      .prepare(
        `WITH RECURSIVE tree AS (
           SELECT * FROM chat_trace_nodes WHERE chat_jid = ? AND id = ?
           UNION ALL
           SELECT c.* FROM chat_trace_nodes c
             JOIN tree t ON c.parent_node_id = t.id AND c.chat_jid = t.chat_jid
         )
         SELECT id, parent_node_id, node_type, title, status, started_at, ended_at,
                tokens, span_id, parent_span_id, tool_name, input_summary, output_summary
         FROM tree ORDER BY started_at ASC, id ASC`,
      )
      .all(jid, nodeId) as Array<Record<string, unknown>>;

    // 原始工具 I/O：`chat_trace_nodes.tool_use_id` 在实践中从未写入（实测 11249/11249 为空），
    // 所以无法按 id 精确关联，只能按该次运行的时间窗关联。窗口取 turn 自身的
    // [started_at, ended_at]；未收尾的运行（ended_at 为 NULL）用「不早于 started_at」兜底。
    const startedAt = row.started_at;
    const endedAt = row.ended_at;
    const toolCalls = endedAt
      ? (db
          .prepare(
            `SELECT tool_use_id, tool_name, status, started_at, ended_at, input_json, output_json
             FROM trace_tool_calls
             WHERE chat_jid = ? AND started_at >= ? AND started_at <= ?
             ORDER BY started_at ASC`,
          )
          .all(jid, startedAt, endedAt) as Array<Record<string, unknown>>)
      : [];

    const seen = new Set<string>();
    const items: TraceItem[] = [];
    for (const n of nodes) {
      const spanId = (n.span_id as string) || `n${n.id}`;
      seen.add(spanId);
      items.push({
        spanId,
        parentSpanId: (n.parent_span_id as string) ?? null,
        nodeType: String(n.node_type ?? ''),
        title: (n.title as string) ?? null,
        status: (n.status as string) ?? null,
        startedAt: String(n.started_at ?? ''),
        endedAt: (n.ended_at as string) ?? null,
        durationMs: durationMsBetween(n.started_at as string, n.ended_at as string),
        tokens: Number(n.tokens ?? 0),
        toolName: (n.tool_name as string) ?? null,
        inputSummary: (n.input_summary as string) ?? null,
        outputSummary: (n.output_summary as string) ?? null,
      });
    }
    for (const t of toolCalls) {
      const tid = String(t.tool_use_id ?? '');
      if (!tid || seen.has(`tool:${tid}`)) continue;
      seen.add(`tool:${tid}`);
      items.push({
        spanId: `tool:${tid}`,
        parentSpanId: null,
        nodeType: 'tool_io',
        title: (t.tool_name as string) ?? null,
        status: (t.status as string) ?? null,
        startedAt: String(t.started_at ?? ''),
        endedAt: (t.ended_at as string) ?? null,
        durationMs: durationMsBetween(t.started_at as string, t.ended_at as string),
        tokens: 0,
        toolName: (t.tool_name as string) ?? null,
        inputSummary: truncate(t.input_json as string, 500),
        outputSummary: truncate(t.output_json as string, 500),
      });
    }
    items.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
    return { trace: items, traceNote: null };
  }

  if (source === 'graph') {
    const rows = db
      .prepare(
        `SELECT id, node_id, node_type, status, started_at, ended_at,
                input_tokens, output_tokens, input_summary, output_summary, error
         FROM graph_node_runs WHERE graph_run_id = ? ORDER BY started_at ASC`,
      )
      .all(nativeId) as Array<Record<string, unknown>>;
    return {
      trace: rows.map((r) => ({
        spanId: String(r.id),
        parentSpanId: null,
        nodeType: String(r.node_type ?? ''),
        title: String(r.node_id ?? ''),
        status: (r.status as string) ?? null,
        startedAt: String(r.started_at ?? ''),
        endedAt: (r.ended_at as string) ?? null,
        durationMs: durationMsBetween(r.started_at as string, r.ended_at as string),
        tokens: Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0),
        toolName: null,
        inputSummary: (r.input_summary as string) ?? null,
        outputSummary: (r.error as string) ?? ((r.output_summary as string) ?? null),
      })),
      traceNote: rows.length === 0 ? '该次图运行没有节点级记录' : null,
    };
  }

  if (source === 'open-platform') {
    const rows = db
      .prepare(
        `SELECT span_id, parent_span_id, node_type, title, status, started_at, ended_at,
                tokens, input_summary, output_summary
         FROM trace_steps WHERE trace_id = ? ORDER BY started_at ASC`,
      )
      .all(nativeId) as Array<Record<string, unknown>>;
    return {
      trace: rows.map((r) => ({
        spanId: String(r.span_id),
        parentSpanId: (r.parent_span_id as string) ?? null,
        nodeType: String(r.node_type ?? ''),
        title: (r.title as string) ?? null,
        status: (r.status as string) ?? null,
        startedAt: String(r.started_at ?? ''),
        endedAt: (r.ended_at as string) ?? null,
        durationMs: durationMsBetween(r.started_at as string, r.ended_at as string),
        tokens: Number(r.tokens ?? 0),
        toolName: null,
        inputSummary: (r.input_summary as string) ?? null,
        outputSummary: (r.output_summary as string) ?? null,
      })),
      traceNote: rows.length === 0 ? '该次调用没有记录到步骤' : null,
    };
  }

  if (source === 'loop') {
    const rows = db
      .prepare(
        `SELECT id, node_type, title, status, started_at, ended_at, tokens,
                input_summary, output_summary, tool_name, parent_node_id
         FROM loop_trace_nodes WHERE loop_run_id = ? ORDER BY started_at ASC`,
      )
      .all(nativeId) as Array<Record<string, unknown>>;
    return {
      trace: rows.map((r) => ({
        spanId: `l${r.id}`,
        parentSpanId: r.parent_node_id ? `l${r.parent_node_id}` : null,
        nodeType: String(r.node_type ?? ''),
        title: (r.title as string) ?? null,
        status: (r.status as string) ?? null,
        startedAt: String(r.started_at ?? ''),
        endedAt: (r.ended_at as string) ?? null,
        durationMs: durationMsBetween(r.started_at as string, r.ended_at as string),
        tokens: Number(r.tokens ?? 0),
        toolName: (r.tool_name as string) ?? null,
        inputSummary: (r.input_summary as string) ?? null,
        outputSummary: (r.output_summary as string) ?? null,
      })),
      traceNote: rows.length === 0 ? '该次 Loop 运行没有节点级记录' : null,
    };
  }

  if (source === 'supervisor') {
    const rows = db
      .prepare(
        `SELECT id, turn_index, action, conclusion, status, started_at, ended_at, error, trace_summary
         FROM supervisor_decisions WHERE session_id = ? ORDER BY turn_index ASC`,
      )
      .all(nativeId) as Array<Record<string, unknown>>;
    return {
      trace: rows.map((r) => ({
        spanId: String(r.id),
        parentSpanId: null,
        nodeType: `decision:${String(r.action ?? '')}`,
        title: `第 ${Number(r.turn_index ?? 0) + 1} 次检查`,
        status: (r.status as string) ?? null,
        startedAt: String(r.started_at ?? ''),
        endedAt: (r.ended_at as string) ?? null,
        durationMs: durationMsBetween(r.started_at as string, r.ended_at as string),
        tokens: 0,
        toolName: null,
        inputSummary: (r.trace_summary as string) ?? null,
        outputSummary: (r.error as string) ?? ((r.conclusion as string) ?? null),
      })),
      traceNote: rows.length === 0 ? '该监督者会话尚未产生检查决策' : null,
    };
  }

  // task / sandbox / harness-eval：一次运行就是一个原子记录，没有分步轨迹。
  return {
    trace: [
      {
        spanId: `${source}:${nativeId}`,
        parentSpanId: null,
        nodeType: source,
        title: row.title ?? '',
        status: row.raw_status ?? row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMs: durationMsBetween(row.started_at, row.ended_at),
        tokens: (row.input_tokens ?? 0) + (row.output_tokens ?? 0),
        toolName: null,
        inputSummary: null,
        outputSummary: row.error,
      },
    ],
    traceNote: '该来源是原子运行记录，没有分步轨迹',
  };
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// 总览 / 趋势
// ─────────────────────────────────────────────────────────────────────────────

function resolveWindow(
  window: RunWindow,
  filter: RunFilter,
): { from: string | null; to: string; bucket: 'hour' | 'day' } {
  const nowMs = Date.parse(filter.now ?? new Date().toISOString()) || Date.now();
  const to = new Date(nowMs).toISOString();
  const ms = WINDOW_MS[window];
  const bucket: 'hour' | 'day' = window === '1h' || window === '24h' ? 'hour' : 'day';
  if (ms === null) return { from: null, to, bucket };
  return { from: new Date(nowMs - ms).toISOString(), to, bucket };
}

export function getOverview(window: RunWindow, filter: RunFilter): MonitorOverview {
  const db = getDb();
  const nowMs = Date.parse(filter.now ?? new Date().toISOString()) || Date.now();
  const { from, to, bucket } = resolveWindow(window, filter);
  const union = buildUnionSubquery(filter.sources);

  const scoped: RunFilter = { ...filter, from: from ?? undefined, to: to ?? undefined };
  const where = buildWhere(scoped, nowMs);
  const cutoff = staleCutoffIso(nowMs);
  const staleEligible = staleEligiblePredicate();

  const kpiRow = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'running' AND started_at < ? AND ${staleEligible}
                  THEN 1 ELSE 0 END) AS stale,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens,
         SUM(COALESCE(cost_usd, 0)) AS cost
       FROM (${union}) AS r WHERE ${where.sql}`,
    )
    .get(cutoff, ...(where.params as never[])) as Record<string, number | null> | undefined;

  const success = Number(kpiRow?.success ?? 0);
  const failed = Number(kpiRow?.failed ?? 0);
  const concluded = success + failed;

  // P95 在 TS 侧算：SQLite 与 PG 的分位函数写法不同，为一行统计引入方言分支不划算。
  // 只取有 ended_at 的终态运行 —— 未收尾的 run 没有可信耗时，混进来会把 P95 拉爆。
  const durationRows = db
    .prepare(
      `SELECT started_at, ended_at FROM (${union}) AS r
       WHERE ${where.sql} AND ended_at IS NOT NULL AND status IN ('success','failed','cancelled')
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(...(where.params as never[]), P95_SAMPLE_CAP) as Array<{
    started_at: string;
    ended_at: string;
  }>;
  const durations = durationRows
    .map((r) => durationMsBetween(r.started_at, r.ended_at))
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  const p95 =
    durations.length === 0 ? null : durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];

  const groupSql = (groupCol: string) =>
    `SELECT ${groupCol} AS grp,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens,
            SUM(COALESCE(cost_usd, 0)) AS cost
     FROM (${union}) AS r WHERE ${where.sql}
     GROUP BY ${groupCol} ORDER BY total DESC LIMIT 20`;

  const sourceRows = db
    .prepare(groupSql('source'))
    .all(...(where.params as never[])) as Array<Record<string, unknown>>;
  const bySource: SourceBreakdownItem[] = sourceRows.map((r) => ({
    source: String(r.grp) as RunSource,
    sourceLabel: sourceLabel(String(r.grp)),
    total: Number(r.total ?? 0),
    running: Number(r.running ?? 0),
    failed: Number(r.failed ?? 0),
    tokens: Number(r.tokens ?? 0),
    costUsd: Number(r.cost ?? 0),
  }));

  // 开放平台按 **Agent** 分组：它的 `workspace` 是常量哨兵（见 OPEN_PLATFORM_WORKSPACE），
  // 直接按 workspace 分组会把所有 Agent 的 AaaS 运行压成一行 'open-platform' —— 既丢掉
  // 了 per-agent 归属，也让同一批运行在 KPI 分布里叫 'open-platform'、在运行列表里叫
  // Agent 名（`toRunSummary` 的取值规则），页面上对不上账。两者现在统一为 Agent 名。
  // agent_id 在建表时就 NOT NULL，所以无需 COALESCE 兜底。
  const wsExpr = `CASE WHEN source = '${OPEN_PLATFORM_WORKSPACE}' THEN agent_id ELSE workspace END`;
  const wsRows = db
    .prepare(groupSql(wsExpr))
    .all(...(where.params as never[])) as Array<Record<string, unknown>>;
  const lk = buildLookups();
  const byWorkspace: WorkspaceBreakdownItem[] = wsRows.map((r) => {
    const ws = String(r.grp ?? '');
    // AaaS 的分组键是 agent_id：先试 Agent 名；Agent 定义被硬删的历史运行会查不到，
    // 那种情况回落成裸 id（真实归属，可排查），不去伪造一个来源名。
    const label =
      agentName(lk, ws) ??
      lk.byJid.get(ws)?.name ??
      lk.byFolder.get(ws)?.name ??
      lk.chatNames.get(ws) ??
      ws;
    return {
      workspace: ws,
      workspaceLabel: label || '未知工作区',
      total: Number(r.total ?? 0),
      running: Number(r.running ?? 0),
      failed: Number(r.failed ?? 0),
      tokens: Number(r.tokens ?? 0),
      costUsd: Number(r.cost ?? 0),
    };
  });

  const trendRows = db
    .prepare(
      `SELECT substr(started_at, 1, ${bucket === 'hour' ? 13 : 10}) AS bucket,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
              SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens,
              SUM(COALESCE(cost_usd, 0)) AS cost
       FROM (${union}) AS r WHERE ${where.sql}
       GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(...(where.params as never[])) as Array<Record<string, unknown>>;

  const byBucket = new Map<string, Record<string, unknown>>();
  for (const r of trendRows) byBucket.set(String(r.bucket), r);

  let trendFrom = from;
  if (!trendFrom) {
    const minRow = db
      .prepare(`SELECT MIN(started_at) AS m FROM (${union}) AS r WHERE ${where.sql}`)
      .get(...(where.params as never[])) as { m: string | null } | undefined;
    trendFrom = minRow?.m ?? null;
  }

  // 空桶补 0 —— 缺桶会让趋势图把两段安静期画成相邻点，视觉上变成"一直很闲"。
  const trend: TrendBucket[] = [];
  if (trendFrom) {
    for (const key of enumerateBuckets(trendFrom, to, bucket)) {
      const r = byBucket.get(key);
      trend.push({
        bucket: key,
        total: Number(r?.total ?? 0),
        success: Number(r?.success ?? 0),
        failed: Number(r?.failed ?? 0),
        running: Number(r?.running ?? 0),
        tokens: Number(r?.tokens ?? 0),
        costUsd: Number(r?.cost ?? 0),
      });
    }
  }

  return {
    window,
    generatedAt: new Date(nowMs).toISOString(),
    kpis: {
      running: Number(kpiRow?.running ?? 0),
      stale: Number(kpiRow?.stale ?? 0),
      total: Number(kpiRow?.total ?? 0),
      success,
      failed,
      successRate: concluded === 0 ? null : success / concluded,
      tokens: Number(kpiRow?.tokens ?? 0),
      costUsd: Number(kpiRow?.cost ?? 0),
      p95DurationMs: p95,
      durationSampleSize: durations.length,
    },
    bySource,
    byWorkspace,
    trend,
    trendBucket: bucket,
  };
}
