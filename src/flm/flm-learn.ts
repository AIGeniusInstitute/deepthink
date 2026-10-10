/**
 * FLM 学习与自进化层（PRD F4）。
 *
 * 四个子能力：
 *   F4.1/F4.2 短期纠偏 —— 立即、有界、可降级
 *   F4.3/F4.4 经验记忆 —— 案例库 + 向量检索
 *   F4.5      策略优化 —— 从归因分布产出四类策略版本
 *   F4.6      数据回流 —— 偏好对 / SFT 语料
 *   F4.7      知识自更新 —— 纠错反馈 → 知识条目候选（待审）
 *
 * 检索向量是**本地确定性哈希嵌入**，不调外部 embedding 服务。取舍：中文语义泛化弱于
 * 真模型，但零依赖、可复现、离线可测。为补泛化，检索走 embedding + 关键词的混合打分，
 * 并在返回值里如实标注本次用的是哪种模式（`indexMode`），避免"检索悄悄失灵"。
 */

import { createHash, randomUUID } from 'node:crypto';
import { readConfig, type FlmConfig } from './flm-config.js';
import {
  allCases,
  caseEvalIds,
  insertAction,
  insertCase,
  insertKnowledge,
  listEventsByTask,
  listEvaluations,
  insertStrategy,
  type FlmCaseRow,
  type FlmEvaluationRow,
  type FlmStrategyRow,
} from './flm-db.js';
import type {
  CorrectionPlan,
  IndexMode,
  Outcome,
  SampleType,
  StrategyType,
  AttributionStage,
  KnowledgeStatus,
} from './flm-types.js';

// ── F4.1 / F4.2 短期纠偏 ─────────────────────────────────────────────

/**
 * 可重试的归因环节。
 *
 * 「意图理解」与「规划」不在其中 —— 这两类失败重试同样的输入只会得到同样的错误结果，
 * 必须换信息（问清需求 / 重新规划），所以直接降级人工。这是业务判断，不是省事。
 */
const RETRYABLE_STAGES: ReadonlySet<AttributionStage> = new Set([
  'tool_selection',
  'param_gen',
  'execution',
  'summary',
]);

/**
 * 生成短期纠偏计划（PRD F4.1/F4.2）。
 *
 * 耗时闸门的算法（AC-F4.2 的「不超过原任务 2 倍」）：
 *   可用的额外耗时 budget = 原耗时 × (ratio − 1)
 *   单次重试成本用 **原耗时 / 步数** 估计 —— 重试重跑的是失败的那一步，不是整个任务。
 *   若按整任务耗时估，任何 ratio=2 的任务都会立刻超限，闸门等于恒关，没有意义。
 *   贪心取满足 `k×单步 + 退避累计 ≤ budget` 的最大 k，再受 maxRetries 封顶。
 */
export function planCorrection(
  evaluation: Pick<
    FlmEvaluationRow,
    'eval_id' | 'outcome' | 'attribution_stage' | 'duration_ms' | 'step_count'
  >,
  config: FlmConfig = readConfig(),
): CorrectionPlan {
  const policy = config.retryPolicy;
  const originalMs = Math.max(0, evaluation.duration_ms || 0);
  const stepCount = Math.max(1, evaluation.step_count || 1);
  const perAttemptMs = originalMs / stepCount;
  const budgetMs = originalMs * Math.max(0, policy.maxDurationRatio - 1);

  const backoffSum = (k: number) => {
    let s = 0;
    for (let i = 0; i < k; i++) s += policy.backoffMs[Math.min(i, policy.backoffMs.length - 1)] ?? 0;
    return s;
  };

  let allowed = 0;
  for (let k = 1; k <= policy.maxRetries; k++) {
    if (k * perAttemptMs + backoffSum(k) <= budgetMs) allowed = k;
    else break;
  }

  const stage = evaluation.attribution_stage;
  const stageRetryable = stage != null && RETRYABLE_STAGES.has(stage);
  const shouldRetry = evaluation.outcome !== 'achieved' && stageRetryable && allowed >= 1;

  const projectedMs = originalMs + allowed * perAttemptMs + backoffSum(allowed);

  let reason: string;
  if (evaluation.outcome === 'achieved') {
    reason = '任务已达成，无需纠偏';
  } else if (stage == null) {
    reason = '未定位到归因环节，无法定向纠偏，转人工';
  } else if (!stageRetryable) {
    reason = `归因环节「${stage}」重试无效（需补充信息或重新规划），转人工`;
  } else if (allowed < 1) {
    reason = `预估耗时 ${Math.round(projectedMs)}ms 将超出原任务 ${policy.maxDurationRatio} 倍上限（预算 ${Math.round(budgetMs)}ms），停止重试`;
  } else {
    reason = `按每步 ${Math.round(perAttemptMs)}ms 估计，可重试 ${allowed} 次，预计总耗时 ${Math.round(projectedMs)}ms`;
  }

  return {
    shouldRetry,
    maxRetries: shouldRetry ? allowed : 0,
    backoffMs: policy.backoffMs.slice(0, shouldRetry ? allowed : 0),
    toolWhitelist: policy.toolWhitelist,
    projectedMs,
    originalMs,
    escalateToHuman: !shouldRetry,
    reason,
  };
}

