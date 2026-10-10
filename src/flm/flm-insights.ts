/**
 * FLM 运营观测控制台聚合（PRD F6）。
 *
 * 本层只做**读聚合**，不写数据（唯一的写是告警落库，见 evaluateAlerts）。
 * 所有聚合都从既有表算，不维护物化视图 —— 当前数据量（千级事件）全表扫描是毫秒级，
 * 引入缓存/物化只会带来"数据不一致"这个更贵的问题。数据量级变了再谈优化。
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { readConfig, type FlmConfig } from './flm-config.js';
import {
  insertAlert,
  listActions,
  listAlerts,
  listAudit,
  listEvaluations,
  listEvents,
  listFeedback,
  type FlmActionRow,
  type FlmAuditRow,
  type FlmEvaluationRow,
  type FlmEventRow,
  type FlmFeedbackRow,
} from './flm-db.js';
import type { CoreMetrics } from './flm-closedloop.js';
import { ATTRIBUTION_LABELS, type AttributionStage, type FeedbackSource } from './flm-types.js';

const DAY_MS = 86_400_000;

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readRating(payload: Record<string, unknown>): number | null {
  const r = payload.rating;
  return typeof r === 'number' ? r : null;
}

// ── 五类核心指标（AC-F6.1）──────────────────────────────────────────

export interface OverviewMetrics extends CoreMetrics {
  feedbackVolume: number;
  /** 分来源的反馈量。 */
  bySource: Record<FeedbackSource, number>;
  /** 闭环时延中位数（ms）：从反馈事件到闭环动作。 */
  closedLoopLatencyMs: number;
  evaluationCount: number;
  taskCount: number;
}

/**
 * 计算五类核心指标（TC-FLM-26 要求"数值与实际数据一致"，故每项都给出计算口径）。
 *
 *   feedbackVolume —— flm_events 行数
 *   satisfaction   —— 用户侧正/负反馈占比 × 100（无用户反馈时记 0，不用默认值粉饰）
 *   successRate    —— outcome='achieved' 占比 × 100
 *   correctionRate —— 纠偏动作成功占比 × 100
 *   closedLoopLatency —— 事件时间 → 动作时间的间隔，取中位数
 *     取中位数而非均值：闭环时延长尾很重（有的事件几小时后才被处理），均值会被拉飞。
 */
export function computeOverviewMetrics(
  evaluations: FlmEvaluationRow[],
  events: FlmEventRow[],
  actions: FlmActionRow[],
): OverviewMetrics {
  const bySource: Record<FeedbackSource, number> = { user: 0, system: 0, env: 0 };
  let userPos = 0;
  let userNeg = 0;

  for (const e of events) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    if (e.source !== 'user') continue;
    if (e.type === 'explicit_like' || e.type === 'explicit_adopt') userPos++;
    else if (e.type === 'explicit_reject' || e.type === 'implicit_abandon') userNeg++;
    else if (e.type === 'explicit_rating') {
      const r = readRating(parsePayload(e.normalized_payload));
      if (r != null) {
        if (r >= 4) userPos++;
        else if (r <= 2) userNeg++;
      }
    }
  }

  const achieved = evaluations.filter((e) => e.outcome === 'achieved').length;
  const successRate = evaluations.length === 0 ? 0 : (achieved / evaluations.length) * 100;

  const userTotal = userPos + userNeg;
  const satisfaction = userTotal === 0 ? 0 : (userPos / userTotal) * 100;

  const retryActions = actions.filter((a) => a.action_type === 'retry');
  const retryOk = retryActions.filter((a) => a.result === 'success').length;
  const correctionRate = retryActions.length === 0 ? 0 : (retryOk / retryActions.length) * 100;

  // 闭环时延：把每个动作配到它之前最近的一条事件上。
  const sortedEvents = [...events].sort((a, b) => a.occurred_at - b.occurred_at);
  const latencies: number[] = [];
  for (const a of actions) {
    let prev: FlmEventRow | undefined;
    for (const e of sortedEvents) {
      if (e.occurred_at <= a.exec_time) prev = e;
      else break;
    }
    if (prev) latencies.push(a.exec_time - prev.occurred_at);
  }
  latencies.sort((x, y) => x - y);
  const median = latencies.length === 0 ? 0 : latencies[Math.floor(latencies.length / 2)];

  const avgLatency = evaluations.length === 0
    ? 0
    : evaluations.reduce((s, e) => s + (e.duration_ms || 0), 0) / evaluations.length;

  let qualitySum = 0;
  for (const e of evaluations) {
    const q = parsePayload(e.quality_scores ?? '{}');
    const vals = Object.values(q).filter((v): v is number => typeof v === 'number');
    qualitySum += vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  const qualityMean = evaluations.length === 0 ? 0 : qualitySum / evaluations.length;

  return {
    feedbackVolume: events.length,
    bySource,
    satisfaction: Number(satisfaction.toFixed(2)),
    successRate: Number(successRate.toFixed(2)),
    correctionRate: Number(correctionRate.toFixed(2)),
    qualityMean: Number(qualityMean.toFixed(2)),
    avgLatencyMs: Number(avgLatency.toFixed(2)),
    avgCostTokens: 0, // 由 computeCostFromNodes 补齐（需查轨迹表）
    closedLoopLatencyMs: median,
    evaluationCount: evaluations.length,
    taskCount: new Set(evaluations.map((e) => e.task_id)).size,
  };
}

