import type { RunSource, RunStatus } from '../../stores/runtime-monitor';

/** 状态徽章配色。`stale` 不是独立状态，而是 running 的补充标记（见 resolveStatusBadge）。 */
const STATUS_META: Record<RunStatus, { label: string; tone: 'success' | 'error' | 'warning' | 'info' | 'neutral' }> = {
  running: { label: '运行中', tone: 'info' },
  success: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'error' },
  cancelled: { label: '已取消', tone: 'neutral' },
  pending: { label: '等待中', tone: 'warning' },
};

export function resolveStatusBadge(
  status: RunStatus,
  stale: boolean,
): { label: string; tone: 'success' | 'error' | 'warning' | 'info' | 'neutral' } {
  if (status === 'running' && stale) return { label: '疑似卡住', tone: 'warning' };
  return STATUS_META[status] ?? { label: status, tone: 'neutral' };
}

/** 每种来源在表里怎么读 —— 只影响展示措辞，不影响数据。 */
const SOURCE_HINTS: Record<RunSource, string> = {
  chat: '对话会话的一轮',
  graph: '图谱编排的一次运行',
  'open-platform': '开放平台 Agent as a Service 调用',
  loop: 'Loop Engineering 的一次迭代',
  supervisor: '监督者会话',
  task: '定时任务的一次触发',
  sandbox: '沙箱代码执行',
  'harness-eval': 'Harness 评测运行',
};

export function sourceHint(source: RunSource): string {
  return SOURCE_HINTS[source] ?? '';
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m${rest.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

export function formatTokens(n: number | null | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

/** 相对时间（列表里比绝对时间戳更好扫）。 */
export function formatRelative(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = nowMs - t;
  if (diff < 0) return '刚刚';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

/** 趋势桶 key → 轴标签：`2026-10-12T03` → `10-12 03:00`，`2026-10-12` → `10-12`。 */
/**
 * 节点类型配色 —— 取值与 `components/chat/DagView.tsx` 的 `NODE_TYPE_COLORS` 一致，
 * 但**不**从那里 import：DagView 顶部静态 `import '@xyflow/react/dist/style.css'`，
 * 引它会把这个全局样式表带进监控页。改配色时两处要一起改。
 */
const NODE_COLORS: Record<string, string> = {
  turn: '#3b82f6',
  tool: '#10b981',
  skill: '#a855f7',
  subagent: '#f97316',
  review: '#eab308',
  goal_check: '#ef4444',
  thinking: '#6366f1',
  compact: '#8b5cf6',
  memory_recall: '#0ea5e9',
  memory_write: '#0891b2',
  tool_select: '#14b8a6',
  llm_call: '#06b6d4',
  permission_check: '#f59e0b',
  context_audit: '#a3a3a3',
  validation: '#16a34a',
};

export function nodeColor(nodeType: string): string {
  return NODE_COLORS[nodeType] ?? '#94a3b8';
}

export function formatBucketLabel(bucket: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/.exec(bucket);
  if (!m) return bucket;
  const [, , mo, d, h] = m;
  return h ? `${mo}-${d} ${h}:00` : `${mo}-${d}`;
}
