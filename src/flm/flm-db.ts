/**
 * FLM 数据访问层。
 *
 * 表结构在 src/db.ts 的 initDatabase() 里（与 SCHEMA_VERSION 同源），
 * 这里只做读写 —— 跟随 src/autonomy/ 的既有范式（用 db.ts 导出的 getDb()）。
 *
 * 所有 SQL 必须同时可在 SQLite 与 PostgreSQL 下执行：
 *   - 不用 ADD COLUMN IF NOT EXISTS（PG 专有语法，会打断 SQLite 批处理）
 *   - 不用 ON CONFLICT ... DO UPDATE（sql-translator 覆盖不全）→ 用 INSERT OR REPLACE
 *   - 不用 jsonb / now()；JSON 存 TEXT，时间统一 Date.now() 毫秒整数
 */

import { getDb } from '../db.js';
import type {
  ActionType,
  AttributionStage,
  Evaluator,
  FeedbackSource,
  FeedbackType,
  GateStatus,
  Outcome,
  SampleType,
  StrategyStatus,
  StrategyType,
  TriggerSource,
  KnowledgeStatus,
} from './flm-types.js';

// ── Row 类型 ─────────────────────────────────────────────────────────

export interface FlmFeedbackRow {
  id: string;
  message_id: string;
  chat_jid: string;
  user_id: string;
  session_id: string | null;
  turn_id: string | null;
  task_id: string | null;
  trace_id: string | null;
  step_id: string | null;
  type: FeedbackType;
  rating: number | null;
  reason_tags: string | null;
  correction_text: string | null;
  payload: string | null;
  skipped: number;
  created_at: number;
  updated_at: number;
}

export interface FlmEventRow {
  event_id: string;
  source: FeedbackSource;
  type: FeedbackType;
  task_id: string | null;
  trace_id: string | null;
  session_id: string | null;
  step_id: string | null;
  chat_jid: string | null;
  user_id: string | null;
  raw_payload: string | null;
  normalized_payload: string | null;
  confidence: number;
  weight: number;
  alignment: string;
  dedup_key: string;
  desensitized: number;
  conflict: number;
  tenant_id: string;
  occurred_at: number;
  created_at: number;
}

export interface FlmEvaluationRow {
  eval_id: string;
  task_id: string;
  trace_id: string | null;
  session_id: string | null;
  chat_jid: string | null;
  outcome: Outcome;
  outcome_reason: string | null;
  process_score: number;
  path_conformity: number;
  step_count: number;
  retry_count: number;
  first_anomaly_step: string | null;
  duration_ms: number;
  quality_scores: string | null;
  attribution_stage: AttributionStage | null;
  evidence_json: string | null;
  evaluator: Evaluator;
  needs_review: number;
  review_status: string;
  review_note: string | null;
  eval_time: number;
}

export interface FlmCaseRow {
  case_id: string;
  task_id: string | null;
  eval_id: string | null;
  sample_type: SampleType;
  goal: string;
  goal_embedding: string | null;
  summary: string | null;
  attribution_stage: AttributionStage | null;
  reuse_count: number;
  verified: number;
  source_event_id: string | null;
  created_at: number;
}

export interface FlmStrategyRow {
  version_id: string;
  strategy_type: StrategyType;
  name: string;
  content: string;
  parent_version: string | null;
  trigger_source: TriggerSource;
  attribution_tag: string | null;
  eval_report: string | null;
  gate_status: GateStatus;
  gray_ratio: number;
  status: StrategyStatus;
  requires_human_review: number;
  reviewed_by: string | null;
  publisher: string | null;
  publish_time: number | null;
  created_at: number;
  updated_at: number;
}

export interface FlmActionRow {
  action_id: string;
  eval_id: string | null;
  action_type: ActionType;
  before_version: string | null;
  after_version: string | null;
  executor: string;
  result: string;
  detail: string | null;
  exec_time: number;
}

export interface FlmObservationRow {
  id: string;
  name: string;
  path: string;
  expected: string | null;
  enabled: number;
  created_by: string | null;
  created_at: number;
}