/** 从轨迹表补算平均 token 成本（评价表本身不存 token）。 */
export function computeAvgCostTokens(fromMs: number, toMs: number): number {
  const row = getDb()
    .prepare(
      `SELECT AVG(t) AS avg_tokens FROM (
         SELECT SUM(tokens) AS t FROM chat_trace_nodes
         WHERE started_at >= ? AND started_at < ?
         GROUP BY chat_jid, substr(started_at, 1, 13)
       )`,
    )
    .get(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as {
    avg_tokens: number | null;
  };
  return Number((row?.avg_tokens ?? 0).toFixed(2));
}

// ── 趋势（AC-F6.1 的"趋势"）─────────────────────────────────────────

export interface TrendPoint {
  bucket: string;
  feedbackVolume: number;
  successRate: number;
  satisfaction: number;
  evaluationCount: number;
}

/** 按天分桶的趋势。桶键用 evalu_date/event_date，避免把 ISO 时间戳再解析一遍。 */
export function computeTrend(days = 7, nowMs = Date.now()): TrendPoint[] {
  const from = nowMs - days * DAY_MS;
  const events = listEvents({ limit: 10_000 }).filter((e) => e.occurred_at >= from);
  const evals = listEvaluations({ limit: 10_000 }).filter((e) => e.eval_time >= from);

  const buckets = new Map<string, TrendPoint>();
  const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  for (let i = days - 1; i >= 0; i--) {
    const k = keyOf(nowMs - i * DAY_MS);
    buckets.set(k, { bucket: k, feedbackVolume: 0, successRate: 0, satisfaction: 0, evaluationCount: 0 });
  }

  const posNeg = new Map<string, { pos: number; neg: number }>();
  for (const e of events) {
    const b = buckets.get(keyOf(e.occurred_at));
    if (!b) continue;
    b.feedbackVolume++;
    if (e.source === 'user') {
      const acc = posNeg.get(b.bucket) ?? { pos: 0, neg: 0 };
      if (e.type === 'explicit_like' || e.type === 'explicit_adopt') acc.pos++;
      else if (e.type === 'explicit_reject' || e.type === 'implicit_abandon') acc.neg++;
      else if (e.type === 'explicit_rating') {
        const r = readRating(parsePayload(e.normalized_payload));
        if (r != null) {
          if (r >= 4) acc.pos++;
          else if (r <= 2) acc.neg++;
        }
      }
      posNeg.set(b.bucket, acc);
    }
  }

  const achievedByBucket = new Map<string, number>();
  for (const e of evals) {
    const b = buckets.get(keyOf(e.eval_time));
    if (!b) continue;
    b.evaluationCount++;
    if (e.outcome === 'achieved') achievedByBucket.set(b.bucket, (achievedByBucket.get(b.bucket) ?? 0) + 1);
  }

  for (const b of buckets.values()) {
    b.successRate = b.evaluationCount === 0 ? 0 : Number(((achievedByBucket.get(b.bucket) ?? 0) / b.evaluationCount * 100).toFixed(2));
    const pn = posNeg.get(b.bucket);
    b.satisfaction = !pn || pn.pos + pn.neg === 0 ? 0 : Number((pn.pos / (pn.pos + pn.neg) * 100).toFixed(2));
  }

  return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

// ── 归因视图（AC-F6.2、TC-FLM-27）───────────────────────────────────

export interface AttributionBucket {
  stage: AttributionStage;
  label: string;
  count: number;
  ratio: number;
}

export interface AttributionView {
  buckets: AttributionBucket[];
  totalFailed: number;
  /** 下钻结果 —— 已按 stage 过滤的任务级记录。 */
  drillDown: Array<{
    evalId: string;
    taskId: string;
    chatJid: string | null;
    outcome: string;
    stage: AttributionStage | null;
    firstAnomalyStep: string | null;
    outcomeReason: string | null;
    evalTime: number;
  }>;
}

/**
 * 归因分布 + 下钻（AC-F6.2）。
 *
 * 分母是**未达成样本数**（failed + partial），不是全部样本 —— 归因只对失败有意义，
 * 把 achieved 算进分母会让所有环节的占比被稀释，看起来"哪儿都没问题"。
 */
export function attributionView(opts: {
  stage?: AttributionStage;
  chatJid?: string;
  limit?: number;
} = {}): AttributionView {
  const all = listEvaluations({ limit: 5000 });
  const failed = all.filter((e) => e.outcome !== 'achieved');

  const counts = new Map<AttributionStage, number>();
  for (const e of failed) {
    if (!e.attribution_stage) continue;
    counts.set(e.attribution_stage, (counts.get(e.attribution_stage) ?? 0) + 1);
  }

  const buckets: AttributionBucket[] = [...counts.entries()]
    .map(([stage, count]) => ({
      stage,
      label: ATTRIBUTION_LABELS[stage],
      count,
      ratio: failed.length === 0 ? 0 : Number((count / failed.length).toFixed(3)),
    }))
    .sort((a, b) => b.count - a.count);

  const drillDown = failed
    .filter((e) => (opts.stage ? e.attribution_stage === opts.stage : true))
    .filter((e) => (opts.chatJid ? e.chat_jid === opts.chatJid : true))
    .slice(0, opts.limit ?? 100)
    .map((e) => ({
      evalId: e.eval_id,
      taskId: e.task_id,
      chatJid: e.chat_jid,
      outcome: e.outcome,
      stage: e.attribution_stage,
      firstAnomalyStep: e.first_anomaly_step,
      outcomeReason: e.outcome_reason,
      evalTime: e.eval_time,
    }));

  return { buckets, totalFailed: failed.length, drillDown };
}

/** 工具维度下钻：高失败率工具排行（AC-F6.2 的"按工具"）。 */
export function toolFailureStats(
  fromMs: number,
  toMs: number,
  limit = 20,
): Array<{ toolName: string; total: number; failed: number; failureRate: number }> {
  const rows = getDb()
    .prepare(
      `SELECT tool_name,
              COUNT(*) AS total,
              SUM(CASE WHEN status IN ('error','failed','timeout') THEN 1 ELSE 0 END) AS failed
       FROM trace_tool_calls
       WHERE started_at >= ? AND started_at < ?
       GROUP BY tool_name
       ORDER BY failed DESC, total DESC
       LIMIT ?`,
    )
    .all(new Date(fromMs).toISOString(), new Date(toMs).toISOString(), limit) as Array<{
    tool_name: string;
    total: number;
    failed: number;
  }>;

  return rows.map((r) => ({
    toolName: r.tool_name,
    total: r.total,
    failed: r.failed ?? 0,
    failureRate: r.total === 0 ? 0 : Number(((r.failed ?? 0) / r.total * 100).toFixed(2)),
  }));
}

/** 智能体/会话维度下钻（AC-F6.2 的"按智能体"）。平台以 chat_jid 标识运行主体。 */
export function agentBreakdown(limit = 20): Array<{
  chatJid: string;
  evaluations: number;
  achieved: number;
  successRate: number;
  avgQuality: number;
}> {
  const all = listEvaluations({ limit: 5000 });
  const map = new Map<string, { n: number; ok: number; q: number }>();

  for (const e of all) {
    const k = e.chat_jid ?? '(未知)';
    const acc = map.get(k) ?? { n: 0, ok: 0, q: 0 };
    acc.n++;
    if (e.outcome === 'achieved') acc.ok++;
    const q = parsePayload(e.quality_scores ?? '{}');
    const vals = Object.values(q).filter((v): v is number => typeof v === 'number');
    acc.q += vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
    map.set(k, acc);
  }

  return [...map.entries()]
    .map(([chatJid, v]) => ({
      chatJid,
      evaluations: v.n,
      achieved: v.ok,
      successRate: Number((v.ok / v.n * 100).toFixed(2)),
      avgQuality: Number((v.q / v.n).toFixed(2)),
    }))
    .sort((a, b) => b.evaluations - a.evaluations)
    .slice(0, limit);
}

// ── 告警（AC-F6.5、TC-FLM-30）───────────────────────────────────────

export interface AlertCheckResult {
  triggered: Array<{ metric: string; level: string; message: string; threshold: string; actual: string }>;
  config: FlmConfig['alertThresholds'];
}

/**
 * 按配置阈值检查告警（AC-F6.5）。
 *
 * 三类阈值对应三种故障形态：
 *   - 成功率相对基线突降  → 模型/工具侧劣化
 *   - 错误率超绝对上限    → 系统级故障
 *   - 反馈量低于下限      → 采集链路断了（"没有消息"本身就是消息）
 */
export function evaluateAlerts(
  current: OverviewMetrics,
  baseline: OverviewMetrics | null,
  config: FlmConfig = readConfig(),
): AlertCheckResult {
  const t = config.alertThresholds;
  const triggered: AlertCheckResult['triggered'] = [];

  if (baseline) {
    const drop = baseline.successRate - current.successRate;
    if (drop > t.successRateDropPct) {
      triggered.push({
        metric: 'success_rate_drop',
        level: 'critical',
        message: `成功率较基线下降 ${drop.toFixed(2)} 个百分点`,
        threshold: `${t.successRateDropPct}pct`,
        actual: `${drop.toFixed(2)}pct`,
      });
    }
  }

  const errorRate = 100 - current.successRate;
  if (t.errorRateSpikePct > 0 && errorRate > t.errorRateSpikePct) {
    triggered.push({
      metric: 'error_rate_spike',
      level: errorRate > t.errorRateSpikePct * 2 ? 'critical' : 'warning',
      message: `错误率 ${errorRate.toFixed(2)}% 超过阈值`,
      threshold: `${t.errorRateSpikePct}%`,
      actual: `${errorRate.toFixed(2)}%`,
    });
  }

  if (t.feedbackVolumeMin > 0 && current.feedbackVolume < t.feedbackVolumeMin) {
    triggered.push({
      metric: 'feedback_volume_low',
      level: 'warning',
      message: `反馈量 ${current.feedbackVolume} 低于下限`,
      threshold: String(t.feedbackVolumeMin),
      actual: String(current.feedbackVolume),
    });
  }

  return { triggered, config: t };
}

/** 触发告警并落库。返回写入条数。 */
export function raiseAlerts(result: AlertCheckResult): number {
  for (const a of result.triggered) {
    insertAlert({
      id: `alert_${randomUUID()}`,
      metric: a.metric,
      threshold: a.threshold,
      actual: a.actual,
      level: a.level,
      message: a.message,
      acked: 0,
      created_at: Date.now(),
    });
  }
  return result.triggered.length;
}

// ── 单任务下钻（AC-F6.7）────────────────────────────────────────────

export interface TaskTimelineItem {
  at: number;
  kind: 'feedback' | 'evaluation' | 'action' | 'trace';
  title: string;
  detail: string;
}

/**
 * 单任务完整时间线（AC-F6.7「下钻到单条任务轨迹」）。
 * 把反馈、评价、动作、执行步骤合并成一条按时间排序的线 —— 这是运营定位问题时
 * 唯一真正需要的视图：**"先发生了什么、然后系统做了什么反应"**。
 */
export function taskTimeline(taskId: string): TaskTimelineItem[] {
  const items: TaskTimelineItem[] = [];

  const events = listEvents({ taskId, limit: 500 });
  for (const e of events) {
    items.push({
      at: e.occurred_at,
      kind: 'feedback',
      title: `反馈事件 · ${e.source}/${e.type}`,
      detail: `置信度 ${e.confidence}，权重 ${e.weight}`,
    });
  }

  const evals = listEvaluations({ limit: 5000 }).filter((e) => e.task_id === taskId);
  for (const e of evals) {
    items.push({
      at: e.eval_time,
      kind: 'evaluation',
      title: `三层评价 · ${e.outcome}`,
      detail: e.outcome_reason ?? '',
    });
  }

  const evalIds = new Set(evals.map((e) => e.eval_id));
  for (const a of listActions(500)) {
    if (a.eval_id && !evalIds.has(a.eval_id)) continue;
    if (!a.eval_id) continue;
    items.push({
      at: a.exec_time,
      kind: 'action',
      title: `闭环动作 · ${a.action_type}`,
      detail: a.detail ?? a.result,
    });
  }

  return items.sort((a, b) => a.at - b.at);
}

// ── 告警基线（AC-F6.5 的「指标突降」需要一个参照物）─────────────────

/**
 * 把观察窗口切成前后两半：后半段是「当前」，前半段是「基线」。
 *
 * 为什么不用固定历史值做基线：本模块刚上线时没有历史，固定基线要么为空、要么得
 * 人工填一个拍脑袋的数。前后半段对比是**自参照**的，第一天就能工作，且随着数据
 * 积累自动变得更稳。
 */
export function currentVsBaseline(
  days = 7,
  nowMs = Date.now(),
): { current: OverviewMetrics; baseline: OverviewMetrics | null } {
  const half = Math.max(1, Math.floor(days / 2));
  const from = nowMs - days * DAY_MS;
  const mid = nowMs - half * DAY_MS;

  const inRange = <T extends { occurred_at?: number; eval_time?: number }>(rows: T[], lo: number, hi: number, key: 'occurred_at' | 'eval_time') =>
    rows.filter((r) => {
      const t = r[key];
      return typeof t === 'number' && t >= lo && t < hi;
    });

  const events = listEvents({ limit: 10_000 });
  const evals = listEvaluations({ limit: 10_000 });
  const actions = listActions(2000);

  const current = computeOverviewMetrics(
    inRange(evals, mid, nowMs, 'eval_time'),
    inRange(events, mid, nowMs, 'occurred_at'),
    actions.filter((a) => a.exec_time >= mid && a.exec_time < nowMs),
  );

  const baselineRows = inRange(evals, from, mid, 'eval_time');
  const baseline =
    baselineRows.length === 0
      ? null
      : computeOverviewMetrics(
          baselineRows,
          inRange(events, from, mid, 'occurred_at'),
          actions.filter((a) => a.exec_time >= from && a.exec_time < mid),
        );

  return { current, baseline };
}

// ── 控制台总装 ───────────────────────────────────────────────────────

export interface ConsoleSnapshot {
  enabled: boolean;
  metrics: OverviewMetrics;
  trend: TrendPoint[];
  alerts: ReturnType<typeof listAlerts>;
  recentFeedback: FlmFeedbackRow[];
  audit: FlmAuditRow[];
  generatedAt: number;
}

/**
 * 控制台一次拉全（AC-F6.6「数据延迟 ≤ 5 分钟」）。
 *
 * 实时算、不缓存 —— 本地实测这个聚合在千级数据下是毫秒级，缓存反而会引入最长
 * 一个缓存周期的延迟，直接违反 5 分钟延迟要求。`generatedAt` 如实回传计算时刻，
 * 验收时用它和操作时刻比对来证明延迟。
 */
export function consoleSnapshot(days = 7): ConsoleSnapshot {
  const from = Date.now() - days * DAY_MS;
  const events = listEvents({ limit: 10_000 }).filter((e) => e.occurred_at >= from);
  const evals = listEvaluations({ limit: 10_000 });
  const actions = listActions(1000);

  const metrics = computeOverviewMetrics(evals, events, actions);
  metrics.avgCostTokens = computeAvgCostTokens(from, Date.now());

  return {
    enabled: readConfig().enabled,
    metrics,
    trend: computeTrend(days),
    alerts: listAlerts(100),
    recentFeedback: listFeedback(50),
    audit: listAudit({ limit: 100 }),
    generatedAt: Date.now(),
  };
}
