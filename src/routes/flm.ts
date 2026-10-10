/**
 * FLM（反馈与学习自进化模块）API。
 *
 * 权限分两层，这是刻意的：
 *   - 反馈入口（POST /feedback 等）—— **登录用户即可**，因为反馈是用户行为
 *   - 控制台与闭环（/api/flm/admin/*）—— **admin only**，因为里面是跨会话的全局
 *     策略、审计与原始反馈原文（含未脱敏 raw_payload）
 *
 * 降级（AC-F0.1、AC-F0.2）：所有入口在 enabled=false 时返回 200 + `degraded: true`，
 * 不报错。理由是前端不该因为 FLM 关了就显示红色错误 —— 关掉是正常运维动作，不是故障。
 * 每条路由都包在 try/catch 里，任何异常都吞成 200/500 而**绝不向上抛**，
 * 保证反馈链路的故障不会污染消息收发主链路。
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Variables } from '../web-context.js';
import { authMiddleware, adminRoleMiddleware } from '../middleware/auth.js';
import { readConfig, writeConfig, isEnabled } from '../flm/flm-config.js';
import {
  ackAlert,
  allCases,
  deleteObservation,
  getEvaluation,
  getFeedbackForMessage,
  getStrategy,
  insertObservation,
  listActions,
  listAlerts,
  listAudit,
  listEvents,
  listEvaluations,
  listFeedback,
  listKnowledge,
  listObservations,
  listStrategies,
  resolveReview,
  reviewKnowledge,
  updateCaseStage,
  upsertFeedback,
} from '../flm/flm-db.js';
import {
  captureSnapshot,
  deriveSystemDrafts,
  diffSnapshots,
  ingest,
  loadEvalContext,
  markConflicts,
  resolveTaskScope,
  resolveKeysForMessage,
  expireStaleSnapshots,
} from '../flm/flm-collect.js';
import { evaluateTask, qualityMean } from '../flm/flm-evaluate.js';
import {
  buildDataFeedback,
  buildKnowledgeCandidates,
  learnFromEvaluations,
  persistKnowledgeCandidates,
  planCorrection,
  executeCorrection,
  searchCases,
  recentEvaluations,
} from '../flm/flm-learn.js';
import {
  approveHumanReview,
  autoRollback,
  compareVersions,
  isInCanary,
  setCanary,
  submitForGate,
} from '../flm/flm-closedloop.js';
import {
  attributionView,
  consoleSnapshot,
  currentVsBaseline,
  evaluateAlerts,
  raiseAlerts,
  taskTimeline,
} from '../flm/flm-insights.js';
import {
  REASON_TAGS,
  ATTRIBUTION_STAGES,
  type AttributionStage,
  type FeedbackType,
} from '../flm/flm-types.js';

const router = new Hono<{ Variables: Variables }>();

router.use('*', authMiddleware);

/** FLM 关闭时的统一响应（AC-F0.1）。 */
function degraded(c: any) {
  return c.json({ degraded: true, enabled: false, message: 'FLM 已降级关闭，采集与评价暂停' });
}

