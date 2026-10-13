import { create } from 'zustand';
import { api } from '../api/client';

/**
 * Agent 运行监控。
 *
 * 后端的归一化「运行」视图由 `/api/runtime-monitor/*` 提供，这里只做状态缓存与
 * 查询参数拼装 —— 平台里 8 条运行链路（对话 / 图 / 开放平台 / Loop / 监督者 /
 * 定时任务 / 沙箱 / Harness 评测）在前端是同一种东西，不再各写一套。

 * 类型与后端 `src/runtime-monitor/types.ts` 一一对应。
 */

export type RunSource =
  | 'chat'
  | 'graph'
  | 'open-platform'
  | 'loop'
  | 'supervisor'
  | 'task'
  | 'sandbox'
  | 'harness-eval';

export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'pending';
export type RunWindow = '1h' | '24h' | '7d' | '30d' | 'all';

export interface RunSummary {
  runId: string;
  source: RunSource;
  sourceLabel: string;
  title: string;
  workspace: string;
  workspaceLabel: string;
  ownerUserId: string | null;
  ownerUsername: string | null;
  agentId: string | null;
  agentName: string | null;
  status: RunStatus;
  rawStatus: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: string | null;
  stale: boolean;
}

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
  traceNote: string | null;
}

export interface RunQuery {
  sources?: RunSource[];
  statuses?: RunStatus[];
  window?: RunWindow;
  q?: string;
  staleOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function buildRunQueryString(q: RunQuery): string {
  const p = new URLSearchParams();
  if (q.sources?.length) p.set('source', q.sources.join(','));
  if (q.statuses?.length) p.set('status', q.statuses.join(','));
  if (q.window) p.set('window', q.window);
  if (q.q) p.set('q', q.q);
  if (q.staleOnly) p.set('stale', '1');
  if (q.limit != null) p.set('limit', String(q.limit));
  if (q.offset != null) p.set('offset', String(q.offset));
  return p.toString();
}

/** 来源注册表条目（由后端吐给前端，避免前端再抄一份名字）。 */
export interface SourceMetaItem {
  source: RunSource;
  label: string;
}

interface RuntimeMonitorState {
  overview: MonitorOverview | null;
  runs: RunSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  detail: RunDetail | null;
  detailLoading: boolean;
  live: boolean;
  /** 全部来源（含当前窗口内为空的），用于把来源分布渲染成固定 8 个筛选项。 */
  sourceMeta: SourceMetaItem[];
  loadSourceMeta: () => Promise<void>;
  loadOverview: (window: RunWindow, filter: RunQuery) => Promise<void>;
  loadRuns: (q: RunQuery) => Promise<void>;
  loadDetail: (runId: string) => Promise<void>;
  clearDetail: () => void;
  setLive: (v: boolean) => void;
}

export const useRuntimeMonitorStore = create<RuntimeMonitorState>((set) => ({
  overview: null,
  runs: [],
  total: 0,
  loading: false,
  error: null,
  detail: null,
  detailLoading: false,
  live: true,
  sourceMeta: [],

  loadSourceMeta: async () => {
    try {
      const res = await api.get<{ sources: SourceMetaItem[] }>('/api/runtime-monitor/sources');
      set({ sourceMeta: res.sources });
    } catch {
      // 拿不到注册表不是致命问题：来源分布退化成"只展示有数据的来源"（旧行为），
      // 所以这里不设 error，避免因为一个静态清单把整页标红。
    }
  },

  loadOverview: async (window, filter) => {
    try {
      // overview 自带窗口下的全部聚合；来源/状态筛选同样生效，但时间范围只认 window
      const qs = buildRunQueryString({ ...filter, window, limit: undefined, offset: undefined });
      const overview = await api.get<MonitorOverview>(`/api/runtime-monitor/overview?${qs}`);
      set({ overview, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadRuns: async (q) => {
    set({ loading: true });
    try {
      const page = await api.get<{ runs: RunSummary[]; total: number }>(
        `/api/runtime-monitor/runs?${buildRunQueryString(q)}`,
      );
      set({ runs: page.runs, total: page.total, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadDetail: async (runId) => {
    set({ detailLoading: true, detail: null });
    try {
      const detail = await api.get<RunDetail>(
        `/api/runtime-monitor/runs/${encodeURIComponent(runId)}`,
      );
      set({ detail, detailLoading: false });
    } catch (err) {
      set({
        detailLoading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  clearDetail: () => set({ detail: null }),

  setLive: (v) => set({ live: v }),
}));