export interface CorrectionOutcome {
  actionId: string;
  attempted: number;
  succeeded: boolean;
  elapsedMs: number;
  escalated: boolean;
  detail: string;
}

/**
 * 执行纠偏（TC-FLM-16）。
 *
 * `attempt` 由调用方注入 —— 本层不关心重试的具体动作是什么（重发消息 / 换工具 / 重跑
 * 步骤），只负责**计数、计时、封顶、落库**。这样纠偏逻辑可离线单测，也不需要真的去
 * 触发一次智能体运行。
 *
 * 退避在测试里会很慢（默认 500/1500ms），所以 `sleep` 也允许注入。
 */
export async function executeCorrection(
  plan: CorrectionPlan,
  attempt: (attemptNo: number) => Promise<boolean>,
  options: {
    evaluationId?: string | null;
    executor?: string;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<CorrectionOutcome> {
  const actionId = `act_${randomUUID()}`;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let attempted = 0;
  let succeeded = false;

  if (plan.shouldRetry) {
    for (let i = 0; i < plan.maxRetries; i++) {
      if (i > 0) await sleep(plan.backoffMs[i] ?? 0);
      attempted++;
      try {
        if (await attempt(attempted)) {
          succeeded = true;
          break;
        }
      } catch {
        // 单次重试抛异常不算新信息 —— 继续用掉剩余额度，不提前放弃。
      }
    }
  }

  const elapsedMs = Date.now() - started;
  const escalated = plan.escalateToHuman || !succeeded;
  const detail = succeeded
    ? `第 ${attempted} 次重试成功，耗时 ${elapsedMs}ms`
    : plan.escalateToHuman
      ? `未执行重试（${plan.reason}）`
      : `${attempted} 次重试均未成功，转人工介入`;

  insertAction({
    action_id: actionId,
    eval_id: options.evaluationId ?? null,
    action_type: 'retry',
    before_version: null,
    after_version: null,
    executor: options.executor ?? 'flm-auto',
    result: succeeded ? 'success' : escalated ? 'escalated' : 'failed',
    detail,
    exec_time: Date.now(),
  });

  return { actionId, attempted, succeeded, elapsedMs, escalated, detail };
}

// ── F4.3 / F4.4 经验记忆与检索 ───────────────────────────────────────

const EMBED_DIM = 256;

function hashToken(token: string): { idx: number; sign: number } {
  const h = createHash('sha1').update(token).digest();
  return { idx: h.readUInt32BE(0) % EMBED_DIM, sign: (h[4] & 1) === 0 ? 1 : -1 };
}

/**
 * 确定性哈希嵌入：unigram + bigram 哈希到 256 维，L2 归一化。
 * 相同输入永远得到相同向量 —— 案例入库与检索分处两次请求，这一点是硬要求。
 */
export function embed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm.length === 0) return v;

  const add = (tok: string, w: number) => {
    const { idx, sign } = hashToken(tok);
    v[idx] += sign * w;
  };

  for (let i = 0; i < norm.length; i++) {
    add(norm[i], 1);
    if (i + 1 < norm.length) add(norm.slice(i, i + 2), 1.5); // bigram 权重更高：更能代表短语
  }

  let sq = 0;
  for (const x of v) sq += x * x;
  const len = Math.sqrt(sq);
  return len === 0 ? v : v.map((x) => x / len);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // 两边都已 L2 归一化
}