/** 包住 handler，任何异常都不外抛（AC-F0.2）。 */
function safe(handler: (c: any) => Promise<any> | any) {
  return async (c: any) => {
    try {
      return await handler(c);
    } catch (err) {
      // 不 re-throw：FLM 的任何故障都不允许阻断主链路。
      return c.json({ error: 'FLM 内部错误', detail: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
}

const USER_FEEDBACK_TYPES: ReadonlySet<FeedbackType> = new Set([
  'explicit_like',
  'explicit_reject',
  'explicit_rating',
  'explicit_adopt',
  'explicit_correction',
  'implicit_reask',
  'implicit_rewrite',
  'implicit_abandon',
]);

// ── 健康与配置 ───────────────────────────────────────────────────────

router.get('/health', safe((c) => {
  return c.json({
    enabled: isEnabled(),
    reasonTags: REASON_TAGS,
    attributionStages: ATTRIBUTION_STAGES,
    serverTime: Date.now(),
  });
}));

router.get('/config', adminRoleMiddleware, safe((c) => {
  return c.json({ config: readConfig() });
}));

router.put('/config', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const user = c.get('user');
  const updated = writeConfig(body, user?.username ?? 'admin');
  return c.json({ config: updated });
}));

// ── F1 反馈采集 ──────────────────────────────────────────────────────

/**
 * 提交/更新一条用户反馈（AC-F1.1.5 幂等）。
 *
 * 前端只需要给 messageId + chatJid + type，其余主键由服务端对齐 —— 让前端去猜
 * turn_id / task_id 只会引入不一致。
 */
router.post('/feedback', safe(async (c) => {
  if (!isEnabled()) return degraded(c);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'Invalid body' }, 400);

  const messageId = typeof body.messageId === 'string' ? body.messageId : null;
  const chatJid = typeof body.chatJid === 'string' ? body.chatJid : null;
  const type = typeof body.type === 'string' ? (body.type as FeedbackType) : null;
  if (!messageId || !chatJid || !type) {
    return c.json({ error: 'messageId / chatJid / type 必填' }, 400);
  }
  if (!USER_FEEDBACK_TYPES.has(type)) {
    return c.json({ error: `不支持的反馈类型：${type}` }, 400);
  }

  const rating = typeof body.rating === 'number' ? body.rating : null;
  if (rating != null && (rating < 1 || rating > 5)) {
    return c.json({ error: 'rating 必须在 1–5 之间' }, 400);
  }

  const reasonTags = Array.isArray(body.reasonTags)
    ? (body.reasonTags as unknown[]).filter((t): t is string => typeof t === 'string')
    : null;
  // 点踩原因必须来自预置枚举 —— 自由文本的原因无法聚合分析，等于没采。
  if (reasonTags) {
    const invalid = reasonTags.filter((t) => !(REASON_TAGS as readonly string[]).includes(t));
    if (invalid.length > 0) {
      return c.json({ error: `非法原因标签：${invalid.join('、')}` }, 400);
    }
  }

  const user = c.get('user');
  const occurredAt = Date.now();

  const keys = resolveKeysForMessage({
    messageId,
    chatJid,
    occurredAt,
    fallbackSessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
  });

  const id = upsertFeedback({
    id: `fb_${randomUUID()}`,
    messageId,
    chatJid,
    userId: user?.id ?? user?.username ?? 'anonymous',
    sessionId: keys.sessionId,
    turnId: typeof body.turnId === 'string' ? body.turnId : null,
    taskId: keys.taskId,
    traceId: keys.traceId,
    stepId: null,
    type,
    rating,
    reasonTags,
    correctionText: typeof body.correctionText === 'string' ? body.correctionText : null,
    payload: JSON.stringify({
      message_id: messageId,
      reason_tags: reasonTags ?? [],
      rating,
      correction_text: body.correctionText ?? null,
    }),
    skipped: body.skipped === true,
  });

  // 同步归一化进事件流。失败不影响反馈本体已落库这个事实。
  const normalized = ingest({
    source: 'user',
    type,
    taskId: keys.taskId,
    traceId: keys.traceId,
    sessionId: keys.sessionId,
    chatJid,
    userId: user?.id ?? user?.username ?? 'anonymous',
    rawPayload: {
      message_id: messageId,
      rating,
      reason_tags: reasonTags ?? [],
      correction_text: body.correctionText ?? null,
    },
    occurredAt,
  });

  const conflicts = keys.taskId ? markConflicts(keys.taskId) : 0;

  return c.json({
    ok: true,
    feedbackId: id,
    taskId: keys.taskId,
    alignment: keys.alignment,
    eventInserted: normalized.inserted,
    desensitized: normalized.event.desensitized,
    conflictsMarked: conflicts,
    degraded: false,
  });
}));

