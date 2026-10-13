/**
 * Agent Runtime Monitor — 统一「运行」抽象的类型定义。
 *
 * 平台里存在 8 条互不相通的 agent 运行记录链路（对话 / 图编排 / 开放平台 AaaS /
 * Loop / 监督者 / 定时任务 / 沙箱 / Harness 评测），各自的表结构与状态词表都不同。
 * 本模块把它们归一成同一个 `RunSummary`，让「全部 agent 现在跑得怎么样」成为一个
 * 可以一次查询回答的问题。
 *
 * 归一化只发生在**读侧**：除开放平台 AaaS 新增的运行记录表外，不改任何既有写入路径。
 */

/** 运行来源。与 `sources.ts` 的注册表 key 一一对应。 */
export type RunSource =
  | 'chat'
  | 'graph'
  | 'open-platform'
  | 'loop'
  | 'supervisor'
  | 'task'
  | 'sandbox'
  | 'harness-eval';

/** 归一化状态。各来源的原值经 `sources.ts` 的映射收敛到这里。 */
export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'pending';

export const RUN_SOURCES: RunSource[] = [
  'chat',
  'graph',
  'open-platform',
  'loop',
  'supervisor',
  'task',
  'sandbox',
  'harness-eval',
];

export const RUN_STATUSES: RunStatus[] = [
  'running',
  'success',
  'failed',
  'cancelled',
  'pending',
];

/** 一次运行。字段语义见 PRD §3。 */
export interface RunSummary {
  /** `{source}:{nativeId}`，例：`chat:web:main#701`、`graph:graph-c86a5085-...` */
  runId: string;
  source: RunSource;
  sourceLabel: string;
  title: string;
  /** group_folder 或 chat_jid；开放平台固定为 `'open-platform'`。 */
  workspace: string;
  workspaceLabel: string;
  ownerUserId: string | null;
  ownerUsername: string | null;
  agentId: string | null;
  agentName: string | null;
  /** 归一化状态。 */
  status: RunStatus;
  /** 原始表里的状态原值，供追溯（UI 展示为 tooltip）。 */
  rawStatus: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: string | null;
  /** `status === 'running'` 且已运行超过 `STALE_AFTER_MS` → 疑似卡住（ended_at 从未回写）。 */
  stale: boolean;
}

/** 运行内部的一步。各来源的轨迹表归一到这里。 */
export interface TraceItem {
  spanId: string;
  parentSpanId: string | null;
  nodeType: string;
  title: string | null;
  status: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  tokens: number;
  toolName: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
}

export type RunWindow = '24h' | '1h' | '7d' | '30d' | 'all';

export const WINDOW_MS: Record<RunWindow, number | null> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: null,
};

/**
 * 「疑似卡住」阈值。运行超过这么久仍停在 running，说明节点收尾（`ended_at` 回写）
 * 没发生 —— 生产基线里这类孤儿节点是真实存在的（最老的一条始于 2026-09-23）。
 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

export interface RunFilter {
  sources?: RunSource[];
  statuses?: RunStatus[];
  /** ISO 8601，含。 */
  from?: string;
  /** ISO 8601，不含。 */
  to?: string;
  /** 关键词，在 title / workspace 上做 LIKE。 */
  q?: string;
  /** 只看疑似卡住的运行。 */
  staleOnly?: boolean;
  /**
   * 可见工作区白名单；**`null` = 不限制（admin）**。
   * 非 chat 来源的 workspace 是 group_folder，chat 来源是 chat_jid —— 两者都收进来。
   *
   * ⚠️ **fail-closed**：`undefined`（字段未指定）与 `[]` 一样按"什么都看不到"处理，
   * 只有**显式** `null` 才表示不限制。省略这个字段不会退化成"看全部"，而是拿到空列表。
   *
   * 选这个默认值的理由：授权过滤误放宽会静默泄露跨租户数据，误收紧只会让页面空白 ——
   * 前者看不见，后者一眼就能发现。所以宁可让调用方每次都显式声明。
   * 路由层由 `scopeFor()` 统一填充（admin → `null`，其余 → 白名单数组）。
   */
  allowedWorkspaces?: string[] | null;
  /** 非 admin 用户，用于放行自己名下的开放平台运行。 */
  viewerUserId?: string;
  /** 当前时间（ISO），注入以便测试。 */
  now?: string;
}

export interface RunPage {
  runs: RunSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface OverviewKpis {
  running: number;
  stale: number;
  total: number;
  success: number;
  failed: number;
  successRate: number | null;
  tokens: number;
  costUsd: number;
  p95DurationMs: number | null;
  /** P95 的样本量 —— 样本太少时 UI 需要标注，避免把个位数样本当统计结论。 */
  durationSampleSize: number;
}

export interface SourceBreakdownItem {
  source: RunSource;
  sourceLabel: string;
  total: number;
  running: number;
  failed: number;
  tokens: number;
  costUsd: number;
}

/**
 * 按工作区聚合的分布（Top N）。
 *
 * `workspace` 是 chat_jid / group_folder；**开放平台例外**——它没有工作区概念，
 * 该字段是 `agent_id`（`workspaceLabel` 为 Agent 名）。这是刻意的：AaaS 的运行
 * 只有按 Agent 分组才有意义，详见 `queries.ts` 的 `byWorkspace`。
 */
export interface WorkspaceBreakdownItem {
  workspace: string;
  workspaceLabel: string;
  total: number;
  running: number;
  failed: number;
  tokens: number;
  costUsd: number;
}

export interface TrendBucket {
  /** 小时桶 `2026-10-12T03` / 天桶 `2026-10-12`。 */
  bucket: string;
  total: number;
  success: number;
  failed: number;
  running: number;
  tokens: number;
  costUsd: number;
}

export interface MonitorOverview {
  window: RunWindow;
  generatedAt: string;
  kpis: OverviewKpis;
  bySource: SourceBreakdownItem[];
  byWorkspace: WorkspaceBreakdownItem[];
  trend: TrendBucket[];
  trendBucket: 'hour' | 'day';
}

export interface RunDetail {
  run: RunSummary;
  trace: TraceItem[];
  /** 轨迹为空时的原因说明（如来源本身没有分步轨迹），UI 直接展示。 */
  traceNote: string | null;
}