function bigrams(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/\s+/g, ' ').trim();
  const out = new Set<string>();
  for (let i = 0; i < norm.length - 1; i++) out.add(norm.slice(i, i + 2));
  if (out.size === 0 && norm.length > 0) out.add(norm);
  return out;
}

/**
 * bigram 集合的 Jaccard 重叠度。
 * 与 `lexicalOverlap` 拆开，是为了让批量比较的调用方能**复用已经算好的 bigram 集合**
 * —— `buildDataFeedback` 要在正×负双重循环里比较同一批目标上千次（见该函数内注释）。
 */
function jaccard(A: Set<string>, B: Set<string>): number {
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 关键词重叠度：bigram Jaccard。 */
export function lexicalOverlap(a: string, b: string): number {
  return jaccard(bigrams(a), bigrams(b));
}

export interface CaseHit {
  caseId: string;
  taskId: string | null;
  sampleType: SampleType;
  goal: string;
  summary: string | null;
  attributionStage: AttributionStage | null;
  similarity: number;
  cosineScore: number;
  lexicalScore: number;
  reuseCount: number;
}

/**
 * 案例检索（AC-F4.3 向量检索 Top-K、AC-F4.4 命中率）。
 *
 * 混合打分：0.7 × 余弦 + 0.3 × 关键词重叠。纯哈希嵌入对中文改写泛化不足，关键词项
 * 保证「原词重现」的查询一定排前 —— 这正是一线最常见的复用场景。
 *
 * `indexMode`：只要库里已有一条带 embedding 的案例就报 'embedding'；否则说明
 * embedding 不可用（历史数据未回填），降级为纯关键词，并**如实标注**。
 */
export function searchCases(query: string, topK = 5): { indexMode: IndexMode; hits: CaseHit[] } {
  const rows = allCases();
  // 空查询返回全部案例（相似度全 0）是噪声而非结果 —— 直接给空集，让调用方明确知道
  // "你没给查询条件"，而不是拿到一堆看似命中、实则无关的案例。
  if (query.trim().length === 0) return { indexMode: 'keyword', hits: [] };
  if (rows.length === 0) return { indexMode: 'keyword', hits: [] };

  const hasEmbedding = rows.some((r) => r.goal_embedding != null && r.goal_embedding !== '');
  const qv = hasEmbedding ? embed(query) : null;

  const hits: CaseHit[] = rows.map((r) => {
    const lexicalScore = lexicalOverlap(query, r.goal);
    let cosineScore = 0;
    if (qv && r.goal_embedding) {
      try {
        const rv = JSON.parse(r.goal_embedding) as number[];
        if (Array.isArray(rv) && rv.length === qv.length) cosineScore = cosine(qv, rv);
      } catch {
        cosineScore = 0;
      }
    }
    const similarity = hasEmbedding ? 0.7 * cosineScore + 0.3 * lexicalScore : lexicalScore;
    return {
      caseId: r.case_id,
      taskId: r.task_id,
      sampleType: r.sample_type,
      goal: r.goal,
      summary: r.summary,
      attributionStage: r.attribution_stage,
      similarity: Number(similarity.toFixed(4)),
      cosineScore: Number(cosineScore.toFixed(4)),
      lexicalScore: Number(lexicalScore.toFixed(4)),
      reuseCount: r.reuse_count,
    };
  });

  hits.sort((a, b) => b.similarity - a.similarity);

  // Top-K 必须是一组**互不相同的候选**，不能是同一条案例的 N 份拷贝。
  //
  // 为什么必须在这里去重：案例是评价的派生物，同一目标被反复评价就会沉淀出多条
  // 内容完全相同的案例（实盘 137 条案例只对应 12 个不同目标，Top-5 曾返回 5 条同样
  // 的「把使用手册，提交push」）。AC-F4.4 要求「Top5 命中率 ≥ 80%」，而 5 个坑位被
  // 同一条占满时，"命中率"根本无从度量 —— 这时的 Top-5 不是命中集合。
  //
  // 保留同目标中相似度最高的那条（hits 已按相似度降序，首次出现即为最优）。
  const seenGoals = new Set<string>();
  const distinct: CaseHit[] = [];
  for (const h of hits) {
    const key = h.goal.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenGoals.has(key)) continue;
    seenGoals.add(key);
    distinct.push(h);
    if (distinct.length >= topK) break;
  }
  return { indexMode: hasEmbedding ? 'embedding' : 'keyword', hits: distinct };
}