/** 读取某条消息上当前用户的反馈（用于前端回显已选状态）。 */
router.get('/feedback/mine', safe((c) => {
  const messageId = c.req.query('messageId');
  const chatJid = c.req.query('chatJid');
  if (!messageId || !chatJid) return c.json({ error: 'messageId / chatJid 必填' }, 400);
  const user = c.get('user');
  const row = getFeedbackForMessage(messageId, chatJid, user?.id ?? user?.username ?? 'anonymous');
  if (!row) return c.json({ feedback: null });
  return c.json({
    feedback: {
      type: row.type,
      rating: row.rating,
      reasonTags: row.reason_tags ? JSON.parse(row.reason_tags) : [],
      correctionText: row.correction_text,
      updatedAt: row.updated_at,
    },
  });
}));

/** 采集系统来源事件 —— 从既有轨迹表派生（不给主链路加埋点）。 */
router.post('/admin/collect/system', adminRoleMiddleware, safe(async (c) => {
  if (!isEnabled()) return degraded(c);
  const body = (await c.req.json().catch(() => ({}))) as { taskId?: string };
  const taskId = body.taskId ?? c.req.query('taskId') ?? '';
  if (!taskId) return c.json({ error: 'taskId 必填' }, 400);

  const scope = resolveTaskScope(taskId);
  if (!scope) return c.json({ error: '无法解析该任务的时间范围' }, 404);

  const config = readConfig();
  const drafts = deriveSystemDrafts(scope, config);
  let inserted = 0;
  for (const d of drafts) if (ingest(d, config).inserted) inserted++;

  return c.json({ ok: true, scope, derived: drafts.length, inserted });
}));

/** 环境快照 TTL 清理（AC-F1.3）。 */
router.post('/admin/snapshots/expire', adminRoleMiddleware, safe(() => {
  return Response.json({ expired: expireStaleSnapshots() });
}));

// ── 环境观测点与快照（PRD F1.3 / AC-F1.3.1 – AC-F1.3.3）──────────────

/** 观测点列表（AC-F1.3.1）。 */
router.get('/admin/observations', adminRoleMiddleware, safe(() => {
  return Response.json({ observations: listObservations() });
}));

/**
 * 注册一个环境观测点（AC-F1.3.1、TC-FLM-08）：名称 + 取值路径 + 期望值。
 *
 * 观测点定义留在服务端，调用方提交快照时只给值 —— 让业务侧决定"看哪些字段"
 * 等于把判定口径交出去，diff 结论就不可信了。
 */
router.post('/admin/observations', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!name || !path) return c.json({ error: 'name / path 必填' }, 400);

  const user = c.get('user');
  const id = `obs_${randomUUID()}`;
  insertObservation({
    id,
    name,
    path,
    expected: typeof body.expected === 'string' ? body.expected : null,
    enabled: body.enabled === false ? 0 : 1,
    created_by: user?.username ?? 'admin',
    created_at: Date.now(),
  });
  return c.json({ ok: true, id, name, path });
}));

/** 删除观测点（AC-F1.3.1）。 */
router.delete('/admin/observations/:id', adminRoleMiddleware, safe((c) => {
  return c.json({ ok: deleteObservation(c.req.param('id')) });
}));

/**
 * 提交一次环境快照（AC-F1.3.2 的输入侧）。
 *
 * `values` 以观测点的 **path** 为键 —— 与 `captureSnapshot` 的 `read(path)` 契约对齐。
 * 观测点尚未注册时直接拒绝：拍一张没人关心的快照没有意义，还会污染后续 diff。
 */
router.post('/admin/snapshots', adminRoleMiddleware, safe(async (c) => {
  if (!isEnabled()) return degraded(c);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  const phase = body.phase === 'after' ? 'after' : body.phase === 'before' ? 'before' : null;
  if (!taskId || !phase) return c.json({ error: 'taskId / phase(before|after) 必填' }, 400);

  const observations = listObservations().filter((o) => o.enabled === 1);
  if (observations.length === 0) return c.json({ error: '尚未注册任何环境观测点' }, 400);

  const values = (
    body.values && typeof body.values === 'object' ? body.values : {}
  ) as Record<string, unknown>;

  const snap = captureSnapshot({
    taskId,
    phase,
    observations: observations.map((o) => ({ name: o.name, path: o.path, expected: o.expected })),
    // 未提供的观测点记 null（"无数据"），而不是拿默认值冒充观测结果。
    read: (path) => (path in values ? values[path] : null),
    ttlSeconds: typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
  });
  return c.json({ ok: true, snapshotId: snap.id, values: snap.values });
}));

