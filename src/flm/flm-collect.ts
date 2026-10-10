/**
 * FLM 采集层（PRD F1：多源反馈采集）。
 *
 * 三类来源的落地方式：
 *   - user  ：由 UI 主动 POST 上报（本文件提供入库入口，路由在 src/routes/flm.ts）
 *   - system：**从既有轨迹表派生**，不新埋点。平台已有 chat_trace_nodes /
 *             trace_tool_calls，重复埋点只会产生第二份真相。
 *   - env   ：由调用方在任务前后各拍一次快照，本文件算 diff
 *
 * ⚠️ 实盘约束（实测本机实例得出，决定了下面的实现）：
 *   1. `chat_trace_nodes.session_id` **9092 行全为 NULL** —— 节点无法按 session 对齐，
 *      只能按 `chat_jid + 时间窗`。`trace_steps` 才有可用的 trace_id。
 *   2. 所有时间列都是 ISO-8601 UTC 文本（如 `2026-10-09T17:31:05.773Z`），格式统一，
 *      因此可以直接用字符串比较做范围查询 —— 这在 SQLite 与 PG 下行为一致。
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { readConfig, type FlmConfig } from './flm-config.js';
import {
  insertEventIfNew,
  insertSnapshot,
  listSnapshots,
  listEventsByTask,
  type FlmEventRow,
  type FlmSnapshotRow,
} from './flm-db.js';
import { deriveTaskId, normalizeDraft, resolveConflicts, type ResolvedKeys } from './flm-normalize.js';
import type { EvalContext, EvalToolCallInput } from './flm-evaluate.js';
import type { FeedbackDraft, NormalizedEvent } from './flm-types.js';

const iso = (ms: number) => new Date(ms).toISOString();

// ── 任务范围解析 ─────────────────────────────────────────────────────

export interface TaskScope {
  taskId: string;
  chatJid: string;
  traceId: string | null;
  sessionId: string | null;
  startMs: number;
  endMs: number;
}

interface MessageRow {
  id: string;
  chat_jid: string;
  timestamp: string;
  turn_id: string | null;
  session_id: string | null;
  is_from_me: number;
}

/**
 * 由 taskId 还原出「这个任务的轨迹在哪个聊天、哪段时间里」。
 *
 * 时间窗右边界的取法：**同聊天下一条消息的时间**。这是不引入新状态就能拿到的最准确
 * 边界 —— 下一条消息到来即意味着上一轮已结束。取不到下一条时按 10 分钟兜底。
 */
export function resolveTaskScope(taskId: string): TaskScope | null {
  const db = getDb();
  const [kind, ...rest] = taskId.split(':');

  if (kind === 'turn') {
    const turnId = rest.join(':');
    // 助手消息的 turn_id 指向触发它的那条用户消息 id —— 两者同属一个任务。
    const rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE id = ? OR turn_id = ?
         ORDER BY timestamp ASC`,
      )
      .all(turnId, turnId) as MessageRow[];
    if (rows.length === 0) return null;
    // 窗口起点取本回合**最早**的消息（用户提问），不是助手回复：轨迹节点发生在
    // 「提问 → 回复」之间，拿回复时间当起点会把本回合的轨迹整段排除在外。
    // session_id 只落在助手消息上（用户消息为 NULL），所以单独挑一条非空的。
    return buildScope(taskId, rows[0], {
      sessionId: rows.find((r) => r.session_id)?.session_id ?? null,
      startIso: rows[0].timestamp,
      endAnchorIso: rows[rows.length - 1].timestamp,
    });
  }

  if (kind === 'sess') {
    const sessionId = rest.join(':');
    const row = db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ?
         ORDER BY timestamp ASC LIMIT 1`,
      )
      .get(sessionId) as MessageRow | undefined;
    if (!row) return null;
    return buildScope(taskId, row, { sessionId });
  }

  if (kind === 'msg') {
    const msgId = rest.join(':');
    const row = db.prepare('SELECT * FROM messages WHERE id = ? LIMIT 1').get(msgId) as
      | MessageRow
      | undefined;
    if (!row) return null;
    return buildScope(taskId, row);
  }

  if (kind === 'chat') {
    // chat:{jid}:{hourBucket} —— jid 本身含冒号，故用最后一个冒号切分。
    const lastColon = taskId.lastIndexOf(':');
    const chatJid = taskId.slice('chat:'.length, lastColon);
    const bucket = Number(taskId.slice(lastColon + 1));
    if (!chatJid || !Number.isFinite(bucket)) return null;
    const startMs = bucket * 3_600_000;
    return {
      taskId,
      chatJid,
      traceId: null,
      sessionId: null,
      startMs,
      endMs: startMs + 3_600_000,
    };
  }

  return null;
}