/** 由一次评价沉淀一条经验案例（AC-F4.3：成功入 positive，失败入 negative）。 */
export function buildCaseFromEvaluation(
  evaluation: FlmEvaluationRow,
  ctx: { goal: string; summary: string | null; sourceEventId?: string | null },
): FlmCaseRow {
  const sampleType: SampleType = evaluation.outcome === 'achieved' ? 'positive' : 'negative';
  return {
    case_id: `case_${randomUUID()}`,
    task_id: evaluation.task_id,
    eval_id: evaluation.eval_id,
    sample_type: sampleType,
    goal: ctx.goal,
    goal_embedding: JSON.stringify(embed(ctx.goal)),
    summary: ctx.summary,
    attribution_stage: evaluation.attribution_stage,
    reuse_count: 0,
    verified: 0,
    source_event_id: ctx.sourceEventId ?? null,
    created_at: Date.now(),
  };
}

/** 批量沉淀案例，返回实际写入条数。 */
export function persistCases(cases: FlmCaseRow[]): number {
  for (const c of cases) insertCase(c);
  return cases.length;
}

// ── F4.5 策略优化 ────────────────────────────────────────────────────

/** 归因环节 → 应当调整的策略类型。这是「从失败模式反推改哪里」的映射表。 */
const STAGE_TO_STRATEGY: Record<AttributionStage, StrategyType> = {
  intent: 'prompt',
  planning: 'routing',
  tool_selection: 'routing',
  param_gen: 'param',
  execution: 'param',
  summary: 'fewshot',
};

const STAGE_SUGGESTION: Record<AttributionStage, string> = {
  intent: '在系统提示词中加入意图澄清与确认步骤，降低理解偏差',
  planning: '调整任务路由规则，对复杂目标先做任务分解再执行',
  tool_selection: '补充工具选择示例与工具描述，修正选型偏好',
  param_gen: '增加参数校验与默认值兜底，补充参数生成示例',
  execution: '调整超时与重试参数，识别高失败率工具并降级',
  summary: '补充输出格式示例样本，对齐期望的呈现结构',
};

export interface StrategySuggestion {
  strategyType: StrategyType;
  name: string;
  content: string;
  attributionTag: AttributionStage;
  triggerSource: 'auto';
  requiresHumanReview: boolean;
  /** 触发该建议的样本数与占全部失败样本的比例。 */
  failCount: number;
  failRatio: number;
  rationale: string;
}

/**
 * 从一批评价的归因分布生成策略建议（AC-F4.5、TC-FLM-18）。
 *
 * 只对**失败/部分达成**的样本统计 —— 成功的样本不产生"该改什么"的信息。
 * 建议按失败占比排序，占比低于 10% 的不出建议：长尾个别失败做全局策略调整弊大于利。
 */