/** 前后快照 diff → 产出 `source='env'` 事件（AC-F1.3.2 / TC-FLM-09）。 */
router.post('/admin/snapshots/:taskId/diff', adminRoleMiddleware, safe((c) => {
  if (!isEnabled()) return degraded(c);

  const taskId = c.req.param('taskId');
  const expected: Record<string, string | null> = {};
  for (const o of listObservations()) {
    if (o.enabled === 1) expected[o.name] = o.expected;
  }

  const draft = diffSnapshots(taskId, expected);
  if (!draft) return c.json({ error: '缺少有效的 before/after 快照（或已过期）' }, 404);

  const res = ingest(draft);
  return c.json({
    ok: true,
    verdict: draft.rawPayload.verdict,
    changed: draft.rawPayload.changed,
    unmet: draft.rawPayload.unmet,
    met: draft.rawPayload.met,
    eventId: res.event.eventId,
    inserted: res.inserted,
  });
}));

// ── F2/F3 归一化与三层评价 ───────────────────────────────────────────

/** 对一批任务触发三层评价（TC-FLM-13）。 */
router.post('/admin/evaluate', adminRoleMiddleware, safe(async (c) => {
  if (!isEnabled()) return degraded(c);
  const body = (await c.req.json().catch(() => ({}))) as { taskIds?: string[]; taskId?: string; useLlm?: boolean };
  const ids = body.taskIds ?? (body.taskId ? [body.taskId] : []);
  if (ids.length === 0) return c.json({ error: 'taskIds 必填' }, 400);

  const results: Array<Record<string, unknown>> = [];
  const evaluations = [];

  for (const taskId of ids.slice(0, 200)) {
    const ctx = loadEvalContext(taskId);
    if (!ctx) {
      results.push({ taskId, skipped: '无法解析任务范围' });
      continue;
    }
    const out = evaluateTask(ctx, { useLlm: body.useLlm === true });
    evaluations.push(out);
    results.push({
      taskId,
      evalId: out.evalId,
      outcome: out.outcome,
      processScore: out.processScore,
      qualityMean: qualityMean(out.qualityScores),
      attributionStage: out.attributionStage,
      evidenceCount: out.evidence.length,
      needsReview: out.needsReview,
    });
  }

  return c.json({ ok: true, evaluated: evaluations.length, results });
}));

/** 评价列表（控制台 + 复核队列）。 */
router.get('/admin/evaluations', adminRoleMiddleware, safe((c) => {
  const rows = listEvaluations({
    outcome: (c.req.query('outcome') as never) ?? undefined,
    stage: (c.req.query('stage') as AttributionStage) ?? undefined,
    needsReview: c.req.query('needsReview') === '1',
    limit: Number(c.req.query('limit') ?? 100),
  });
  return c.json({
    evaluations: rows.map((r) => ({
      ...r,
      qualityScores: r.quality_scores ? JSON.parse(r.quality_scores) : {},
      evidence: r.evidence_json ? JSON.parse(r.evidence_json) : [],
    })),
  });
}));

/** 人工复核双轨不一致的评价（TC-FLM-15）。 */
router.post('/admin/evaluations/:evalId/review', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  const user = c.get('user');
  const ok = resolveReview(c.req.param('evalId'), body.note ?? '', user?.username ?? 'admin');
  if (!ok) return c.json({ error: '该评价不存在或不需要复核' }, 404);
  return c.json({ ok: true });
}));

// ── F4 学习 ──────────────────────────────────────────────────────────