export interface FlmSnapshotRow {
  id: string;
  task_id: string;
  phase: string;
  payload: string;
  ttl_seconds: number;
  expired: number;
  captured_at: number;
}

export interface FlmAlertRow {
  id: string;
  metric: string;
  threshold: string | null;
  actual: string | null;
  level: string;
  message: string;
  acked: number;
  created_at: number;
}

export interface FlmAuditRow {
  id: string;
  version_id: string | null;
  action: string;
  detail: string | null;
  actor: string | null;
  created_at: number;
}

// ── flm_feedback ─────────────────────────────────────────────────────

/**
 * 写入或更新用户反馈。
 * (message_id, chat_jid, user_id) 唯一 —— 同一用户对同一消息重复评价是更新
 * （PRD AC-F1.1.5）。返回该行的 id，调用方不需要知道是插入还是更新。
 */
export function upsertFeedback(row: {
  id: string;
  messageId: string;
  chatJid: string;
  userId: string;
  sessionId?: string | null;
  turnId?: string | null;
  taskId?: string | null;
  traceId?: string | null;
  stepId?: string | null;
  type: FeedbackType;
  rating?: number | null;
  reasonTags?: string[] | null;
  correctionText?: string | null;
  payload?: string | null;
  skipped?: boolean;
}): string {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare(
      'SELECT id FROM flm_feedback WHERE message_id = ? AND chat_jid = ? AND user_id = ?',
    )
    .get(row.messageId, row.chatJid, row.userId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE flm_feedback SET
         session_id = ?, turn_id = ?, task_id = ?, trace_id = ?, step_id = ?,
         type = ?, rating = ?, reason_tags = ?, correction_text = ?, payload = ?,
         skipped = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      row.sessionId ?? null,
      row.turnId ?? null,
      row.taskId ?? null,
      row.traceId ?? null,
      row.stepId ?? null,
      row.type,
      row.rating ?? null,
      row.reasonTags ? JSON.stringify(row.reasonTags) : null,
      row.correctionText ?? null,
      row.payload ?? null,
      row.skipped ? 1 : 0,
      now,
      existing.id,
    );
    return existing.id;
  }

  db.prepare(
    `INSERT INTO flm_feedback
       (id, message_id, chat_jid, user_id, session_id, turn_id, task_id, trace_id, step_id,
        type, rating, reason_tags, correction_text, payload, skipped, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.messageId,
    row.chatJid,
    row.userId,
    row.sessionId ?? null,
    row.turnId ?? null,
    row.taskId ?? null,
    row.traceId ?? null,
    row.stepId ?? null,
    row.type,
    row.rating ?? null,
    row.reasonTags ? JSON.stringify(row.reasonTags) : null,
    row.correctionText ?? null,
    row.payload ?? null,
    row.skipped ? 1 : 0,
    now,
    now,
  );
  return row.id;
}

export function getFeedbackForMessage(
  messageId: string,
  chatJid: string,
  userId: string,
): FlmFeedbackRow | undefined {
  return getDb()
    .prepare(
      'SELECT * FROM flm_feedback WHERE message_id = ? AND chat_jid = ? AND user_id = ?',
    )
    .get(messageId, chatJid, userId) as FlmFeedbackRow | undefined;
}

export function listFeedback(limit = 100, offset = 0): FlmFeedbackRow[] {
  return getDb()
    .prepare('SELECT * FROM flm_feedback ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as FlmFeedbackRow[];
}

// ── flm_events ───────────────────────────────────────────────────────

/** 写入事件。dedup_key 冲突时返回 false（调用方据此跳过）—— PRD F2.5 去重。 */
export function insertEventIfNew(row: FlmEventRow): boolean {
  const db = getDb();
  const dup = db
    .prepare('SELECT event_id FROM flm_events WHERE dedup_key = ?')
    .get(row.dedup_key) as { event_id: string } | undefined;
  if (dup) {
    // 已存在：提升置信度取 max（重复观测提高可信度，但不重复计分）。
    db.prepare('UPDATE flm_events SET confidence = ? WHERE event_id = ?').run(
      Math.max(row.confidence, 0),
      dup.event_id,
    );
    return false;
  }
  db.prepare(
    `INSERT INTO flm_events
       (event_id, source, type, task_id, trace_id, session_id, step_id, chat_jid, user_id,
        raw_payload, normalized_payload, confidence, weight, alignment, dedup_key,
        desensitized, conflict, tenant_id, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.event_id,
    row.source,
    row.type,
    row.task_id,
    row.trace_id,
    row.session_id,
    row.step_id,
    row.chat_jid,
    row.user_id,
    row.raw_payload,
    row.normalized_payload,
    row.confidence,
    row.weight,
    row.alignment,
    row.dedup_key,
    row.desensitized ? 1 : 0,
    row.conflict ? 1 : 0,
    row.tenant_id,
    row.occurred_at,
    row.created_at,
  );
  return true;
}