export function suggestStrategies(evaluations: FlmEvaluationRow[]): StrategySuggestion[] {
  const failed = evaluations.filter((e) => e.outcome !== 'achieved');
  if (failed.length === 0) return [];

  const byStage = new Map<AttributionStage, number>();
  for (const e of failed) {
    if (!e.attribution_stage) continue;
    byStage.set(e.attribution_stage, (byStage.get(e.attribution_stage) ?? 0) + 1);
  }

  const out: StrategySuggestion[] = [];
  for (const [stage, count] of byStage) {
    const ratio = count / failed.length;
    if (ratio < 0.1) continue;
    const type = STAGE_TO_STRATEGY[stage];
    out.push({
      strategyType: type,
      name: `${type}-from-${stage}`,
      content: STAGE_SUGGESTION[stage],
      attributionTag: stage,
      triggerSource: 'auto',
      // 影响输出安全/合规的策略必须人工过一道；其余可自动进入门禁流程。
      requiresHumanReview: type === 'prompt' && stage === 'intent',
      failCount: count,
      failRatio: Number(ratio.toFixed(3)),
      rationale: `${count}/${failed.length} 个未达成样本归因于「${stage}」`,
    });
  }

  out.sort((a, b) => b.failRatio - a.failRatio);
  return out;
}

/** 把建议落成 draft 版本（AC-F5.1：每次变更生成新版本并记录父版本）。 */
export function materializeStrategy(
  suggestion: StrategySuggestion,
  parentVersion: string | null,
): FlmStrategyRow {
  const now = Date.now();
  return {
    version_id: `strat_${randomUUID()}`,
    strategy_type: suggestion.strategyType,
    name: suggestion.name,
    content: suggestion.content,
    parent_version: parentVersion,
    trigger_source: suggestion.triggerSource,
    attribution_tag: suggestion.attributionTag,
    eval_report: JSON.stringify({ failCount: suggestion.failCount, failRatio: suggestion.failRatio }),
    gate_status: 'na',
    gray_ratio: 0,
    status: 'draft',
    requires_human_review: suggestion.requiresHumanReview ? 1 : 0,
    reviewed_by: null,
    publisher: null,
    publish_time: null,
    created_at: now,
    updated_at: now,
  };
}

export function persistStrategy(row: FlmStrategyRow): string {
  insertStrategy(row);
  return row.version_id;
}

// ── F4.6 数据回流 ────────────────────────────────────────────────────

export interface PreferencePair {
  pairId: string;
  goal: string;
  chosen: { taskId: string | null; summary: string; outcome: Outcome };
  rejected: { taskId: string | null; summary: string; outcome: Outcome };
  /**
   * 配对用的目标相似度（0–1，`0.7*余弦 + 0.3*词面重合`）。
   *
   * 这是"这两条轨迹为什么被配成一对"的唯一依据（须 ≥ minSimilarity），
   * 控制台的「相似度」列就是展示它。此前算了却没带出去，前端拿到 undefined
   * 调 `.toFixed()` 直接把整个控制台打白 —— 详见
   * docs/issues/2026-10-10-flm-learning-tab-crash-blanks-console.md。
   */
  similarity: number;
  generatedAt: number;
}

export interface SftSample {
  sampleId: string;
  goal: string;
  response: string;
  source: string;
  outcome: Outcome;
  generatedAt: number;
}

export interface DataFeedbackArtifact {
  preferencePairs: PreferencePair[];
  sftSamples: SftSample[];
  generatedAt: number;
  stats: { pairs: number; sft: number; positiveTasks: number; negativeTasks: number };
}

/**
 * 数据回流产物（AC-F4.6、TC-FLM-19）。
 *
 * 偏好对按 goal 相似度配对：同一个目标下既有成功又有失败的轨迹，才构成一组有效的
 * chosen/rejected 对比。相似度低于 0.5 的不配对 —— 目标都不同的两条轨迹放在一起，
 * 模型学到的是"这两个任务不一样"，不是"哪种做法更好"。
 */