/** 从一批评价沉淀案例与策略建议（TC-FLM-18）。 */
router.post('/admin/learn', adminRoleMiddleware, safe(async (c) => {
  if (!isEnabled()) return degraded(c);
  const body = (await c.req.json().catch(() => ({}))) as { taskIds?: string[]; limit?: number };
  const evals = recentEvaluations(body.limit ?? 200).filter((e) =>
    body.taskIds && body.taskIds.length > 0 ? body.taskIds.includes(e.task_id) : true,
  );

  const goalByTask = new Map<string, { goal: string; summary: string | null }>();
  for (const e of evals) {
    const ctx = loadEvalContext(e.task_id);
    const firstFeedback = ctx?.events.find((x) => x.source === 'user');
    goalByTask.set(e.task_id, {
      goal: String(firstFeedback?.payload.goal ?? firstFeedback?.payload.correction_text ?? e.task_id),
      summary: e.outcome_reason,
    });
  }

  const result = learnFromEvaluations(evals, goalByTask);
  return c.json({ ok: true, ...result });
}));

/** 案例检索（TC-FLM-17）。 */
router.get('/admin/cases/search', adminRoleMiddleware, safe((c) => {
  const q = c.req.query('q') ?? '';
  const topK = Number(c.req.query('topK') ?? 5);
  if (!q.trim()) {
    return c.json({ indexMode: 'keyword', hits: [], total: allCases().length });
  }
  const { indexMode, hits } = searchCases(q, topK);
  return c.json({ indexMode, hits, total: allCases().length });
}));

router.get('/admin/cases', adminRoleMiddleware, safe((c) => {
  const sampleType = c.req.query('sampleType');
  const rows = allCases().filter((r) => (sampleType ? r.sample_type === sampleType : true));
  return c.json({ cases: rows.slice(0, Number(c.req.query('limit') ?? 200)) });
}));

/** 人工修正归因标签（AC-F6.3、TC-FLM-28）。 */
router.put('/admin/cases/:caseId/stage', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { stage?: string };
  const stage = body.stage as AttributionStage | undefined;
  if (!stage || !ATTRIBUTION_STAGES.includes(stage)) {
    return c.json({ error: `stage 必须是 ${ATTRIBUTION_STAGES.join(' / ')} 之一` }, 400);
  }
  const ok = updateCaseStage(c.req.param('caseId'), stage);
  if (!ok) return c.json({ error: '案例不存在' }, 404);
  return c.json({ ok: true, caseId: c.req.param('caseId'), stage });
}));

/** 短期纠偏（TC-FLM-16）。 */
router.post('/admin/evaluations/:evalId/correct', adminRoleMiddleware, safe(async (c) => {
  const evalId = c.req.param('evalId');
  const evaluation = getEvaluation(evalId);
  if (!evaluation) return c.json({ error: '评价不存在' }, 404);

  const plan = planCorrection(evaluation);
  const outcome = await executeCorrection(
    plan,
    // 真实重试需要重新驱动智能体，属超出本模块边界的动作 —— 这里如实返回未成功，
    // 由 plan 决定是否降级人工，而不是伪造一个成功。
    async () => false,
    { evaluationId: evalId, executor: 'admin-console', sleep: async () => {} },
  );

  return c.json({ ok: true, plan, outcome });
}));

/** 数据回流产物（TC-FLM-19）。 */
router.get('/admin/data-feedback', adminRoleMiddleware, safe((c) => {
  const evals = recentEvaluations(500);
  const goalByTask = new Map<string, { goal: string; summary: string | null }>();
  for (const e of evals) goalByTask.set(e.task_id, { goal: e.task_id, summary: e.outcome_reason });
  const artifact = buildDataFeedback(evals, goalByTask);
  return c.json(artifact);
}));