export function listEvents(opts: {
  source?: FeedbackSource;
  taskId?: string;
  limit?: number;
  offset?: number;
} = {}): FlmEventRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.source) {
    where.push('source = ?');
    params.push(opts.source);
  }
  if (opts.taskId) {
    where.push('task_id = ?');
    params.push(opts.taskId);
  }
  const sql =
    `SELECT * FROM flm_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}` +
    ' ORDER BY occurred_at DESC LIMIT ? OFFSET ?';
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  return getDb().prepare(sql).all(...params) as FlmEventRow[];
}

export function listEventsByTask(taskId: string): FlmEventRow[] {
  return getDb()
    .prepare('SELECT * FROM flm_events WHERE task_id = ? ORDER BY occurred_at ASC')
    .all(taskId) as FlmEventRow[];
}

/** 有反馈事件的任务 id（按最近活动倒序）—— 评价批次的输入。 */
export function listTaskIdsWithEvents(limit = 50): string[] {
  const rows = getDb()
    .prepare(
      `SELECT task_id, MAX(occurred_at) AS last_at FROM flm_events
       WHERE task_id IS NOT NULL AND task_id != ''
       GROUP BY task_id ORDER BY last_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{ task_id: string }>;
  return rows.map((r) => r.task_id);
}

// ── flm_evaluations ──────────────────────────────────────────────────

export function insertEvaluation(row: Omit<FlmEvaluationRow, 'eval_id'> & { eval_id: string }): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO flm_evaluations
         (eval_id, task_id, trace_id, session_id, chat_jid, outcome, outcome_reason,
          process_score, path_conformity, step_count, retry_count, first_anomaly_step,
          duration_ms, quality_scores, attribution_stage, evidence_json, evaluator,
          needs_review, review_status, review_note, eval_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.eval_id,
      row.task_id,
      row.trace_id,
      row.session_id,
      row.chat_jid,
      row.outcome,
      row.outcome_reason,
      row.process_score,
      row.path_conformity,
      row.step_count,
      row.retry_count,
      row.first_anomaly_step,
      row.duration_ms,
      row.quality_scores,
      row.attribution_stage,
      row.evidence_json,
      row.evaluator,
      row.needs_review,
      row.review_status,
      row.review_note,
      row.eval_time,
    );
}

export function listEvaluations(opts: {
  outcome?: Outcome;
  stage?: AttributionStage;
  needsReview?: boolean;
  limit?: number;
  offset?: number;
} = {}): FlmEvaluationRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.outcome) {
    where.push('outcome = ?');
    params.push(opts.outcome);
  }
  if (opts.stage) {
    where.push('attribution_stage = ?');
    params.push(opts.stage);
  }
  if (opts.needsReview) {
    where.push('needs_review = 1');
  }
  const sql =
    `SELECT * FROM flm_evaluations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}` +
    ' ORDER BY eval_time DESC LIMIT ? OFFSET ?';
  params.push(opts.limit ?? 100, opts.offset ?? 0);
  return getDb().prepare(sql).all(...params) as FlmEvaluationRow[];
}

export function getEvaluation(evalId: string): FlmEvaluationRow | undefined {
  return getDb()
    .prepare('SELECT * FROM flm_evaluations WHERE eval_id = ?')
    .get(evalId) as FlmEvaluationRow | undefined;
}

export function resolveReview(evalId: string, note: string, actor: string): boolean {
  const res = getDb()
    .prepare(
      `UPDATE flm_evaluations SET review_status = 'resolved', review_note = ?, evaluator = 'human'
       WHERE eval_id = ? AND needs_review = 1`,
    )
    .run(`${actor}: ${note}`, evalId);
  return res.changes > 0;
}

/** 批量取评价，供案例沉淀与看板聚合复用。 */
export function listEvaluationsByTask(taskId: string): FlmEvaluationRow[] {
  return getDb()
    .prepare('SELECT * FROM flm_evaluations WHERE task_id = ? ORDER BY eval_time DESC')
    .all(taskId) as FlmEvaluationRow[];
}

// ── flm_cases ────────────────────────────────────────────────────────

export function insertCase(row: FlmCaseRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO flm_cases
         (case_id, task_id, eval_id, sample_type, goal, goal_embedding, summary,
          attribution_stage, reuse_count, verified, source_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.case_id,
      row.task_id,
      row.eval_id,
      row.sample_type,
      row.goal,
      row.goal_embedding,
      row.summary,
      row.attribution_stage,
      row.reuse_count,
      row.verified,
      row.source_event_id,
      row.created_at,
    );
}

export function getCase(caseId: string): FlmCaseRow | undefined {
  return getDb().prepare('SELECT * FROM flm_cases WHERE case_id = ?').get(caseId) as
    | FlmCaseRow
    | undefined;
}

export function listCases(opts: {
  sampleType?: SampleType;
  stage?: AttributionStage;
  limit?: number;
  offset?: number;
} = {}): FlmCaseRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sampleType) {
    where.push('sample_type = ?');
    params.push(opts.sampleType);
  }
  if (opts.stage) {
    where.push('attribution_stage = ?');
    params.push(opts.stage);
  }
  const sql =
    `SELECT * FROM flm_cases ${where.length ? 'WHERE ' + where.join(' AND ') : ''}` +
    ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(opts.limit ?? 200, opts.offset ?? 0);
  return getDb().prepare(sql).all(...params) as FlmCaseRow[];
}

/** 全部案例（检索用）。本模块案例规模是千级，全量拉回内存算相似度即可。 */
export function allCases(): FlmCaseRow[] {
  return getDb()
    .prepare('SELECT * FROM flm_cases ORDER BY created_at DESC')
    .all() as FlmCaseRow[];
}

/** 人工修正归因标签（PRD F6.3 / AC-F6.3）。 */
export function updateCaseStage(caseId: string, stage: AttributionStage): boolean {
  const res = getDb()
    .prepare('UPDATE flm_cases SET attribution_stage = ?, verified = 1 WHERE case_id = ?')
    .run(stage, caseId);
  return res.changes > 0;
}

export function bumpCaseReuse(caseId: string): void {
  getDb().prepare('UPDATE flm_cases SET reuse_count = reuse_count + 1 WHERE case_id = ?').run(caseId);
}

// ── flm_strategies ───────────────────────────────────────────────────

export function insertStrategy(row: FlmStrategyRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO flm_strategies
         (version_id, strategy_type, name, content, parent_version, trigger_source,
          attribution_tag, eval_report, gate_status, gray_ratio, status,
          requires_human_review, reviewed_by, publisher, publish_time, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.version_id,
      row.strategy_type,
      row.name,
      row.content,
      row.parent_version,
      row.trigger_source,
      row.attribution_tag,
      row.eval_report,
      row.gate_status,
      row.gray_ratio,
      row.status,
      row.requires_human_review,
      row.reviewed_by,
      row.publisher,
      row.publish_time,
      row.created_at,
      row.updated_at,
    );
}

export function getStrategy(versionId: string): FlmStrategyRow | undefined {
  return getDb()
    .prepare('SELECT * FROM flm_strategies WHERE version_id = ?')
    .get(versionId) as FlmStrategyRow | undefined;
}

export function listStrategies(opts: {
  status?: StrategyStatus;
  strategyType?: StrategyType;
  limit?: number;
} = {}): FlmStrategyRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.strategyType) {
    where.push('strategy_type = ?');
    params.push(opts.strategyType);
  }
  const sql =
    `SELECT * FROM flm_strategies ${where.length ? 'WHERE ' + where.join(' AND ') : ''}` +
    ' ORDER BY created_at DESC LIMIT ?';
  params.push(opts.limit ?? 200);
  return getDb().prepare(sql).all(...params) as FlmStrategyRow[];
}

/** 当前生效的版本（released 优先，其次 canary）—— 按策略类型。 */
export function activeStrategy(strategyType: StrategyType): FlmStrategyRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM flm_strategies
       WHERE strategy_type = ? AND status IN ('released','canary')
       ORDER BY CASE status WHEN 'released' THEN 0 ELSE 1 END, publish_time DESC,
                created_at DESC, version_id DESC LIMIT 1`,
    )
    .get(strategyType) as FlmStrategyRow | undefined;
}

