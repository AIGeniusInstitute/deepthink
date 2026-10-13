/**
 * Agent 运行监控页。
 *
 * 一句话：把平台里 8 条各自为政的 agent 运行链路（对话 / 图谱编排 / 开放平台
 * AaaS / Loop / 监督者 / 定时任务 / 沙箱 / Harness 评测）汇总成**一个列表**，
 * 配总览 KPI + 趋势，点进去看单次运行的分步轨迹。
 *
 * 归一化在服务端完成（`/api/runtime-monitor/*`），本页不做任何跨来源的状态判断，
 * 只负责筛选、渲染与轮询。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Activity, AlertTriangle, Pause, Play } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonStatCards } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  useRuntimeMonitorStore,
  type RunSource,
  type RunStatus,
  type RunWindow,
} from '../stores/runtime-monitor';
import { RunDetailPanel } from '@/components/runtime-monitor/RunDetailPanel';
import {
  formatBucketLabel,
  formatCost,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTokens,
  resolveStatusBadge,
} from '@/components/runtime-monitor/format';

const WINDOWS: Array<{ value: RunWindow; label: string }> = [
  { value: '1h', label: '1 小时' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'all', label: '全部' },
];

const STATUS_OPTIONS: Array<{ value: RunStatus; label: string }> = [
  { value: 'running', label: '运行中' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
  { value: 'pending', label: '等待中' },
];

const PAGE_SIZE = 20;
const POLL_MS = 10_000;

function KpiCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' | 'error' }) {
  const toneClass = tone === 'error' ? 'text-error' : tone === 'warn' ? 'text-warning' : 'text-foreground';
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export function RuntimeMonitorPage() {
  const overview = useRuntimeMonitorStore((s) => s.overview);
  const runs = useRuntimeMonitorStore((s) => s.runs);
  const total = useRuntimeMonitorStore((s) => s.total);
  const loading = useRuntimeMonitorStore((s) => s.loading);
  const error = useRuntimeMonitorStore((s) => s.error);
  const live = useRuntimeMonitorStore((s) => s.live);
  const setLive = useRuntimeMonitorStore((s) => s.setLive);
  const loadDetail = useRuntimeMonitorStore((s) => s.loadDetail);
  const sourceMeta = useRuntimeMonitorStore((s) => s.sourceMeta);
  const loadSourceMeta = useRuntimeMonitorStore((s) => s.loadSourceMeta);

  // 来源注册表是静态的，进页面拉一次就够
  useEffect(() => {
    void loadSourceMeta();
  }, [loadSourceMeta]);

  const [win, setWin] = useState<RunWindow>('7d');
  const [sources, setSources] = useState<RunSource[]>([]);
  const [statuses, setStatuses] = useState<RunStatus[]>([]);
  const [staleOnly, setStaleOnly] = useState(false);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(0);

  const filter = useMemo(
    () => ({
      sources: sources.length ? sources : undefined,
      statuses: statuses.length ? statuses : undefined,
      q: debouncedQ || undefined,
      staleOnly: staleOnly || undefined,
    }),
    [sources, statuses, debouncedQ, staleOnly],
  );

  // 输入防抖：每次按键都打后端会把这个页面的轮询变成负担
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  const reload = useCallback(
    async (offset: number) => {
      const s = useRuntimeMonitorStore.getState();
      await Promise.all([
        s.loadOverview(win, filter),
        s.loadRuns({ ...filter, window: win, limit: PAGE_SIZE, offset }),
      ]);
    },
    [win, filter],
  );

  // 筛选变化 → 回到第一页并立即刷新
  useEffect(() => {
    setPage(0);
    void reload(0);
  }, [reload]);

  // 自动刷新（可暂停）：正在看某条运行的轨迹时暂停比较友好，但默认开着，
  // 因为"现在有哪些 agent 在跑"是这个页面存在的理由。
  // 标签页不可见时不轮询（与 ChatView 的可见性处理一致）——后台页每 10s 打一次后端没有意义；
  // 切回来时立刻补一次，避免看到滞留数据。
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      void reload(page * PAGE_SIZE);
    }, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) void reload(page * PAGE_SIZE);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [live, reload, page]);

  const toggleSource = (src: RunSource) => {
    setSources((prev) => (prev.includes(src) ? prev.filter((s) => s !== src) : [...prev, src]));
  };
  const toggleStatus = (st: RunStatus) => {
    setStatuses((prev) => (prev.includes(st) ? prev.filter((s) => s !== st) : [...prev, st]));
  };

  const kpis = overview?.kpis;
  const trendData = useMemo(
    () => (overview?.trend ?? []).map((b) => ({ ...b, label: formatBucketLabel(b.bucket) })),
    [overview],
  );

  // 来源 chips 以**注册表为骨架**（8 个全在），再叠上当前窗口的计数 —— 空来源也要显示，
  // 否则用户没法点开一个当前为空的来源确认它确实没在跑。
  // 注册表还没到（或拉失败）时退化成"只显示有数据的来源"，即原来的行为。
  const sourceChips = useMemo(() => {
    const counts = new Map((overview?.bySource ?? []).map((s) => [s.source, s]));
    const base = sourceMeta.length
      ? sourceMeta.map((m) => ({ source: m.source, sourceLabel: m.label }))
      : (overview?.bySource ?? []).map((s) => ({ source: s.source, sourceLabel: s.sourceLabel }));
    return base.map((b) => {
      const c = counts.get(b.source);
      return {
        source: b.source,
        sourceLabel: b.sourceLabel,
        total: c?.total ?? 0,
        failed: c?.failed ?? 0,
      };
    });
  }, [overview, sourceMeta]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <PageHeader
          title="Agent 运行监控"
          subtitle="全部来源的 agent 运行轨迹、状态与趋势汇总（对话 / 编排 / 开放平台 / Loop / 监督者 / 定时任务 / 沙箱 / 评测）"
          className="mb-6"
          actions={
            <>
              <select
                value={win}
                onChange={(e) => setWin(e.target.value as RunWindow)}
                className="h-8 px-2 rounded-lg border border-border bg-card text-sm text-foreground"
                aria-label="时间范围"
              >
                {WINDOWS.map((w) => (
                  <option key={w.value} value={w.value}>{w.label}</option>
                ))}
              </select>
              <Button
                variant="outline"
                onClick={() => setLive(!live)}
                title={live ? '暂停自动刷新' : '恢复自动刷新'}
                data-testid="toggle-live"
              >
                {live ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {live ? '自动刷新中' : '已暂停'}
              </Button>
              <Button variant="outline" onClick={() => void reload(page * PAGE_SIZE)} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </>
          }
        />

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-error-bg px-3 py-2 text-sm text-error">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {!overview && loading && <SkeletonStatCards />}

        {overview && kpis && (
          <div className="space-y-6">
            {/* ---- 总览 KPI ---- */}
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3" data-testid="kpi-cards">
              <KpiCard label="运行中" value={String(kpis.running)} hint={`共 ${kpis.total} 次运行`} />
              <KpiCard
                label="疑似卡住"
                value={String(kpis.stale)}
                hint="running 超 30 分钟"
                tone={kpis.stale > 0 ? 'warn' : undefined}
              />
              <KpiCard label="成功" value={String(kpis.success)} />
              <KpiCard
                label="失败"
                value={String(kpis.failed)}
                tone={kpis.failed > 0 ? 'error' : undefined}
              />
              <KpiCard
                label="成功率"
                value={formatPercent(kpis.successRate)}
                hint={kpis.successRate == null ? '无可判定样本' : undefined}
              />
              <KpiCard label="Token" value={formatTokens(kpis.tokens)} />
              <KpiCard
                label="总成本"
                value={formatCost(kpis.costUsd)}
                hint="按 token 单价估算"
              />
              <KpiCard
                label="P95 耗时"
                value={formatDuration(kpis.p95DurationMs)}
                hint={kpis.durationSampleSize > 0 ? `${kpis.durationSampleSize} 个样本` : '样本不足'}
              />
            </div>

            {/* ---- 趋势 ---- */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground">
                    运行趋势（按{overview.trendBucket === 'hour' ? '小时' : '天'}）
                  </h2>
                </div>
                {trendData.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">该时间范围内没有运行记录</p>
                ) : (
                  <div className="h-56" data-testid="trend-chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={trendData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" />
                        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" />
                        <RechartsTooltip
                          contentStyle={{
                            background: 'var(--color-card)',
                            border: '1px solid var(--color-border)',
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Bar dataKey="success" name="成功" stackId="s" fill="#16a34a" />
                        <Bar dataKey="failed" name="失败" stackId="s" fill="#ef4444" />
                        <Bar dataKey="running" name="运行中" stackId="s" fill="#0ea5e9" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ---- 来源分布（同时也是筛选器） ---- */}
            <Card>
              <CardContent className="p-4">
                <h2 className="text-sm font-semibold text-foreground mb-3">来源分布（点击筛选）</h2>
                <div className="flex flex-wrap gap-2" data-testid="source-chips">
                  {sourceChips.map((s) => {
                    const on = sources.includes(s.source);
                    return (
                      <button
                        key={s.source}
                        type="button"
                        onClick={() => toggleSource(s.source)}
                        className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                          on
                            ? 'border-primary bg-primary/10 text-primary'
                            : s.total === 0
                              ? 'border-border bg-card text-muted-foreground hover:bg-muted'
                              : 'border-border bg-card text-foreground hover:bg-muted'
                        }`}
                      >
                        {s.sourceLabel}
                        <span className="ml-2 tabular-nums text-muted-foreground">{s.total}</span>
                        {s.failed > 0 && <span className="ml-2 text-error">{s.failed} 失败</span>}
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* ---- 工作区 / Agent 分布：回答"哪些 Agent 在跑、跑得怎么样" ---- */}
            <Card>
              <CardContent className="p-4">
                <h2 className="text-sm font-semibold text-foreground mb-3">工作区 / Agent 分布</h2>
                {overview.byWorkspace.length === 0 ? (
                  <span className="text-sm text-muted-foreground">该时间范围内没有运行记录</span>
                ) : (
                  <div className="space-y-1.5" data-testid="workspace-breakdown">
                    {overview.byWorkspace.map((w) => (
                      <div
                        key={w.workspace}
                        data-testid="workspace-row"
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2 text-sm"
                      >
                        {/* 展示名不保证唯一：两个 Agent 可以重名（agent_definitions
                            对 name 无唯一约束），两个工作区也可能同名。分组键才是身份，
                            所以用 title 把原始键挂出来，重名行至少可区分。 */}
                        {/* 展示名不保证唯一：两个 Agent 可以重名（agent_definitions
                            对 name 无唯一约束），两个工作区也可能同名。分组键才是身份，
                            所以用 title 把原始键挂出来，重名行至少可区分。 */}
                        <span
                          className="font-medium text-foreground truncate max-w-[16rem]"
                          title={w.workspace}
                        >
                          {w.workspaceLabel}
                        </span>
                        <span className="tabular-nums text-muted-foreground">{w.total} 次</span>
                        {w.running > 0 && (
                          <span className="tabular-nums text-info">{w.running} 运行中</span>
                        )}
                        {w.failed > 0 && (
                          <span className="tabular-nums text-error">{w.failed} 失败</span>
                        )}
                        <span className="ml-auto tabular-nums text-muted-foreground">
                          {formatTokens(w.tokens)} tokens · {formatCost(w.costUsd)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ---- 运行列表 ---- */}
            <Card>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <h2 className="text-sm font-semibold text-foreground">运行列表</h2>
                  <span className="text-xs text-muted-foreground">共 {total} 条</span>
                  <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="搜索标题 / 工作区"
                    className="ml-auto w-full sm:w-56 h-8"
                    aria-label="搜索"
                  />
                  <button
                    type="button"
                    onClick={() => setStaleOnly((v) => !v)}
                    className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                      staleOnly ? 'border-warning bg-warning-bg text-warning' : 'border-border bg-card text-foreground hover:bg-muted'
                    }`}
                  >
                    只看疑似卡住
                  </button>
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => toggleStatus(s.value)}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                        statuses.includes(s.value)
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-card text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="runs-table">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b border-border">
                        <th className="py-2 pr-3 font-medium">状态</th>
                        <th className="py-2 pr-3 font-medium">来源</th>
                        <th className="py-2 pr-3 font-medium">标题</th>
                        <th className="py-2 pr-3 font-medium hidden md:table-cell">工作区</th>
                        <th className="py-2 pr-3 font-medium hidden lg:table-cell">归属</th>
                        <th className="py-2 pr-3 font-medium text-right">耗时</th>
                        <th className="py-2 pr-3 font-medium text-right hidden lg:table-cell">Token</th>
                        <th className="py-2 pr-3 font-medium text-right hidden xl:table-cell">成本</th>
                        <th className="py-2 font-medium text-right whitespace-nowrap">开始时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => {
                        const badge = resolveStatusBadge(r.status, r.stale);
                        return (
                          <tr
                            key={r.runId}
                            className="border-b border-border/60 hover:bg-muted/50 cursor-pointer"
                            onClick={() => void loadDetail(r.runId)}
                            data-testid="run-row"
                          >
                            <td className="py-2 pr-3">
                              <Badge variant={badge.tone}>{badge.label}</Badge>
                            </td>
                            <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{r.sourceLabel}</td>
                            <td className="py-2 pr-3 max-w-[22rem]">
                              <div className="truncate text-foreground" title={r.title}>{r.title}</div>
                              {r.error && (
                                <div className="truncate text-xs text-error" title={r.error}>{r.error}</div>
                              )}
                            </td>
                            <td className="py-2 pr-3 hidden md:table-cell text-muted-foreground truncate max-w-[10rem]">
                              {r.workspaceLabel}
                            </td>
                            <td className="py-2 pr-3 hidden lg:table-cell text-muted-foreground truncate max-w-[8rem]">
                              {r.ownerUsername ?? '—'}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                              {formatDuration(r.durationMs)}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground hidden lg:table-cell">
                              {formatTokens(r.inputTokens + r.outputTokens)}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground hidden xl:table-cell">
                              {formatCost(r.costUsd)}
                            </td>
                            <td className="py-2 text-right whitespace-nowrap text-muted-foreground">
                              {formatRelative(r.startedAt)}
                            </td>
                          </tr>
                        );
                      })}
                      {runs.length === 0 && !loading && (
                        <tr>
                          <td colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                            没有符合条件的运行记录
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-end gap-2 mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 0}
                      onClick={() => {
                        const p = Math.max(0, page - 1);
                        setPage(p);
                        void reload(p * PAGE_SIZE);
                      }}
                    >
                      上一页
                    </Button>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {page + 1} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page + 1 >= totalPages}
                      onClick={() => {
                        const p = page + 1;
                        setPage(p);
                        void reload(p * PAGE_SIZE);
                      }}
                    >
                      下一页
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        <RunDetailPanel />
      </div>
    </div>
  );
}
