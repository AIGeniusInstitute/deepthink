// DeepThink FLM（反馈与学习自进化模块）— API client
//
// 权限分两层与后端一致：反馈入口登录即可，/admin/* 需要 admin 角色。
// 所有响应都可能是 `{ degraded: true }`（FLM 被运维关闭）—— 调用方必须先判 degraded
// 再取业务字段，否则关掉 FLM 后控制台会显示一堆 undefined 而不是"已降级"。
import { apiFetch } from './client';

const BASE = '/api/flm';

// ── 类型 ─────────────────────────────────────────────────────────────

export const REASON_TAGS = ['答非所问', '事实错误', '格式不符', '过于冗长', '未完成任务', '其他'] as const;
export type ReasonTag = (typeof REASON_TAGS)[number];

export const ATTRIBUTION_STAGES = [
  'intent', 'planning', 'tool_selection', 'param_gen', 'execution', 'summary',
] as const;
export type AttributionStage = (typeof ATTRIBUTION_STAGES)[number];

export const ATTRIBUTION_LABELS: Record<AttributionStage, string> = {
  intent: '意图理解',
  planning: '规划',
  tool_selection: '工具选择',
  param_gen: '参数生成',
  execution: '执行',
  summary: '总结',
};

export type FeedbackType =
  | 'explicit_like' | 'explicit_reject' | 'explicit_rating'
  | 'explicit_adopt' | 'explicit_correction'
  | 'implicit_reask' | 'implicit_rewrite' | 'implicit_abandon';

export interface OverviewMetrics {
  successRate: number;
  satisfaction: number;
  qualityMean: number;
  correctionRate: number;
  avgLatencyMs: number;
  avgCostTokens: number;
  feedbackVolume: number;
  bySource: Record<string, number>;
  closedLoopLatencyMs: number;
  evaluationCount: number;
  taskCount: number;
}

export interface TrendPoint {
  bucket: string;
  feedbackVolume: number;
  successRate: number;
  satisfaction: number;
  [k: string]: unknown;
}

export interface FlmEvaluation {
  eval_id: string;
  task_id: string;
  trace_id: string | null;
  session_id: string | null;
  chat_jid: string | null;
  outcome: 'achieved' | 'partial' | 'failed';
  outcome_reason: string | null;
  process_score: number | null;
  path_conformity: number | null;
  step_count: number | null;
  retry_count: number | null;
  /** 首个异常步骤的标识（后端存的是字符串节点标识，不是序号）。 */
  first_anomaly_step: string | null;
  duration_ms: number | null;
  qualityScores: Record<string, number>;
  attribution_stage: AttributionStage | null;
  evidence: Array<Record<string, unknown>>;
  evaluator: string;
  needs_review: number;
  review_status: string;
  review_note: string | null;
  eval_time: number;
}

export interface FlmCase {
  case_id: string;
  task_id: string;
  chat_jid: string | null;
  title: string;
  goal: string | null;
  outcome: string;
  attribution_stage: AttributionStage | null;
  sample_type: string;
  score: number | null;
  content_json: string;
  created_at: number;
}

export interface FlmStrategy {
  version_id: string;
  strategy_type: string;
  name: string;
  content: string;
  attribution_tag: string | null;
  trigger_source: string;
  status: string;
  gate_status: string;
  gray_ratio: number;
  eval_report: string | null;
  parent_version: string | null;
  requires_human_review: number;
  reviewed_by: string | null;
  publish_time: number | null;
  publisher: string | null;
  created_at: number;
}

export interface FlmAudit {
  id: string;
  version_id: string | null;
  action: string;
  detail: string;
  actor: string;
  created_at: number;
}

export interface FlmAlert {
  id: string;
  metric: string;
  threshold: string;
  actual: string;
  level: string;
  message: string;
  acked: number;
  created_at: number;
}

export interface FlmKnowledge {
  id: string;
  title: string;
  content: string;
  status: 'pending' | 'accepted' | 'rejected';
  reviewer: string | null;
  review_note: string | null;
  reviewed_at: number | null;
  created_at: number;
}