export function buildDataFeedback(
  evaluations: FlmEvaluationRow[],
  goalByTask: Map<string, { goal: string; summary: string | null }>,
  minSimilarity = 0.5,
): DataFeedbackArtifact {
  const positive: FlmEvaluationRow[] = [];
  const negative: FlmEvaluationRow[] = [];
  for (const e of evaluations) {
    if (!goalByTask.has(e.task_id)) continue;
    if (e.outcome === 'achieved') positive.push(e);
    else negative.push(e);
  }

  const preferencePairs: PreferencePair[] = [];
  const usedNeg = new Set<string>();

  // 目标文本 → 向量 / bigram 集合的记忆化。
  //
  // `embed` 是 O(文本长度)：目标文本最长 300 字，每字都要 sha1 一次 unigram 与一次
  // bigram，并按位切出 600 个子串；`bigrams` 同样要切一遍。而下面是**正 × 负的双重
  // 循环**，原先每次比较都现场重算两侧 —— 同一个目标被向量化上千次。实盘一次
  // `/admin/data-feedback` 要 3.8 秒，而这段是**同步**计算，会把 Node 的事件循环一起
  // 冻住：同进程内连 1.5ms 的 `/api/flm/health` 都得排队等 3.5 秒（已实测）。
  //
  // 相似度是纯函数，按目标文本记忆化不改变任何数值，只是把调用次数从 O(正×负) 降到
  // O(不同目标数)。实盘 137 条案例只对应 12 个不同目标，这一步能省掉 99% 的计算。
  const vecCache = new Map<string, number[]>();
  const gramCache = new Map<string, Set<string>>();
  const vecOf = (t: string): number[] => {
    let v = vecCache.get(t);
    if (v === undefined) {
      v = embed(t);
      vecCache.set(t, v);
    }
    return v;
  };
  const gramOf = (t: string): Set<string> => {
    let g = gramCache.get(t);
    if (g === undefined) {
      g = bigrams(t);
      gramCache.set(t, g);
    }
    return g;
  };

  for (const p of positive) {
    const pg = goalByTask.get(p.task_id)!.goal;
    const pv = vecOf(pg);
    const pGram = gramOf(pg);
    let best: { neg: FlmEvaluationRow; sim: number } | null = null;
    for (const n of negative) {
      if (usedNeg.has(n.eval_id)) continue;
      const ng = goalByTask.get(n.task_id)!.goal;
      const sim = 0.7 * cosine(pv, vecOf(ng)) + 0.3 * jaccard(pGram, gramOf(ng));
      if (sim >= minSimilarity && (best == null || sim > best.sim)) best = { neg: n, sim };
    }
    if (!best) continue;
    usedNeg.add(best.neg.eval_id);
    preferencePairs.push({
      pairId: `pair_${randomUUID()}`,
      goal: pg,
      chosen: {
        taskId: p.task_id,
        summary: goalByTask.get(p.task_id)!.summary ?? '',
        outcome: p.outcome,
      },
      rejected: {
        taskId: best.neg.task_id,
        summary: goalByTask.get(best.neg.task_id)!.summary ?? '',
        outcome: best.neg.outcome,
      },
      // 四舍五入到 4 位，避免把浮点尾巴（0.7000000000000001）抛给前端。
      similarity: Number(best.sim.toFixed(4)),
      generatedAt: Date.now(),
    });
  }

  // SFT 语料只取成功轨迹 —— 用失败轨迹做监督微调等于教模型学错答案。
  const sftSamples: SftSample[] = positive.map((p) => {
    const g = goalByTask.get(p.task_id)!;
    return {
      sampleId: `sft_${randomUUID()}`,
      goal: g.goal,
      response: g.summary ?? '',
      source: `task:${p.task_id}`,
      outcome: p.outcome,
      generatedAt: Date.now(),
    };
  });

  return {
    preferencePairs,
    sftSamples,
    generatedAt: Date.now(),
    stats: {
      pairs: preferencePairs.length,
      sft: sftSamples.length,
      positiveTasks: new Set(positive.map((p) => p.task_id)).size,
      negativeTasks: new Set(negative.map((n) => n.task_id)).size,
    },
  };
}

/** 导出为 JSONL（偏好对 / SFT 各一文件内容）。每行自带来源与生成时间。 */
export function toJsonl(artifact: DataFeedbackArtifact): { pairs: string; sft: string } {
  return {
    pairs: artifact.preferencePairs.map((p) => JSON.stringify(p)).join('\n'),
    sft: artifact.sftSamples.map((s) => JSON.stringify(s)).join('\n'),
  };
}