/**
 * 下一个发布时间戳 —— 保证**严格单调递增**。
 *
 * `publish_time` 只有毫秒精度，而连续放量（门禁通过后立刻灰度、或脚本批量发布）很容易
 * 落在同一毫秒上。一旦撞上，`ORDER BY publish_time DESC` 就不再是一个全序：
 * `findPreviousStable` 会挑到错误的回滚目标，`activeStrategy` 会选出不确定的生效版本。
 * 让新值严格大于既有最大值，把"谁更晚发布"变成可判定的 —— 代价是极端情况下时间戳
 * 比真实时刻多出几毫秒，换来的是回滚目标与生效版本的确定性。
 */
export function nextPublishTime(): number {
  const row = getDb()
    .prepare('SELECT MAX(publish_time) AS m FROM flm_strategies')
    .get() as { m: number | null } | undefined;
  return Math.max(Date.now(), (row?.m ?? 0) + 1);
}

export function updateStrategyStatus(
  versionId: string,
  patch: {
    status?: StrategyStatus;
    grayRatio?: number;
    gateStatus?: GateStatus;
    evalReport?: string | null;
    publisher?: string | null;
    publishTime?: number | null;
    reviewedBy?: string | null;
  },
): boolean {
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Date.now()];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.grayRatio !== undefined) {
    sets.push('gray_ratio = ?');
    params.push(patch.grayRatio);
  }
  if (patch.gateStatus !== undefined) {
    sets.push('gate_status = ?');
    params.push(patch.gateStatus);
  }
  if (patch.evalReport !== undefined) {
    sets.push('eval_report = ?');
    params.push(patch.evalReport);
  }
  if (patch.publisher !== undefined) {
    sets.push('publisher = ?');
    params.push(patch.publisher);
  }
  if (patch.publishTime !== undefined) {
    sets.push('publish_time = ?');
    params.push(patch.publishTime);
  }
  if (patch.reviewedBy !== undefined) {
    sets.push('reviewed_by = ?');
    params.push(patch.reviewedBy);
  }
  params.push(versionId);
  const res = getDb()
    .prepare(`UPDATE flm_strategies SET ${sets.join(', ')} WHERE version_id = ?`)
    .run(...params);
  return res.changes > 0;
}

