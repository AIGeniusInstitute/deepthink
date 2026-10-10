/**
 * FLM 三层评价分析引擎（PRD F3）。
 *
 * 设计原则：**纯函数、无 IO、无 LLM 依赖**。
 * 这是刻意的取舍 —— PRD 要求「单任务三层评价 ≤ 10 秒」且「LLM-as-Judge 与规则判定
 * 双轨」。把规则轨做成纯计算，10 秒上限由结构保证（不需要压测去赌），验收也不依赖
 * 外部模型网络。LLM 轨是**可选叠加**（见 evaluateTask 的 useLlm），不是必需品。
 *
 * 本文件不查库：trace 节点、工具调用、反馈事件由调用方（flm-collect.ts）查好后传入。
 */

import { randomUUID } from 'node:crypto';
import {
  ATTRIBUTION_LABELS,
  type AttributionStage,
  type EvaluationResult,
  type Evidence,
  type FeedbackSource,
  type FeedbackType,
  type Outcome,
  type QualityScores,
  QUALITY_DIMENSIONS,
} from './flm-types.js';

// ── 输入上下文 ───────────────────────────────────────────────────────

export interface EvalEventInput {
  eventId: string;
  source: FeedbackSource;
  type: FeedbackType;
  confidence: number;
  weight: number;
  payload: Record<string, unknown>;
  occurredAt: number;
}

export interface EvalNodeInput {
  nodeType: string;
  title: string | null;
  status: string | null;
  toolName?: string | null;
  startedAt: number;
  endedAt: number | null;
  tokens: number;
  /** 已脱敏的输出摘要，供归因时读错误线索。 */
  outputSummary?: string | null;
}

export interface EvalToolCallInput {
  toolName: string;
  status: string | null;
  startedAt: number;
  endedAt: number | null;
  output?: string | null;
}

export interface EvalContext {
  taskId: string;
  traceId: string | null;
  sessionId: string | null;
  chatJid: string | null;
  events: EvalEventInput[];
  nodes: EvalNodeInput[];
  toolCalls: EvalToolCallInput[];
}

// ── 状态归一 ─────────────────────────────────────────────────────────

/** 成功状态。取值来自实盘数据（见 docs/task_state）：nodes 用 done，tool_calls 用 success。 */
const OK_STATUS = new Set(['done', 'success', 'ok', 'completed', 'succeeded']);
/** 失败状态。 */
const FAIL_STATUS = new Set(['failed', 'error', 'timeout', 'aborted']);

function isOk(status: string | null | undefined): boolean {
  return status != null && OK_STATUS.has(status);
}
function isFail(status: string | null | undefined): boolean {
  return status != null && FAIL_STATUS.has(status);
}

// ── 信号抽取 ─────────────────────────────────────────────────────────

interface Signals {
  userNegative: EvalEventInput[];
  userPositive: EvalEventInput[];
  systemFailures: EvalEventInput[];
  envUnmet: EvalEventInput[];
  envMet: EvalEventInput[];
  tags: string[];
  rating: number | null;
}

