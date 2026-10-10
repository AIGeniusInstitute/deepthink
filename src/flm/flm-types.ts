/**
 * FLM（反馈与学习自进化模块）类型定义。
 *
 * 与 db.ts 里的 Row 类型分开：Row 是「表长什么样」，这里是对外语义类型
 * （枚举、DTO、算法输入输出）。两边的字符串联合必须保持一致 —— 表里存的是
 * 这些字符串，没有 DB 层 CHECK 兜底，所以这里改了枚举值要同步看历史数据。
 */

// ── 反馈来源（PRD F1.4：用户反馈 / 系统日志 / 环境数据）──────────────────
export type FeedbackSource = 'user' | 'system' | 'env';

// ── 反馈类型 ──────────────────────────────────────────────────────────
/** 显式：用户主动表达；隐式：从行为推断（PRD F1.1）。 */
export type FeedbackType =
  | 'explicit_like'
  | 'explicit_reject'
  | 'explicit_rating'
  | 'explicit_adopt'
  | 'explicit_correction'
  | 'implicit_reask'
  | 'implicit_rewrite'
  | 'implicit_abandon'
  | 'system_tool_call'
  | 'system_error'
  | 'system_timeout'
  | 'system_retry'
  | 'system_token_usage'
  | 'env_snapshot_diff';

/** 点踩原因标签（PRD F1.1 原文六选一）。 */
export const REASON_TAGS = [
  '答非所问',
  '事实错误',
  '格式不符',
  '过于冗长',
  '未完成任务',
  '其他',
] as const;
export type ReasonTag = (typeof REASON_TAGS)[number];

// ── 三层评价（PRD F3）────────────────────────────────────────────────
/** 结果层三档。 */
export type Outcome = 'achieved' | 'partial' | 'failed';

/** 失败归因环节（PRD F3.4 原文六环节）。 */
export type AttributionStage =
  | 'intent'
  | 'planning'
  | 'tool_selection'
  | 'param_gen'
  | 'execution'
  | 'summary';

export const ATTRIBUTION_STAGES: AttributionStage[] = [
  'intent',
  'planning',
  'tool_selection',
  'param_gen',
  'execution',
  'summary',
];

export const ATTRIBUTION_LABELS: Record<AttributionStage, string> = {
  intent: '意图理解',
  planning: '规划',
  tool_selection: '工具选择',
  param_gen: '参数生成',
  execution: '执行',
  summary: '总结',
};

/** 质量层六维（PRD F3.3）。 */
export type QualityDimension =
  | 'factuality'
  | 'format'
  | 'latency'
  | 'cost'
  | 'safety'
  | 'preference';

export const QUALITY_DIMENSIONS: QualityDimension[] = [
  'factuality',
  'format',
  'latency',
  'cost',
  'safety',
  'preference',
];

export const QUALITY_LABELS: Record<QualityDimension, string> = {
  factuality: '事实性',
  format: '格式合规',
  latency: '响应时延',
  cost: '成本消耗',
  safety: '安全合规',
  preference: '偏好匹配',
};

export type QualityScores = Record<QualityDimension, number>;

/** 评价执行者。`both` 表示规则轨与 LLM 轨都跑了（PRD AC-F3.2）。 */
export type Evaluator = 'rule' | 'llm' | 'both' | 'human';

/** 可解释性证据片段（PRD F3.5）。 */
export interface Evidence {
  kind: 'feedback' | 'log' | 'env' | 'trace';
  ref: string;
  excerpt: string;
}

// ── 经验记忆（PRD F4.2）──────────────────────────────────────────────
export type SampleType = 'positive' | 'negative';

/** 检索模式。embedding 不可用时降级为 keyword —— 返回值显式标注，避免"检索悄悄失灵"。 */
export type IndexMode = 'embedding' | 'keyword';

// ── 策略版本与闭环（PRD F5）──────────────────────────────────────────
export type StrategyType = 'prompt' | 'routing' | 'param' | 'fewshot';

export type StrategyStatus = 'draft' | 'canary' | 'released' | 'rolled_back' | 'archived';

/** 回归门禁结论。`na` = 未跑过。 */
export type GateStatus = 'na' | 'passed' | 'blocked';

export type TriggerSource = 'auto' | 'human';

/** 知识条目候选状态（PRD F4.7：审核通过才入知识库）。 */
export type KnowledgeStatus = 'pending' | 'accepted' | 'rejected';

export type ActionType =
  | 'retry'
  | 'replan'
  | 'strategy_update'
  | 'rollback'
  | 'gate'
  | 'release';

// ── DTO ──────────────────────────────────────────────────────────────

/** 采集层产出的反馈事件草稿 —— 归一化层的输入。 */
export interface FeedbackDraft {
  source: FeedbackSource;
  type: FeedbackType;
  taskId?: string | null;
  traceId?: string | null;
  sessionId?: string | null;
  stepId?: string | null;
  chatJid?: string | null;
  userId?: string | null;
  rawPayload: Record<string, unknown>;
  occurredAt: number;
}

/** 归一化后的统一反馈事件（PRD F2.1 的 FeedbackEvent）。 */
export interface NormalizedEvent {
  eventId: string;
  source: FeedbackSource;
  type: FeedbackType;
  taskId: string | null;
  traceId: string | null;
  sessionId: string | null;
  stepId: string | null;
  chatJid: string | null;
  userId: string | null;
  rawPayload: string;
  normalizedPayload: string;
  confidence: number;
  weight: number;
  alignment: 'direct' | 'fallback';
  dedupKey: string;
  desensitized: boolean;
  conflict: boolean;
  tenantId: string;
  occurredAt: number;
}

/** 三层评价结果（PRD F3 输出）。 */
export interface EvaluationResult {
  evalId: string;
  taskId: string;
  traceId: string | null;
  sessionId: string | null;
  chatJid: string | null;
  outcome: Outcome;
  outcomeReason: string;
  processScore: number;
  pathConformity: number;
  stepCount: number;
  retryCount: number;
  firstAnomalyStep: string | null;
  durationMs: number;
  qualityScores: QualityScores;
  attributionStage: AttributionStage | null;
  evidence: Evidence[];
  evaluator: Evaluator;
  needsReview: boolean;
  evalTime: number;
}

/** 短期纠偏计划（PRD F4.1）。 */
export interface CorrectionPlan {
  shouldRetry: boolean;
  maxRetries: number;
  backoffMs: number[];
  toolWhitelist: string[];
  projectedMs: number;
  originalMs: number;
  /** true = 超出 2 倍耗时闸门或重试超限，降级人工介入。 */
  escalateToHuman: boolean;
  reason: string;
}

/** 版本对比结论（PRD F6.4）。 */
export interface VersionComparison {
  a: string;
  b: string;
  metrics: Array<{
    name: string;
    a: number;
    b: number;
    delta: number;
    /** 对 B 而言是改善还是劣化。 */
    verdict: 'improved' | 'regressed' | 'neutral';
  }>;
  recommendation: string;
  shouldRelease: boolean;
}