/**
 * 由锚点消息构造任务范围。
 *
 * `startIso` 与 `endAnchorIso` 分开传：多消息任务（`turn:`）的起点是本回合**最早**的
 * 消息，而右边界要从本回合**最晚**的消息往后找下一条。单消息任务两者相同，走默认值。
 */
function buildScope(
  taskId: string,
  row: MessageRow,
  opts: { sessionId?: string | null; startIso?: string; endAnchorIso?: string } = {},
): TaskScope {
  const db = getDb();
  const startMs = Date.parse(opts.startIso ?? row.timestamp);

  const next = db
    .prepare(
      `SELECT timestamp FROM messages
       WHERE chat_jid = ? AND timestamp > ?
       ORDER BY timestamp ASC LIMIT 1`,
    )
    .get(row.chat_jid, opts.endAnchorIso ?? row.timestamp) as { timestamp: string } | undefined;

  const nextMs = next ? Date.parse(next.timestamp) : NaN;
  // 兜底 10 分钟：下一条消息可能几小时后才来，那不属于本任务。
  const endMs = Number.isFinite(nextMs) ? Math.min(nextMs, startMs + 600_000) : startMs + 600_000;

  return {
    taskId,
    chatJid: row.chat_jid,
    traceId: findTraceId(row.chat_jid, startMs, endMs),
    sessionId: opts.sessionId ?? row.session_id ?? null,
    startMs,
    endMs,
  };
}