function readTags(payload: Record<string, unknown>): string[] {
  const t = payload.reason_tags ?? payload.reasonTags;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function readVerdict(payload: Record<string, unknown>): string | null {
  const v = payload.verdict ?? payload.result;
  return typeof v === 'string' ? v : null;
}

function extractSignals(events: EvalEventInput[]): Signals {
  const s: Signals = {
    userNegative: [],
    userPositive: [],
    systemFailures: [],
    envUnmet: [],
    envMet: [],
    tags: [],
    rating: null,
  };
  for (const e of events) {
    if (e.source === 'user') {
      if (e.type === 'explicit_reject' || e.type === 'implicit_abandon') s.userNegative.push(e);
      else if (e.type === 'explicit_like' || e.type === 'explicit_adopt') s.userPositive.push(e);
      else if (e.type === 'explicit_rating') {
        const r = e.payload.rating;
        if (typeof r === 'number') {
          s.rating = r;
          if (r <= 2) s.userNegative.push(e);
          else if (r >= 4) s.userPositive.push(e);
        }
      }
      s.tags.push(...readTags(e.payload));
    } else if (e.source === 'system') {
      if (e.type === 'system_error' || e.type === 'system_timeout') s.systemFailures.push(e);
    } else if (e.source === 'env') {
      const verdict = readVerdict(e.payload);
      if (verdict === 'unmet' || verdict === '未达成') s.envUnmet.push(e);
      else if (verdict === 'met' || verdict === '达成') s.envMet.push(e);
    }
  }
  return s;
}

// ── 结果层 ───────────────────────────────────────────────────────────

interface OutcomeJudgement {
  outcome: Outcome;
  reason: string;
  evidence: Evidence[];
}

/**
 * 结果层：判定任务目标是否最终达成（PRD F3.1）。
 *
 * 判据优先级（顺序即权重，命中即返回）：
 *   1. 环境 diff 判定未达成 —— 客观证据表明行动没产生效果，最强负信号
 *   2. 用户显式否决 —— 用户最懂自己的目标
 *   3. 用户采纳/点赞且系统未全败 —— 用户确认 + 过程无致命失败
 *   4. 全链路失败 —— 客观过程证据
 *   5. 失败率过半 —— 有失败但不足以判死，且用户没否决 → 部分达成
 *   6. 无负信号且有正信号或全成功 → 达成
 *   7. 其余 → 部分达成
 */
function judgeOutcome(ctx: EvalContext, s: Signals): OutcomeJudgement {
  const evidence: Evidence[] = [];
  const failNodes = ctx.nodes.filter((n) => isFail(n.status));
  const okNodes = ctx.nodes.filter((n) => isOk(n.status));
  const total = failNodes.length + okNodes.length;
  const failureRate = total === 0 ? 0 : failNodes.length / total;

  if (s.envUnmet.length > 0) {
    const e = s.envUnmet[0];
    evidence.push({
      kind: 'env',
      ref: e.eventId,
      excerpt: `环境快照 diff 判定未达成：${JSON.stringify(e.payload).slice(0, 160)}`,
    });
    return { outcome: 'failed', reason: '环境数据判定行动未产生预期效果', evidence };
  }

  if (s.userNegative.length > 0) {
    const e = s.userNegative[0];
    const tags = readTags(e.payload);
    evidence.push({
      kind: 'feedback',
      ref: e.eventId,
      excerpt: `用户负向反馈（${e.type}）${tags.length ? '：' + tags.join('/') : ''}`,
    });
    return { outcome: 'failed', reason: '用户显式否决该结果', evidence };
  }

  if (failureRate === 1 && total > 0) {
    evidence.push({
      kind: 'trace',
      ref: ctx.traceId ?? ctx.taskId,
      excerpt: `全链路失败：${failNodes.length} 个步骤全部失败`,
    });
    return { outcome: 'failed', reason: '执行链路全部失败', evidence };
  }

  if (s.userPositive.length > 0) {
    const e = s.userPositive[0];
    evidence.push({
      kind: 'feedback',
      ref: e.eventId,
      excerpt: `用户正向反馈（${e.type}）${s.rating != null ? `，评分 ${s.rating}` : ''}`,
    });
    return { outcome: 'achieved', reason: '用户确认达成', evidence };
  }

  if (failureRate > 0) {
    evidence.push({
      kind: 'trace',
      ref: ctx.traceId ?? ctx.taskId,
      excerpt: `${failNodes.length}/${total} 个步骤失败，未获用户确认`,
    });
    return { outcome: 'partial', reason: `执行部分失败（失败率 ${(failureRate * 100).toFixed(0)}%）`, evidence };
  }

  if (okNodes.length > 0) {
    evidence.push({
      kind: 'trace',
      ref: ctx.traceId ?? ctx.taskId,
      excerpt: `${okNodes.length} 个步骤全部成功，无负向反馈`,
    });
    return { outcome: 'achieved', reason: '全链路成功且无负向反馈', evidence };
  }

  evidence.push({
    kind: 'trace',
    ref: ctx.taskId,
    excerpt: '无可用执行轨迹，按反馈信号判定',
  });
  return { outcome: 'partial', reason: '缺少执行轨迹证据，无法确认达成', evidence };
}

// ── 过程层 ───────────────────────────────────────────────────────────

interface ProcessResult {
  score: number;
  pathConformity: number;
  stepCount: number;
  retryCount: number;
  firstAnomalyStep: string | null;
  durationMs: number;
}

/**
 * 过程层：是否按预期推进、何处异常（PRD F3.2）。
 *
 * 重试次数用「同名步骤重复出现」统计 —— 平台没有显式 retry 计数列，但同一个
 * 工具/节点被重复调用就是这个语义。
 */
function analyzeProcess(ctx: EvalContext): ProcessResult {
  const nodes = [...ctx.nodes].sort((a, b) => a.startedAt - b.startedAt);
  const stepCount = nodes.length;

  const okCount = nodes.filter((n) => isOk(n.status)).length;
  const judged = nodes.filter((n) => isOk(n.status) || isFail(n.status)).length;
  const pathConformity = judged === 0 ? 0 : okCount / judged;

  const seen = new Map<string, number>();
  for (const n of nodes) {
    const key = `${n.nodeType}:${n.title ?? n.toolName ?? ''}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let retryCount = 0;
  for (const c of seen.values()) if (c > 1) retryCount += c - 1;

  const firstFail = nodes.find((n) => isFail(n.status));
  const firstAnomalyStep = firstFail ? firstFail.title ?? firstFail.toolName ?? firstFail.nodeType : null;

  let durationMs = 0;
  for (const n of nodes) {
    if (n.endedAt != null && n.endedAt > n.startedAt) durationMs += n.endedAt - n.startedAt;
  }

  // 过程分：路径符合度为主（70%），重试率与异常点各扣分（30%）。
  const retryPenalty = stepCount === 0 ? 0 : Math.min(1, retryCount / stepCount);
  const anomalyPenalty = firstFail ? 1 : 0;
  const score = Math.max(
    0,
    Math.round(100 * (0.7 * pathConformity + 0.2 * (1 - retryPenalty) + 0.1 * (1 - anomalyPenalty))),
  );

  return { score, pathConformity, stepCount, retryCount, firstAnomalyStep, durationMs };
}

// ── 质量层 ───────────────────────────────────────────────────────────

/**
 * 质量层：六维评分（PRD F3.3）。
 * 每个维度 0–100，默认均分权重（PRD 11.1 明确「权重默认均分，需按业务优先级调整」
 * —— 所以这里不发明权重，如实均分）。
 */
function scoreQuality(ctx: EvalContext, s: Signals, p: ProcessResult): QualityScores {
  const hasTag = (t: string) => s.tags.includes(t);

  const factuality = hasTag('事实错误') ? 30 : s.systemFailures.length > 0 ? 60 : 100;
  const format = hasTag('格式不符') ? 30 : 100;
  const safety = hasTag('其他') && s.tags.some((t) => /安全|合规|敏感/.test(t)) ? 40 : 100;

  const latency = p.durationMs <= 30_000 ? 100 : p.durationMs <= 120_000 ? 70 : p.durationMs <= 300_000 ? 40 : 20;

  const tokens = ctx.nodes.reduce((a, n) => a + (n.tokens || 0), 0);
  const cost = tokens <= 20_000 ? 100 : tokens <= 100_000 ? 70 : tokens <= 500_000 ? 40 : 20;

  // 偏好匹配：正负反馈比例；无反馈时给中性 70（不奖励也不惩罚沉默）。
  const pos = s.userPositive.length;
  const neg = s.userNegative.length;
  const preference = pos + neg === 0 ? 70 : Math.round((100 * pos) / (pos + neg));

  return { factuality, format, latency, cost, safety, preference };
}

// ── 归因 ─────────────────────────────────────────────────────────────

/**
 * 失败归因（PRD F3.4）：定位到六个环节之一。
 *
 * 判据顺序即优先级 —— 从「最上游」到「最下游」：意图理解错了，下游做得再好也白搭，
 * 所以 intent 的判据排在最前；反之若全链路成功却仍失败，问题只能在输出环节（summary）。
 */
function attribute(ctx: EvalContext, s: Signals, p: ProcessResult): { stage: AttributionStage; evidence: Evidence[] } | null {
  const evidence: Evidence[] = [];
  const failTools = ctx.toolCalls.filter((t) => isFail(t.status));

  // 1. 意图理解：用户明确说"答非所问"，或第一轮 turn 节点就失败。
  if (s.tags.includes('答非所问')) {
    const e = s.userNegative[0];
    evidence.push({
      kind: 'feedback',
      ref: e?.eventId ?? ctx.taskId,
      excerpt: '用户反馈标签：答非所问 —— 理解的目标与用户意图不符',
    });
    return { stage: 'intent', evidence };
  }
  const sorted = [...ctx.nodes].sort((a, b) => a.startedAt - b.startedAt);
  const firstNode = sorted[0];
  if (firstNode && firstNode.nodeType === 'turn' && isFail(firstNode.status)) {
    evidence.push({
      kind: 'trace',
      ref: ctx.traceId ?? ctx.taskId,
      excerpt: `首个 turn 节点即失败：${firstNode.title ?? '(无标题)'}`,
    });
    return { stage: 'intent', evidence };
  }

  // 2. 规划：步骤数异常膨胀但工具本身没报错 —— 反复绕路说明计划有问题。
  if (p.stepCount > 40 && failTools.length === 0) {
    evidence.push({
      kind: 'trace',
      ref: ctx.traceId ?? ctx.taskId,
      excerpt: `执行了 ${p.stepCount} 个步骤且无工具报错 —— 规划路径异常冗长`,
    });
    return { stage: 'planning', evidence };
  }

  // 3/4/5. 有工具失败：按错误线索区分「选错工具 / 参数错 / 执行环境错」。
  if (failTools.length > 0) {
    const t = failTools[0];
    const out = (t.output ?? '').toLowerCase();
    if (/timeout|timed out|超时|rate.?limit|限流|429|econn|network|连接/.test(out)) {
      evidence.push({ kind: 'log', ref: t.toolName, excerpt: `工具 ${t.toolName} 执行环境异常：${(t.output ?? '').slice(0, 140)}` });
      return { stage: 'execution', evidence };
    }
    if (/invalid|argument|参数|required|missing|必需|格式|schema/.test(out)) {
      evidence.push({ kind: 'log', ref: t.toolName, excerpt: `工具 ${t.toolName} 入参不合法：${(t.output ?? '').slice(0, 140)}` });
      return { stage: 'param_gen', evidence };
    }
    evidence.push({ kind: 'log', ref: t.toolName, excerpt: `工具 ${t.toolName} 调用失败：${(t.output ?? '').slice(0, 140)}` });
    return { stage: 'tool_selection', evidence };
  }

  // 6. 总结：过程全绿但结果层仍判失败 —— 问题出在输出环节。
  const failNodes = ctx.nodes.filter((n) => isFail(n.status));
  if (failNodes.length === 0 && ctx.nodes.length > 0) {
    evidence.push({
      kind: 'trace',
      ref: ctx.traceId ?? ctx.taskId,
      excerpt: '执行链路全部成功，但结果未达成 —— 问题在结果输出环节',
    });
    return { stage: 'summary', evidence };
  }

  return null;
}

// ── 主入口 ───────────────────────────────────────────────────────────

/** 三层评价的完整输出 —— 就是 flm_evaluations 一行对应的领域对象。 */
export type EvaluationOutput = EvaluationResult;

/**
 * 三层评价主入口。
 *
 * @param useLlm 是否叠加 LLM 轨（PRD AC-F3.2）。默认 false —— 规则轨独立可用。
 *   LLM 轨的实际调用由调用方注入（llmVerdict 参数），本函数只负责**比对与标记**：
 *   两轨不一致 → evaluator='both' 且 needsReview=true，进入人工复核队列。
 *   把「调用模型」留在外面，是为了让这个文件保持纯函数、可单测。
 */
export function evaluateTask(
  ctx: EvalContext,
  options: {
    useLlm?: boolean;
    llmVerdict?: { outcome: Outcome; reason: string } | null;
  } = {},
): EvaluationOutput {
  const signals = extractSignals(ctx.events);
  const outcomeJudgement = judgeOutcome(ctx, signals);
  const process = analyzeProcess(ctx);
  const quality = scoreQuality(ctx, signals, process);
  const attribution = outcomeJudgement.outcome === 'achieved' ? null : attribute(ctx, signals, process);

  const evidence: Evidence[] = [...outcomeJudgement.evidence];
  if (attribution) evidence.push(...attribution.evidence);
  if (evidence.length === 0) {
    // PRD AC-F3.6 要求可解释率 100%：任何结论都必须至少带一条证据。
    evidence.push({
      kind: 'trace',
      ref: ctx.traceId ?? ctx.taskId,
      excerpt: `结果层判定依据：${outcomeJudgement.reason}`,
    });
  }

  // 双轨比对：仅当调用方真的提供了 LLM 判定时才可能不一致。
  const llm = options.useLlm ? options.llmVerdict ?? null : null;
  const disagreement = llm != null && llm.outcome !== outcomeJudgement.outcome;

  const reasons = [outcomeJudgement.reason];
  if (llm && disagreement) {
    reasons.push(`LLM 判定为「${llm.outcome}」（${llm.reason}），与规则轨不一致，转人工复核`);
  }
  if (attribution) reasons.push(`归因环节：${ATTRIBUTION_LABELS[attribution.stage]}`);

  return {
    evalId: `eval_${randomUUID()}`,
    taskId: ctx.taskId,
    traceId: ctx.traceId,
    sessionId: ctx.sessionId,
    chatJid: ctx.chatJid,
    outcome: outcomeJudgement.outcome,
    outcomeReason: reasons.join('；'),
    processScore: process.score,
    pathConformity: Number(process.pathConformity.toFixed(3)),
    stepCount: process.stepCount,
    retryCount: process.retryCount,
    firstAnomalyStep: process.firstAnomalyStep,
    durationMs: process.durationMs,
    qualityScores: quality,
    attributionStage: attribution?.stage ?? null,
    evidence,
    evaluator: disagreement ? 'both' : llm ? 'both' : 'rule',
    needsReview: disagreement,
    evalTime: Date.now(),
  };
}

/** 质量层均分 —— 看板与版本对比用的单一标量。 */
export function qualityMean(q: QualityScores): number {
  const sum = QUALITY_DIMENSIONS.reduce((a, d) => a + (q[d] ?? 0), 0);
  return Math.round(sum / QUALITY_DIMENSIONS.length);
}

/** 评价是否「质量不达标」（PRD F3.4：质量不达标也要归因）。 */
export function isQualityBelowBar(q: QualityScores, bar = 60): boolean {
  return QUALITY_DIMENSIONS.some((d) => (q[d] ?? 0) < bar);
}