/** 知识条目候选（TC-FLM-20 前半）。 */
router.post('/admin/knowledge/candidates', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { taskIds?: string[] };
  const ids = body.taskIds ?? [];
  if (ids.length === 0) return c.json({ error: 'taskIds 必填' }, 400);

  const all = ids.flatMap((t) => buildKnowledgeCandidates(t));
  const written = persistKnowledgeCandidates(all);
  return c.json({ ok: true, candidates: all, written });
}));

router.get('/admin/knowledge', adminRoleMiddleware, safe((c) => {
  return c.json({ knowledge: listKnowledge(c.req.query('status') as never) });
}));

/** 审核知识条目（TC-FLM-20 后半）。 */
router.post('/admin/knowledge/:id/review', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: string };
  const decision = body.decision;
  if (decision !== 'accepted' && decision !== 'rejected') {
    return c.json({ error: 'decision 必须是 accepted / rejected' }, 400);
  }
  const user = c.get('user');
  const ok = reviewKnowledge(c.req.param('id'), decision, user?.username ?? 'admin', body.note ?? '');
  if (!ok) return c.json({ error: '条目不存在或已裁决' }, 404);
  return c.json({ ok: true, id: c.req.param('id'), decision });
}));

// ── F5 闭环 ──────────────────────────────────────────────────────────

router.get('/admin/strategies', adminRoleMiddleware, safe((c) => {
  return c.json({ strategies: listStrategies({ limit: 500 }) });
}));

/**
 * 版本对比（TC-FLM-29）。**必须**注册在 `/admin/strategies/:versionId` 之前：
 * 路由按注册顺序匹配，放在后面时 `compare` 会被 `:versionId` 当成版本号吃掉，
 * 接口恒返回 404「版本不存在」——纯函数单测全绿也照样漏。
 * `tests/units/flm-strategy-routes.test.ts` 用真实请求把这条顺序钉住。
 */
router.get('/admin/strategies/compare', adminRoleMiddleware, safe((c) => {
  const a = c.req.query('a') ?? '';
  const b = c.req.query('b') ?? '';
  const metricsA = JSON.parse(c.req.query('metricsA') ?? '{}');
  const metricsB = JSON.parse(c.req.query('metricsB') ?? '{}');
  return c.json({ comparison: compareVersions(a, b, metricsA, metricsB) });
}));

router.get('/admin/strategies/:versionId', adminRoleMiddleware, safe((c) => {
  const v = getStrategy(c.req.param('versionId'));
  if (!v) return c.json({ error: '版本不存在' }, 404);
  return c.json({ strategy: v });
}));

/** 提交门禁（TC-FLM-21/22 前置）。 */
router.post('/admin/strategies/:versionId/gate', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    baseline?: Record<string, number>;
    candidate?: Record<string, number>;
  };
  const user = c.get('user');
  const result = submitForGate(
    c.req.param('versionId'),
    (body.baseline ?? {}) as never,
    (body.candidate ?? {}) as never,
    user?.username ?? 'admin',
  );
  return c.json(result);
}));

/** 人工审核签字（AC-F5.5）。 */
router.post('/admin/strategies/:versionId/approve', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  const user = c.get('user');
  const result = approveHumanReview(
    c.req.param('versionId'),
    user?.username ?? 'admin',
    body.note ?? '',
  );
  return c.json(result, result.ok ? 200 : 400);
}));

/** 灰度放量（TC-FLM-22/23）。 */
router.post('/admin/strategies/:versionId/canary', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ratio?: number };
  const user = c.get('user');
  const result = setCanary(c.req.param('versionId'), Number(body.ratio ?? 0), user?.username ?? 'admin');
  return c.json(result, result.ok ? 200 : 400);
}));

/**
 * 回滚（AC-F5.4、TC-FLM-24）。
 *
 * 触发原因由调用方给出并原样落进审计与告警 —— 回滚是"为什么退"比"退了"更重要，
 * 省掉原因会让事后复盘只能看到一个光秃秃的 rolled_back 状态。
 * 未指定原因时给一句明确的兜底文案，不留空。
 */