/** 时间窗内的 trace_id。取最近一条 —— 一次任务通常只有一条主 trace。 */
function findTraceId(chatJid: string, startMs: number, endMs: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT trace_id FROM trace_steps
       WHERE chat_jid = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at ASC LIMIT 1`,
    )
    .get(chatJid, iso(startMs), iso(endMs)) as { trace_id: string } | undefined;
  return row?.trace_id ?? null;
}

// ── 实体对齐（PRD F2.2）──────────────────────────────────────────────

/**
 * 为一条消息上挂的反馈解析出全部关联主键。
 *
 * `alignment` 的语义：
 *   - direct   ：能查到消息行，turn/session/chat 至少命中一个 → 置信度全额
 *   - fallback ：消息行不存在（例如消息已被清理），仅凭入参兜底 → 置信度打 0.6 折
 */
export function resolveKeysForMessage(input: {
  messageId: string;
  chatJid: string;
  occurredAt: number;
  fallbackSessionId?: string | null;
  fallbackTurnId?: string | null;
  stepId?: string | null;
}): ResolvedKeys {
  const row = getDb()
    .prepare('SELECT * FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1')
    .get(input.messageId, input.chatJid) as MessageRow | undefined;

  if (!row) {
    return {
      taskId: deriveTaskId({
        turnId: input.fallbackTurnId,
        sessionId: input.fallbackSessionId,
        messageId: input.messageId,
        chatJid: input.chatJid,
        occurredAt: input.occurredAt,
      }),
      traceId: null,
      sessionId: input.fallbackSessionId ?? null,
      stepId: input.stepId ?? null,
      chatJid: input.chatJid,
      alignment: 'fallback',
    };
  }

  const scope = buildScope('', row, { sessionId: input.fallbackSessionId ?? null });
  return {
    taskId: deriveTaskId({
      turnId: row.turn_id ?? input.fallbackTurnId,
      sessionId: row.session_id ?? input.fallbackSessionId,
      messageId: row.id,
      chatJid: row.chat_jid,
      occurredAt: Date.parse(row.timestamp),
    }),
    traceId: scope.traceId,
    sessionId: scope.sessionId,
    stepId: input.stepId ?? null,
    chatJid: row.chat_jid,
    alignment: 'direct',
  };
}

// ── 入库入口 ─────────────────────────────────────────────────────────

export interface IngestResult {
  event: NormalizedEvent;
  inserted: boolean;
  invalidRules: string[];
}

/**
 * 归一化 + 去重入库。采集层唯一写 flm_events 的入口。
 *
 * 两条路径，按草稿里带没带 `taskId` 分流：
 *   - 带了（系统/环境来源内部派生，自己就知道属于哪个任务）→ 直接用
 *   - 没带（UI 上报只给了 message_id）→ 走 resolveKeysForMessage 查库对齐
 * 前者不做二次查库是刻意的：派生方比查库更清楚归属，回查反而可能因时间窗漂移取错。
 */
export function ingest(draft: FeedbackDraft, config: FlmConfig = readConfig()): IngestResult {
  const keys: ResolvedKeys = draft.taskId
    ? {
        taskId: draft.taskId,
        traceId: draft.traceId ?? null,
        sessionId: draft.sessionId ?? null,
        stepId: draft.stepId ?? null,
        chatJid: draft.chatJid ?? null,
        alignment: 'direct',
      }
    : resolveKeysForMessage({
        messageId: (draft.rawPayload.message_id as string | undefined) ?? 'unknown',
        chatJid: draft.chatJid ?? 'unknown',
        occurredAt: draft.occurredAt,
        fallbackSessionId: draft.sessionId,
        stepId: draft.stepId,
      });

  const event = normalizeDraft(draft, keys, config);
  const inserted = insertEventIfNew({
    event_id: event.eventId,
    source: event.source,
    type: event.type,
    task_id: event.taskId,
    trace_id: event.traceId,
    session_id: event.sessionId,
    step_id: event.stepId,
    chat_jid: event.chatJid,
    user_id: event.userId,
    raw_payload: event.rawPayload,
    normalized_payload: event.normalizedPayload,
    confidence: event.confidence,
    weight: event.weight,
    alignment: event.alignment,
    dedup_key: event.dedupKey,
    desensitized: event.desensitized ? 1 : 0,
    conflict: 0,
    tenant_id: event.tenantId,
    occurred_at: event.occurredAt,
    created_at: Date.now(),
  });

  return { event, inserted, invalidRules: [] };
}

/**
 * 批量入库后统一做冲突消解（PRD F2.4）。
 *
 * 冲突标记必须**跨事件**才能判 —— 单条事件看不出"用户说失败但系统说成功"这个矛盾。
 * 所以放在批处理尾部，而不是 ingest 内部。
 */
export function markConflicts(taskId: string): number {
  const events = listEventsByTask(taskId);
  const conflicted = resolveConflicts(
    events.map((e) => ({
      eventId: e.event_id,
      source: e.source,
      confidence: e.confidence,
      weight: e.weight,
      type: e.type,
    })),
  );
  if (conflicted.size === 0) return 0;
  const db = getDb();
  const stmt = db.prepare('UPDATE flm_events SET conflict = 1 WHERE event_id = ?');
  for (const id of conflicted) stmt.run(id);
  return conflicted.size;
}

// ── 系统来源：从既有轨迹派生 ─────────────────────────────────────────

/**
 * 从一个任务的时间窗内派生系统反馈事件（PRD F1.2）。
 *
 * 刻意**不做逐节点事件**：轨迹明细已经在 chat_trace_nodes 里了，再复制一份到
 * flm_events 只会产生两处真相、两处不一致。评价引擎要的是聚合量（成功率、失败数、
 * token），所以这里按任务聚合，每个任务最多 3 条事件。
 *
 * 采样率（PRD AC-F1.2.2）：按 taskId 做 sha1 取模 —— 不用 Math.random，因为采样必须
 * **可复现**：同一个任务重跑采集，采到/采不到的结果必须一致，否则验收无法断言。
 */
export function deriveSystemDrafts(scope: TaskScope, config: FlmConfig = readConfig()): FeedbackDraft[] {
  const db = getDb();
  const from = iso(scope.startMs);
  const to = iso(scope.endMs);

  const nodes = db
    .prepare(
      `SELECT node_type, title, status, tokens FROM chat_trace_nodes
       WHERE chat_jid = ? AND started_at >= ? AND started_at < ?`,
    )
    .all(scope.chatJid, from, to) as Array<{
    node_type: string;
    title: string | null;
    status: string | null;
    tokens: number;
  }>;

  if (nodes.length === 0) return [];

  const calls = db
    .prepare(
      `SELECT tool_name, status FROM trace_tool_calls
       WHERE chat_jid = ? AND started_at >= ? AND started_at < ?`,
    )
    .all(scope.chatJid, from, to) as Array<{ tool_name: string; status: string | null }>;

  const okNode = nodes.filter((n) => n.status === 'done').length;
  const failedNode = nodes.filter((n) => n.status === 'failed').length;
  const okCall = calls.filter((c) => c.status === 'success').length;
  const failedCall = calls.filter((c) => c.status === 'error' || c.status === 'failed').length;
  const tokens = nodes.reduce((a, n) => a + (n.tokens || 0), 0);

  const drafts: FeedbackDraft[] = [];
  const base = {
    taskId: scope.taskId,
    traceId: scope.traceId,
    sessionId: scope.sessionId,
    chatJid: scope.chatJid,
    userId: null,
    occurredAt: scope.startMs,
  };

  // 采样：只对「信息量低」的成功事件采样；失败与超时永远采（负样本不能丢）。
  if (sampleHit(scope.taskId, config.sampleRate)) {
    drafts.push({
      ...base,
      source: 'system',
      type: 'system_tool_call',
      stepId: 'aggregate',
      rawPayload: { nodeTotal: nodes.length, nodeOk: okNode, callTotal: calls.length, callOk: okCall },
    });
  }

  if (failedNode > 0 || failedCall > 0) {
    drafts.push({
      ...base,
      source: 'system',
      type: 'system_error',
      stepId: 'aggregate',
      rawPayload: { nodeFailed: failedNode, callFailed: failedCall },
    });
  }

  if (tokens > 0) {
    drafts.push({
      ...base,
      source: 'system',
      type: 'system_token_usage',
      stepId: 'aggregate',
      rawPayload: { tokens },
    });
  }

  return drafts;
}

/** 确定性采样：sha1(taskId) 取模 100 < sampleRate。 */
function sampleHit(taskId: string, sampleRate: number): boolean {
  if (sampleRate >= 100) return true;
  if (sampleRate <= 0) return false;
  const h = createHash('sha1').update(taskId).digest('hex').slice(0, 8);
  return Number.parseInt(h, 16) % 100 < sampleRate;
}

// ── 环境来源：快照 diff ──────────────────────────────────────────────

export interface EnvObservation {
  name: string;
  /** 从观测路径取值后得到的字符串；不可用时为 null。 */
  value: string | null;
}

/** 拍一次环境快照（PRD F1.3）。观测点由 admin 配置，采集时逐条取值。 */
export function captureSnapshot(input: {
  taskId: string;
  phase: 'before' | 'after';
  observations: Array<{ name: string; path: string; expected: string | null }>;
  read: (path: string) => unknown;
  ttlSeconds?: number;
}): { id: string; values: Record<string, string | null> } {
  const id = `snap_${randomUUID()}`;
  const values: Record<string, string | null> = {};
  for (const o of input.observations) {
    try {
      const v = input.read(o.path);
      values[o.name] = v == null ? null : String(v);
    } catch {
      // 单个观测点读失败不能拖垮整个快照 —— 记为 null，diff 时按"无数据"处理。
      values[o.name] = null;
    }
  }
  insertSnapshot({
    id,
    task_id: input.taskId,
    phase: input.phase,
    payload: JSON.stringify(values),
    ttl_seconds: input.ttlSeconds ?? 86_400,
    expired: 0,
    captured_at: Date.now(),
  });
  return { id, values };
}

/**
 * 对比 before/after 快照，产出环境反馈事件（PRD F1.3、AC-F1.3）。
 *
 * verdict 三态：
 *   met    —— 全部有期望值的观测点都达到了期望
 *   unmet  —— 存在有期望值但未达到的观测点（这是最强的负信号）
 *   unknown—— 没有任何带期望值的观测点，无从判定
 */
export function diffSnapshots(
  taskId: string,
  expectedByPoint: Record<string, string | null>,
): FeedbackDraft | null {
  const snaps = listSnapshots(taskId).filter((s) => s.expired === 0);
  const before = snaps.find((s) => s.phase === 'before');
  const after = snaps.find((s) => s.phase === 'after');
  if (!before || !after) return null;

  const b = JSON.parse(before.payload) as Record<string, string | null>;
  const a = JSON.parse(after.payload) as Record<string, string | null>;

  const changed: Array<{ name: string; before: string | null; after: string | null }> = [];
  const unmet: string[] = [];
  const met: string[] = [];

  for (const name of Object.keys(a)) {
    const bv = b[name] ?? null;
    const av = a[name] ?? null;
    if (bv !== av) changed.push({ name, before: bv, after: av });

    const exp = expectedByPoint[name];
    if (exp == null) continue; // 没有期望值 = 只观测不判定
    if (av === exp) met.push(name);
    else unmet.push(name);
  }

  const verdict = unmet.length > 0 ? 'unmet' : met.length > 0 ? 'met' : 'unknown';

  return {
    source: 'env',
    type: 'env_snapshot_diff',
    taskId,
    traceId: null,
    sessionId: null,
    stepId: 'snapshot',
    chatJid: null,
    userId: null,
    rawPayload: { verdict, changed, unmet, met, beforeId: before.id, afterId: after.id },
    occurredAt: Date.now(),
  };
}

/** 清理过期快照（TTL 到期的标记 expired，不删除 —— 审计要留痕）。 */
export function expireStaleSnapshots(): number {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM flm_snapshots WHERE expired = 0')
    .all() as FlmSnapshotRow[];
  const now = Date.now();
  let n = 0;
  const stmt = db.prepare('UPDATE flm_snapshots SET expired = 1 WHERE id = ?');
  for (const r of rows) {
    if (now - r.captured_at > r.ttl_seconds * 1000) {
      stmt.run(r.id);
      n++;
    }
  }
  return n;
}

// ── 评价上下文装配 ───────────────────────────────────────────────────

function parseJsonObj(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * 装配三层评价所需的输入（PRD F3 的输入侧）。
 * 事件来自 flm_events（已归一化），轨迹来自既有表 —— 评价引擎本身不碰 DB。
 */
export function loadEvalContext(taskId: string): EvalContext | null {
  const scope = resolveTaskScope(taskId);
  if (!scope) return null;

  const events: FlmEventRow[] = listEventsByTask(taskId);
  const db = getDb();
  const from = iso(scope.startMs);
  const to = iso(scope.endMs);

  const nodeRows = db
    .prepare(
      `SELECT node_type, title, status, tokens, started_at, ended_at, output_summary
       FROM chat_trace_nodes
       WHERE chat_jid = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at ASC`,
    )
    .all(scope.chatJid, from, to) as Array<{
    node_type: string;
    title: string | null;
    status: string | null;
    tokens: number;
    started_at: string;
    ended_at: string | null;
    output_summary: string | null;
  }>;

  const callRows = db
    .prepare(
      `SELECT tool_name, status, started_at, ended_at, output_json
       FROM trace_tool_calls
       WHERE chat_jid = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at ASC`,
    )
    .all(scope.chatJid, from, to) as Array<{
    tool_name: string;
    status: string | null;
    started_at: string;
    ended_at: string | null;
    output_json: string | null;
  }>;

  const toolCalls: EvalToolCallInput[] = callRows.map((c) => ({
    toolName: c.tool_name,
    status: c.status,
    startedAt: toMs(c.started_at) ?? scope.startMs,
    endedAt: toMs(c.ended_at),
    output: (c.output_json ?? '').slice(0, 500),
  }));

  return {
    taskId,
    traceId: scope.traceId,
    sessionId: scope.sessionId,
    chatJid: scope.chatJid,
    events: events.map((e) => ({
      eventId: e.event_id,
      source: e.source,
      type: e.type,
      confidence: e.confidence,
      weight: e.weight,
      payload: parseJsonObj(e.normalized_payload),
      occurredAt: e.occurred_at,
    })),
    nodes: nodeRows.map((n) => ({
      nodeType: n.node_type,
      title: n.title,
      status: n.status,
      startedAt: toMs(n.started_at) ?? scope.startMs,
      endedAt: toMs(n.ended_at),
      tokens: n.tokens || 0,
      outputSummary: n.output_summary,
    })),
    toolCalls,
  };
}