export interface FlmEvent {
  event_id: string;
  source: string;
  type: string;
  task_id: string;
  trace_id: string | null;
  chat_jid: string | null;
  confidence: number;
  weight: number;
  alignment: string;
  conflict: number;
  occurred_at: number;
}

export interface AttributionView {
  buckets: Array<{ stage: AttributionStage; label: string; count: number; ratio: number }>;
  totalFailed: number;
  drillDown: Array<{
    evalId: string; taskId: string; chatJid: string | null; outcome: string;
    stage: AttributionStage | null; firstAnomalyStep: number | null;
    outcomeReason: string | null; evalTime: number;
  }>;
}

export interface TimelineItem {
  at: number;
  kind: 'feedback' | 'evaluation' | 'action' | 'trace';
  title: string;
  detail: string;
}

export interface GateDegradation {
  key: string;
  label: string;
  baseline: number;
  candidate: number;
  delta: number;
  degradation: number;
  unit: 'pct' | 'relative';
  breached: boolean;
}

/** FLM 关闭时后端返回的降级响应（AC-F0.1）。 */
export interface Degraded {
  degraded: true;
  enabled: false;
  message: string;
}

export function isDegraded(v: unknown): v is Degraded {
  return !!v && typeof v === 'object' && (v as Degraded).degraded === true;
}

// ── 反馈入口（登录即可）─────────────────────────────────────────────

export const getHealth = () =>
  apiFetch<{ enabled: boolean; reasonTags: string[]; attributionStages: string[]; serverTime: number }>(`${BASE}/health`);

export const submitFeedback = (body: {
  messageId: string;
  chatJid: string;
  type: FeedbackType;
  rating?: number | null;
  reasonTags?: string[] | null;
  correctionText?: string | null;
  sessionId?: string | null;
  skipped?: boolean;
}) => apiFetch<{ ok: boolean; feedbackId: string; taskId: string; alignment: string } | Degraded>(
  `${BASE}/feedback`,
  { method: 'POST', body: JSON.stringify(body) },
);

export const getMyFeedback = (messageId: string, chatJid: string) =>
  apiFetch<{ feedback: null | { type: string; rating: number | null; reasonTags: string[]; correctionText: string | null; updatedAt: number } }>(
    `${BASE}/feedback/mine?messageId=${encodeURIComponent(messageId)}&chatJid=${encodeURIComponent(chatJid)}`,
  );

// ── 控制台（admin）──────────────────────────────────────────────────

export const getOverview = (days = 7) =>
  apiFetch<Degraded | {
    enabled: boolean;
    generatedAt: number;
    metrics: OverviewMetrics;
    baseline: { successRate: number; satisfaction: number } | null;
    trend: TrendPoint[];
    attribution: AttributionView;
    alertCheck: { triggered: Array<{ metric: string; message: string }>; raised: number };
    alerts: FlmAlert[];
    recentFeedback: unknown[];
    audit: FlmAudit[];
  }>(`${BASE}/admin/overview?days=${days}`);

export const getConfig = () => apiFetch<{ config: Record<string, unknown> }>(`${BASE}/config`);
export const updateConfig = (patch: Record<string, unknown>) =>
  apiFetch<{ config: Record<string, unknown> }>(`${BASE}/config`, { method: 'PUT', body: JSON.stringify(patch) });

