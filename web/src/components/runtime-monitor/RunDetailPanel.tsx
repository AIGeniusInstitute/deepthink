import { useEffect, useState } from 'react';
import { X, Loader2, AlertCircle, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useRuntimeMonitorStore, type TraceItem } from '../../stores/runtime-monitor';
import {
  formatAbsolute,
  formatCost,
  formatDuration,
  formatTokens,
  nodeColor,
  resolveStatusBadge,
  sourceHint,
} from './format';

/** 一步轨迹的耗时条宽度：相对整条运行的总时长，最短 2% 以免零耗时步看不见。 */
function barWidth(item: TraceItem, totalMs: number | null): string {
  const d = item.durationMs ?? 0;
  if (!totalMs || totalMs <= 0) return '100%';
  return `${Math.max(2, Math.min(100, (d / totalMs) * 100))}%`;
}

function TraceRow({
  item,
  totalMs,
  expanded,
}: {
  item: TraceItem;
  totalMs: number | null;
  /** 展开态下不再钳制行数，入参/出参照原样铺开。 */
  expanded: boolean;
}) {
  const clamp = expanded ? '' : ' line-clamp-3';
  return (
    <div className="py-2 border-b border-border last:border-0" data-testid="trace-row">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="shrink-0 w-2.5 h-2.5 rounded-full"
          style={{ backgroundColor: nodeColor(item.nodeType) }}
        />
        <span className="text-xs font-mono text-muted-foreground shrink-0">{item.nodeType}</span>
        <span className="text-sm text-foreground truncate">{item.title || item.toolName || '—'}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(item.durationMs)}
        </span>
        {item.tokens > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatTokens(item.tokens)} tok
          </span>
        )}
        {item.status && item.status !== 'done' && item.status !== 'success' && (
          <Badge variant={item.status === 'failed' ? 'error' : 'neutral'}>{item.status}</Badge>
        )}
      </div>
      <div className="mt-1 ml-4.5 h-1 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: barWidth(item, totalMs), backgroundColor: nodeColor(item.nodeType) }}
        />
      </div>
      {item.inputSummary && (
        <div
          data-testid="trace-input"
          className={`mt-1 ml-4.5 text-xs text-muted-foreground whitespace-pre-wrap break-words${clamp}`}
        >
          <span className="text-muted-foreground/70">入参 </span>
          {item.inputSummary}
        </div>
      )}
      {item.outputSummary && (
        <div
          data-testid="trace-output"
          className={`mt-0.5 ml-4.5 text-xs text-muted-foreground whitespace-pre-wrap break-words${clamp}`}
        >
          <span className="text-muted-foreground/70">出参 </span>
          {item.outputSummary}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground truncate">{value}</div>
    </div>
  );
}

export function RunDetailPanel() {
  const detail = useRuntimeMonitorStore((s) => s.detail);
  const loading = useRuntimeMonitorStore((s) => s.detailLoading);
  const clearDetail = useRuntimeMonitorStore((s) => s.clearDetail);

  // 记的是「哪条运行被展开了」而不是一个裸 boolean：换一条运行天然回到紧凑视图，
  // 不需要额外的 effect 去重置（也就不会有一帧残留的展开态）。
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearDetail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearDetail]);

  const open = loading || detail !== null;
  if (!open) return null;

  const run = detail?.run;
  const badge = run ? resolveStatusBadge(run.status, run.stale) : null;
  const expanded = detail !== null && expandedRunId === detail.run.runId;
  // task / sandbox / harness-eval 是原子运行记录，入参出参都为空 —— 展开它们不会有
  // 任何变化，索性不给一个点了没反应的按钮。
  const expandable = detail !== null && detail.trace.some((t) => t.inputSummary || t.outputSummary);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-label="运行详情"
      data-testid="run-detail-panel"
    >
      <div className="absolute inset-0 bg-black/40" onClick={clearDetail} />
      <div className="relative w-full max-w-2xl h-full bg-background border-l border-border overflow-y-auto">
        <div className="sticky top-0 bg-background border-b border-border px-4 py-3 flex items-center gap-3">
          <h2 className="text-base font-semibold text-foreground truncate">运行详情</h2>
          {run && <span className="text-xs font-mono text-muted-foreground truncate">{run.runId}</span>}
          <Button variant="ghost" size="sm" className="ml-auto shrink-0" onClick={clearDetail}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
          </div>
        )}

        {run && (
          <div className="p-4 space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              {badge && <Badge variant={badge.tone}>{badge.label}</Badge>}
              <Badge variant="outline">{run.sourceLabel}</Badge>
              {run.rawStatus !== run.status && (
                <span className="text-xs text-muted-foreground">原始状态 {run.rawStatus}</span>
              )}
            </div>

            <p className="text-sm text-foreground break-words">{run.title}</p>
            <p className="text-xs text-muted-foreground">{sourceHint(run.source)}</p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Field label="工作区" value={run.workspaceLabel} />
              <Field label="归属用户" value={run.ownerUsername ?? '—'} />
              <Field label="Agent" value={run.agentName ?? run.agentId ?? '—'} />
              <Field label="开始" value={formatAbsolute(run.startedAt)} />
              <Field label="结束" value={run.endedAt ? formatAbsolute(run.endedAt) : '未结束'} />
              <Field label="耗时" value={formatDuration(run.durationMs)} />
              <Field
                label="Token"
                value={`${formatTokens(run.inputTokens)} 入 / ${formatTokens(run.outputTokens)} 出`}
              />
              <Field label="成本" value={formatCost(run.costUsd)} />
            </div>

            {run.error && (
              <div className="flex gap-2 p-3 rounded-lg bg-error-bg text-error text-sm">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="break-words">{run.error}</span>
              </div>
            )}

            <div>
              <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
                运行轨迹
                {detail.trace.length > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {detail.trace.length} 步
                  </span>
                )}
                {expandable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    data-testid="trace-expand-toggle"
                    onClick={() => setExpandedRunId(expanded ? null : detail.run.runId)}
                  >
                    {expanded ? (
                      <ChevronsDownUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronsUpDown className="w-3.5 h-3.5" />
                    )}
                    {expanded ? '收起' : '展开完整轨迹'}
                  </Button>
                )}
              </h3>
              {detail.trace.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3">
                  {detail.traceNote ?? '这条运行没有可展示的分步轨迹。'}
                </p>
              ) : (
                <div data-testid="trace-list">
                  {detail.trace.map((item) => (
                    <TraceRow
                      key={item.spanId}
                      item={item}
                      totalMs={run.durationMs}
                      expanded={expanded}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