router.post('/admin/strategies/:versionId/rollback', adminRoleMiddleware, safe(async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const user = c.get('user');
  const reason =
    typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim()
      : '人工触发回滚（未填写原因）';
  const result = autoRollback(c.req.param('versionId'), reason, user?.username ?? 'admin');
  return c.json(result, result.rolledBack ? 200 : 404);
}));

/** 灰度分流判定（供消息链路查询当前会话走哪个版本）。 */
router.get('/canary', safe((c) => {
  const type = (c.req.query('type') ?? 'prompt') as never;
  const key = c.req.query('key') ?? '';
  return c.json(isInCanary(type, key));
}));

router.get('/admin/actions', adminRoleMiddleware, safe((c) => {
  return c.json({ actions: listActions(Number(c.req.query('limit') ?? 100)) });
}));

/** 审计时间线（TC-FLM-25）。 */
router.get('/admin/audit', adminRoleMiddleware, safe((c) => {
  return c.json({ audit: listAudit({ versionId: c.req.query('versionId') ?? undefined, limit: 500 }) });
}));

// ── F6 控制台 ────────────────────────────────────────────────────────

/**
 * 总览（TC-FLM-26）。
 *
 * 每次拉取都顺手跑一次告警判定并落库 —— 控制台是运营唯一会打开的地方，把巡检挂在
 * 它上面，比再起一个定时任务简单，也不会出现"看板有人看才有数据、告警没人看就不触发"
 * 的割裂。副作用是同一状态会被重复告警，这是可接受的：告警列表本就按时间倒序，
 * 运营关心的是"现在有没有问题"。
 */
router.get('/admin/overview', adminRoleMiddleware, safe((c) => {
  const days = Number(c.req.query('days') ?? 7);
  const { current, baseline } = currentVsBaseline(days);
  const snapshot = consoleSnapshot(days);
  const check = evaluateAlerts(current, baseline);
  const raised = raiseAlerts(check);

  return c.json({
    enabled: snapshot.enabled,
    generatedAt: snapshot.generatedAt,
    metrics: current,
    baseline: baseline ? { successRate: baseline.successRate, satisfaction: baseline.satisfaction } : null,
    trend: snapshot.trend,
    attribution: attributionView({ limit: Number(c.req.query('drillLimit') ?? 50) }),
    alertCheck: { ...check, raised },
    alerts: listAlerts(100),
    recentFeedback: snapshot.recentFeedback,
    audit: snapshot.audit,
  });
}));

/** 归因视图与下钻（TC-FLM-27）。 */
router.get('/admin/attribution', adminRoleMiddleware, safe((c) => {
  return c.json(
    attributionView({
      stage: (c.req.query('stage') as AttributionStage) ?? undefined,
      chatJid: c.req.query('chatJid') ?? undefined,
      limit: Number(c.req.query('limit') ?? 100),
    }),
  );
}));

/** 告警列表与确认（TC-FLM-30）。 */
router.get('/admin/alerts', adminRoleMiddleware, safe((c) => {
  return c.json({ alerts: listAlerts(Number(c.req.query('limit') ?? 100)) });
}));

router.post('/admin/alerts/:id/ack', adminRoleMiddleware, safe((c) => {
  const ok = ackAlert(c.req.param('id'));
  if (!ok) return c.json({ error: '告警不存在' }, 404);
  return c.json({ ok: true });
}));

/** 单任务轨迹下钻（AC-F6.7）。 */
router.get('/admin/tasks/:taskId/timeline', adminRoleMiddleware, safe((c) => {
  const taskId = c.req.param('taskId');
  return c.json({
    taskId,
    scope: resolveTaskScope(taskId),
    timeline: taskTimeline(taskId),
    events: listEvents({ taskId, limit: 200 }),
  });
}));

/** 反馈原始记录（admin only —— 含未脱敏 raw_payload）。 */
router.get('/admin/feedback', adminRoleMiddleware, safe((c) => {
  return c.json({ feedback: listFeedback(Number(c.req.query('limit') ?? 100)) });
}));

export default router;