// ── flm_actions ──────────────────────────────────────────────────────

export function insertAction(row: FlmActionRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO flm_actions
         (action_id, eval_id, action_type, before_version, after_version, executor, result, detail, exec_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.action_id,
      row.eval_id,
      row.action_type,
      row.before_version,
      row.after_version,
      row.executor,
      row.result,
      row.detail,
      row.exec_time,
    );
}

export function listActions(limit = 100): FlmActionRow[] {
  return getDb()
    .prepare('SELECT * FROM flm_actions ORDER BY exec_time DESC LIMIT ?')
    .all(limit) as FlmActionRow[];
}

// ── flm_observations / flm_snapshots ─────────────────────────────────

export function insertObservation(row: FlmObservationRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO flm_observations (id, name, path, expected, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.name, row.path, row.expected, row.enabled, row.created_by, row.created_at);
}

export function listObservations(): FlmObservationRow[] {
  return getDb()
    .prepare('SELECT * FROM flm_observations ORDER BY created_at DESC')
    .all() as FlmObservationRow[];
}

export function deleteObservation(id: string): boolean {
  return getDb().prepare('DELETE FROM flm_observations WHERE id = ?').run(id).changes > 0;
}

export function insertSnapshot(row: FlmSnapshotRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO flm_snapshots (id, task_id, phase, payload, ttl_seconds, expired, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.task_id, row.phase, row.payload, row.ttl_seconds, row.expired, row.captured_at);
}