export const listEvaluations = (params: { outcome?: string; stage?: string; needsReview?: boolean; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (params.outcome) q.set('outcome', params.outcome);
  if (params.stage) q.set('stage', params.stage);
  if (params.needsReview) q.set('needsReview', '1');
  q.set('limit', String(params.limit ?? 100));
  return apiFetch<{ evaluations: FlmEvaluation[] }>(`${BASE}/admin/evaluations?${q}`);
};

export const evaluateTasks = (taskIds: string[], useLlm = false) =>
  apiFetch<{ ok: boolean; evaluated: number; results: Array<Record<string, unknown>> } | Degraded>(
    `${BASE}/admin/evaluate`,
    { method: 'POST', body: JSON.stringify({ taskIds, useLlm }) },
  );

export const reviewEvaluation = (evalId: string, note: string) =>
  apiFetch<{ ok: boolean }>(`${BASE}/admin/evaluations/${encodeURIComponent(evalId)}/review`, {
    method: 'POST', body: JSON.stringify({ note }),
  });

/**
 * 近期任务列表（TC-FLM-13）。
 *
 * 「批量评价」必须从这里拿 taskId —— 空数组提交后端必然 400，按钮就成了摆设。
 * `evaluated` 用于在界面上区分已评/未评，避免重复触发消耗模型额度。
 */
export const listRecentTasks = (limit = 50) =>
  apiFetch<{ tasks: RecentTask[] }>(`${BASE}/admin/tasks/recent?limit=${limit}`);

/** 工具维度下钻（AC-F6.2）。 */
export const getToolInsights = (days = 7, limit = 20) =>
  apiFetch<{ tools: Array<{ toolName: string; total: number; failed: number; failureRate: number }> }>(
    `${BASE}/admin/insights/tools?days=${days}&limit=${limit}`,
  );

/** 智能体/会话维度下钻（AC-F6.2）。 */
export const getAgentInsights = (limit = 20) =>
  apiFetch<{ agents: Array<{ chatJid: string; evaluations: number; achieved: number; successRate: number; avgQuality: number }> }>(
    `${BASE}/admin/insights/agents?limit=${limit}`,
  );

export const collectSystem = (taskId: string) =>
  apiFetch<Degraded | { ok: boolean; derived: number; inserted: number }>(
    `${BASE}/admin/collect/system`, { method: 'POST', body: JSON.stringify({ taskId }) },
  );

export const searchCases = (q: string, topK = 5) =>
  apiFetch<{ indexMode: string; hits: Array<FlmCase & { score: number }>; total: number }>(
    `${BASE}/admin/cases/search?q=${encodeURIComponent(q)}&topK=${topK}`,
  );

export const listCases = (limit = 200) =>
  apiFetch<{ cases: FlmCase[] }>(`${BASE}/admin/cases?limit=${limit}`);

export const updateCaseStage = (caseId: string, stage: AttributionStage) =>
  apiFetch<{ ok: boolean; caseId: string; stage: string }>(`${BASE}/admin/cases/${encodeURIComponent(caseId)}/stage`, {
    method: 'PUT', body: JSON.stringify({ stage }),
  });

export const learn = (limit = 200) =>
  apiFetch<Degraded | { ok: boolean; cases: number; strategies: string[]; suggestions: number }>(`${BASE}/admin/learn`, {
    method: 'POST', body: JSON.stringify({ limit }),
  });

export const correctEvaluation = (evalId: string) =>
  apiFetch<{ ok: boolean; plan: Record<string, unknown>; outcome: Record<string, unknown> }>(
    `${BASE}/admin/evaluations/${encodeURIComponent(evalId)}/correct`, { method: 'POST' },
  );

export interface PreferencePair {
  pairId: string;
  goal: string;
  chosen: { taskId: string | null; summary: string; outcome: string };
  rejected: { taskId: string | null; summary: string; outcome: string };
  similarity: number;
  generatedAt: number;
}

export interface SftSample {
  goal: string;
  completion: string;
  outcome: string;
  taskId: string | null;
  generatedAt: number;
}

/** 近期有事件的任务（TC-FLM-13 批量评价的任务来源）。 */
export interface RecentTask {
  taskId: string;
  goal: string;
  evaluated: boolean;
}

/** 数据回流产物（AC-F4.6）。字段与后端 `DataFeedbackArtifact` 一致，另带 jsonl。 */
export interface DataFeedbackArtifact {
  preferencePairs: PreferencePair[];
  sftSamples: SftSample[];
  generatedAt: number;
  stats: { pairs: number; sft: number; positiveTasks: number; negativeTasks: number };
  jsonl: { pairs: string; sft: string };
}

export const getDataFeedback = () =>
  apiFetch<DataFeedbackArtifact>(`${BASE}/admin/data-feedback`);

export const listKnowledge = (status?: string) =>
  apiFetch<{ knowledge: FlmKnowledge[] }>(`${BASE}/admin/knowledge${status ? `?status=${status}` : ''}`);

export const genKnowledgeCandidates = (taskIds: string[]) =>
  apiFetch<{ ok: boolean; written: number }>(`${BASE}/admin/knowledge/candidates`, {
    method: 'POST', body: JSON.stringify({ taskIds }),
  });

export const reviewKnowledge = (id: string, decision: 'accepted' | 'rejected', note = '') =>
  apiFetch<{ ok: boolean }>(`${BASE}/admin/knowledge/${encodeURIComponent(id)}/review`, {
    method: 'POST', body: JSON.stringify({ decision, note }),
  });

export const listStrategies = () =>
  apiFetch<{ strategies: FlmStrategy[] }>(`${BASE}/admin/strategies`);

/** 核心指标（与后端 `CoreMetrics` 对齐，AC-F6.4 版本对比用）。 */
export interface CoreMetrics {
  successRate: number;
  satisfaction: number;
  qualityMean: number;
  correctionRate: number;
  avgLatencyMs: number;
  avgCostTokens: number;
}

export interface VersionComparison {
  a: string;
  b: string;
  metrics: Array<{ name: string; a: number; b: number; delta: number; verdict: 'improved' | 'regressed' | 'neutral' }>;
  recommendation: string;
  shouldRelease: boolean;
}

export const compareStrategies = (a: string, b: string, metricsA: CoreMetrics, metricsB: CoreMetrics) => {
  const q = new URLSearchParams({
    a, b,
    metricsA: JSON.stringify(metricsA),
    metricsB: JSON.stringify(metricsB),
  });
  return apiFetch<{ comparison: VersionComparison }>(`${BASE}/admin/strategies/compare?${q}`);
};

/**
 * 从版本的 `eval_report` 里还原该版本自己的指标。
 *
 * 门禁报告里每个指标都带 `baseline` / `candidate` 两侧数值，而 candidate 就是
 * **这个版本被打分时的数值** —— 所以版本对比能直接用真实存下来的数据，
 * 不需要前端编一套假指标。没有跑过门禁的版本返回 null，由调用方显式提示"无数据"，
 * 而不是用 0 或示例值糊过去。
 */
export function metricsFromStrategy(s: FlmStrategy): { baseline: CoreMetrics; candidate: CoreMetrics } | null {
  if (!s.eval_report) return null;
  try {
    const report = JSON.parse(s.eval_report) as {
      degradations?: Array<{ key: string; baseline: number; candidate: number }>;
    };
    if (!report.degradations?.length) return null;
    const baseline = {} as CoreMetrics;
    const candidate = {} as CoreMetrics;
    for (const d of report.degradations) baseline[d.key as keyof CoreMetrics] = d.baseline;
    for (const d of report.degradations) candidate[d.key as keyof CoreMetrics] = d.candidate;
    return { baseline, candidate };
  } catch {
    return null;
  }
}

export const submitGate = (versionId: string, baseline: Record<string, number>, candidate: Record<string, number>) =>
  apiFetch<{ ok: boolean; report: { gateStatus: string; summary: string; degradations: GateDegradation[]; blockedBy: string[] } | null; blockedReason?: string }>(
    `${BASE}/admin/strategies/${encodeURIComponent(versionId)}/gate`,
    { method: 'POST', body: JSON.stringify({ baseline, candidate }) },
  );

export const approveStrategy = (versionId: string, note: string) =>
  apiFetch<{ ok: boolean; error?: string }>(`${BASE}/admin/strategies/${encodeURIComponent(versionId)}/approve`, {
    method: 'POST', body: JSON.stringify({ note }),
  });

export const setCanary = (versionId: string, ratio: number) =>
  apiFetch<{ ok: boolean; error?: string }>(`${BASE}/admin/strategies/${encodeURIComponent(versionId)}/canary`, {
    method: 'POST', body: JSON.stringify({ ratio }),
  });

export const rollbackStrategy = (versionId: string, reason: string) =>
  apiFetch<{ rolledBack: boolean; fromVersion: string | null; toVersion: string | null; elapsedMs: number; reason: string }>(
    `${BASE}/admin/strategies/${encodeURIComponent(versionId)}/rollback`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );

export const listAudit = (versionId?: string) =>
  apiFetch<{ audit: FlmAudit[] }>(`${BASE}/admin/audit${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`);

export const listActions = (limit = 100) =>
  apiFetch<{ actions: Array<Record<string, unknown>> }>(`${BASE}/admin/actions?limit=${limit}`);

export const getAttribution = (params: { stage?: string; chatJid?: string; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (params.stage) q.set('stage', params.stage);
  if (params.chatJid) q.set('chatJid', params.chatJid);
  q.set('limit', String(params.limit ?? 100));
  return apiFetch<AttributionView>(`${BASE}/admin/attribution?${q}`);
};

export const listAlerts = (limit = 100) =>
  apiFetch<{ alerts: FlmAlert[] }>(`${BASE}/admin/alerts?limit=${limit}`);

export const ackAlert = (id: string) =>
  apiFetch<{ ok: boolean }>(`${BASE}/admin/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST' });

export const getTaskTimeline = (taskId: string) =>
  apiFetch<{
    taskId: string;
    scope: { startMs: number; endMs: number; chatJid: string; traceId: string | null } | null;
    timeline: TimelineItem[];
    events: FlmEvent[];
  }>(`${BASE}/admin/tasks/${encodeURIComponent(taskId)}/timeline`);

export const listFeedback = (limit = 100) =>
  apiFetch<{ feedback: Array<Record<string, unknown>> }>(`${BASE}/admin/feedback?limit=${limit}`);

/**
 * 归一化后的事件流（TC-FLM-04/05）。
 *
 * 来源、权重、置信度、冲突标记、成品对齐只在事件层存在 —— 原始反馈表里没有这些字段。
 * 控制台要能回答"这条反馈被归一化成什么、置信度多少、是否与成品对齐"，
 * 就必须走这个出口。
 */
export const listEvents = (params: { source?: string; taskId?: string; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (params.source) q.set('source', params.source);
  if (params.taskId) q.set('taskId', params.taskId);
  q.set('limit', String(params.limit ?? 100));
  return apiFetch<{ events: FlmEvent[] }>(`${BASE}/admin/events?${q}`);
};

// ── 环境观测点与快照（PRD F1.3）─────────────────────────────────────

export interface FlmObservation {
  id: string;
  name: string;
  path: string;
  expected: string | null;
  enabled: number;
  created_by: string | null;
  created_at: number;
}

/** 脱敏规则（PRD F2.6）。存于 flm_config，改动即时生效、无需重启。 */
export interface DesensitizeRule {
  name: string;
  pattern: string;
  flags: string;
  mask: string;
}

export const listObservations = () =>
  apiFetch<{ observations: FlmObservation[] }>(`${BASE}/admin/observations`);

export const createObservation = (body: { name: string; path: string; expected?: string | null }) =>
  apiFetch<{ ok: boolean; id: string }>(`${BASE}/admin/observations`, {
    method: 'POST', body: JSON.stringify(body),
  });

export const deleteObservation = (id: string) =>
  apiFetch<{ ok: boolean }>(`${BASE}/admin/observations/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** 提交一次环境快照；`values` 以观测点 path 为键。 */
export const submitSnapshot = (body: {
  taskId: string; phase: 'before' | 'after'; values: Record<string, unknown>; ttlSeconds?: number;
}) => apiFetch<Degraded | { ok: boolean; snapshotId: string; values: Record<string, string | null> }>(
  `${BASE}/admin/snapshots`, { method: 'POST', body: JSON.stringify(body) },
);

export const diffTaskSnapshots = (taskId: string) =>
  apiFetch<Degraded | {
    ok: boolean; verdict: 'met' | 'unmet' | 'unknown'; inserted: boolean; eventId: string;
    changed: Array<{ name: string; before: string | null; after: string | null }>;
    unmet: string[]; met: string[];
  }>(`${BASE}/admin/snapshots/${encodeURIComponent(taskId)}/diff`, { method: 'POST' });