// ── F4.7 知识库自更新 ────────────────────────────────────────────────

export interface KnowledgeCandidate {
  id: string;
  title: string;
  content: string;
  sourceEventId: string | null;
  sourceTaskId: string | null;
  status: KnowledgeStatus;
}

/**
 * 从纠错类反馈生成知识条目候选（AC-F4.7、TC-FLM-20）。
 *
 * **只生成候选，不直接入库知识库** —— 这是 AC-F4.7 的硬要求。纠错内容是用户随手写的
 * 自由文本，未经验证就当成知识会让错误知识固化进系统，比没有知识更糟。
 *
 * 过滤规则：纠错文本短于 4 个字符的不生成候选（"不对"这类无信息量的纠正无法成条目）。
 */
export function buildKnowledgeCandidates(taskId: string): KnowledgeCandidate[] {
  const events = listEventsByTask(taskId);
  const out: KnowledgeCandidate[] = [];

  for (const e of events) {
    if (e.source !== 'user' || e.type !== 'explicit_correction') continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(e.normalized_payload ?? '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    const correction = typeof payload.correction_text === 'string' ? payload.correction_text.trim() : '';
    if (correction.length < 4) continue;

    out.push({
      id: `kn_${randomUUID()}`,
      title: correction.slice(0, 40),
      content: correction,
      sourceEventId: e.event_id,
      sourceTaskId: taskId,
      status: 'pending',
    });
  }

  return out;
}

export function persistKnowledgeCandidates(candidates: KnowledgeCandidate[]): number {
  for (const c of candidates) {
    insertKnowledge({
      id: c.id,
      title: c.title,
      content: c.content,
      source_event_id: c.sourceEventId,
      source_task_id: c.sourceTaskId,
      status: c.status,
      reviewer: null,
      review_note: null,
      reviewed_at: null,
      created_at: Date.now(),
    });
  }
  return candidates.length;
}

/**
 * 批量评价 → 案例沉淀的一站式入口（供评价批处理调用）。
 *
 * **幂等**：已经沉淀过的评价不再重复生成案例。同一条评价沉淀两次得到的两行内容
 * 逐字段相同 —— 案例是评价的纯派生物，重复沉淀只带来膨胀（实盘 137 条案例仅对应
 * 12 个不同目标），并让 Top-K 检索被同一目标的拷贝占满。
 *
 * 不采用"按 case_id 覆盖"的写法：案例上挂着运营的人工修正（`attribution_stage`
 * via AC-F6.3）、`verified` 与 `reuse_count`，整行替换会把这些抹掉。
 *
 * 已知取舍：若某条评价被重新评价且结论改变，它的旧案例不会被刷新。刷新需要区分
 * "运营改过的案例"与"纯派生案例"，属于产品决策，不在本次范围内 —— 见
 * docs/issues/2026-10-10-flm-case-library-duplicates-and-topk.md §6。
 */
export function learnFromEvaluations(
  evaluations: FlmEvaluationRow[],
  goalByTask: Map<string, { goal: string; summary: string | null }>,
): { cases: number; strategies: string[]; suggestions: number } {
  const already = caseEvalIds();
  const cases: FlmCaseRow[] = [];
  for (const e of evaluations) {
    const g = goalByTask.get(e.task_id);
    if (!g) continue;
    if (already.has(e.eval_id)) continue; // 幂等：一次评价只沉淀一次
    cases.push(buildCaseFromEvaluation(e, { goal: g.goal, summary: g.summary }));
  }
  persistCases(cases);

  const suggestions = suggestStrategies(evaluations);
  const versionIds: string[] = [];
  for (const s of suggestions) {
    versionIds.push(persistStrategy(materializeStrategy(s, null)));
  }

  return { cases: cases.length, strategies: versionIds, suggestions: suggestions.length };
}

/** 供路由查询用的评价列表透传（避免路由层直接 import flm-db 造成依赖面扩大）。 */
export function recentEvaluations(limit = 200): FlmEvaluationRow[] {
  return listEvaluations({ limit });
}