export function listSnapshots(taskId: string): FlmSnapshotRow[] {
  return getDb()
    .prepare('SELECT * FROM flm_snapshots WHERE task_id = ? ORDER BY captured_at ASC')
    .all(taskId) as FlmSnapshotRow[];
}

export function markSnapshotsExpired(taskId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare('UPDATE flm_snapshots SET expired = 1 WHERE id = ?');
  for (const id of ids) stmt.run(id);
  void taskId;
}

// ── flm_alerts ───────────────────────────────────────────────────────

export function insertAlert(row: FlmAlertRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO flm_alerts (id, metric, threshold, actual, level, message, acked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.metric, row.threshold, row.actual, row.level, row.message, row.acked, row.created_at);
}

export function listAlerts(limit = 100): FlmAlertRow[] {
  return getDb()
    .prepare('SELECT * FROM flm_alerts ORDER BY created_at DESC LIMIT ?')
    .all(limit) as FlmAlertRow[];
}

export function ackAlert(id: string): boolean {
  return getDb().prepare('UPDATE flm_alerts SET acked = 1 WHERE id = ?').run(id).changes > 0;
}

// ── flm_audit ────────────────────────────────────────────────────────

export function insertAudit(row: FlmAuditRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO flm_audit (id, version_id, action, detail, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.version_id, row.action, row.detail, row.actor, row.created_at);
}

export function listAudit(opts: { versionId?: string; limit?: number } = {}): FlmAuditRow[] {
  if (opts.versionId) {
    return getDb()
      .prepare('SELECT * FROM flm_audit WHERE version_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(opts.versionId, opts.limit ?? 200) as FlmAuditRow[];
  }
  return getDb()
    .prepare('SELECT * FROM flm_audit ORDER BY created_at DESC LIMIT ?')
    .all(opts.limit ?? 200) as FlmAuditRow[];
}

// ── flm_knowledge（PRD F4.7）─────────────────────────────────────────

export interface FlmKnowledgeRow {
  id: string;
  title: string;
  content: string;
  source_event_id: string | null;
  source_task_id: string | null;
  status: KnowledgeStatus;
  reviewer: string | null;
  review_note: string | null;
  reviewed_at: number | null;
  created_at: number;
}

export function insertKnowledge(row: FlmKnowledgeRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO flm_knowledge
         (id, title, content, source_event_id, source_task_id, status, reviewer, review_note, reviewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.title,
      row.content,
      row.source_event_id,
      row.source_task_id,
      row.status,
      row.reviewer,
      row.review_note,
      row.reviewed_at,
      row.created_at,
    );
}

export function getKnowledge(id: string): FlmKnowledgeRow | undefined {
  return getDb().prepare('SELECT * FROM flm_knowledge WHERE id = ?').get(id) as
    | FlmKnowledgeRow
    | undefined;
}

export function listKnowledge(status?: KnowledgeStatus, limit = 200): FlmKnowledgeRow[] {
  if (status) {
    return getDb()
      .prepare('SELECT * FROM flm_knowledge WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(status, limit) as FlmKnowledgeRow[];
  }
  return getDb()
    .prepare('SELECT * FROM flm_knowledge ORDER BY created_at DESC LIMIT ?')
    .all(limit) as FlmKnowledgeRow[];
}

/** 审核知识条目。只有 pending 能被裁决 —— 已裁决的不可反复翻转，避免审计线断掉。 */
export function reviewKnowledge(
  id: string,
  decision: 'accepted' | 'rejected',
  reviewer: string,
  note: string,
): boolean {
  const res = getDb()
    .prepare(
      `UPDATE flm_knowledge SET status = ?, reviewer = ?, review_note = ?, reviewed_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(decision, reviewer, note, Date.now(), id);
  return res.changes > 0;
}
