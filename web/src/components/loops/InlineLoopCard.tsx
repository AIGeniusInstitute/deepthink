import { useEffect, useState, useCallback } from 'react';
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import {
  cancelLoop,
  fetchLoopDetail,
  fetchLoopTraceTree,
  type LoopRun,
  type LoopIteration,
  type LoopTraceNode,
} from '../../stores/loops';
import { LoopDagPanel } from './LoopDagPanel';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  running: 'bg-blue-100 text-blue-700 animate-pulse',
  reviewing: 'bg-yellow-100 text-yellow-700',
  iterating: 'bg-purple-100 text-purple-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const KIND_EMOJI: Record<string, string> = {
  goal: '🎯',
  loop: '🔄',
  schedule: '📅',
  proactive: '🤖',
  adaptive: '🧬',
  skill_evolution: '🧪',
};

function isActive(s: string): boolean {
  return s === 'pending' || s === 'running' || s === 'reviewing' || s === 'iterating';
}

export function InlineLoopCard({ loopRunId }: { loopRunId: string }) {
  const [loop, setLoop] = useState<LoopRun | null>(null);
  const [iterations, setIterations] = useState<LoopIteration[]>([]);
  const [traceRoots, setTraceRoots] = useState<LoopTraceNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  const load = useCallback(async () => {
    try {
      const [detail, trace] = await Promise.all([
        fetchLoopDetail(loopRunId),
        fetchLoopTraceTree(loopRunId),
      ]);
      setLoop(detail.loop);
      setIterations(detail.iterations);
      setTraceRoots(trace.roots);
    } catch {
      // loop may not exist yet (race with DB write) — keep loading
    } finally {
      setLoading(false);
    }
  }, [loopRunId]);

  useEffect(() => {
    load();
    const active = loop ? isActive(loop.status) : true;
    const interval = setInterval(load, active ? 5000 : 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopRunId, loop?.status]);

  if (loading && !loop) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-3">
        <Loader2 className="w-4 h-4 animate-spin" />
        加载循环 {loopRunId.slice(0, 12)}…
      </div>
    );
  }
  if (!loop) {
    return (
      <div className="text-sm text-muted-foreground p-3">
        循环 {loopRunId.slice(0, 12)} 不存在或已被清理
      </div>
    );
  }

  const active = isActive(loop.status);
  const totalTokens = loop.total_input_tokens + loop.total_output_tokens;

  return (
    <div className="border border-border rounded-xl bg-surface shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <span className="text-base">{KIND_EMOJI[loop.kind] ?? '🔁'}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{loop.goal_text}</div>
          <div className="text-[11px] text-muted-foreground">
            {loop.kind} · {loop.current_turn}/{loop.max_turns} 轮
          </div>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded ${STATUS_COLORS[loop.status] ?? 'bg-gray-100'}`}>
          {loop.status}
        </span>
        {active && (
          <button
            onClick={async () => {
              if (confirm(`取消循环 ${loopRunId.slice(0, 12)}？`)) {
                await cancelLoop(loopRunId);
                load();
              }
            }}
            className="text-[11px] text-red-600 hover:underline px-2 py-0.5"
          >
            取消
          </button>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground p-1"
          title={expanded ? '收起' : '展开'}
        >
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {expanded && (
        <>
          {/* DAG */}
          <div className="px-3 py-2 border-b border-border">
            {traceRoots.length > 0 ? (
              <LoopDagPanel roots={traceRoots} loopId={loopRunId} loopStatus={loop.status} />
            ) : (
              <div className="text-xs text-muted-foreground">
                {active ? '等待 trace 节点…' : '无 trace 节点'}
              </div>
            )}
          </div>

          {/* Iterations summary */}
          {iterations.length > 0 && (
            <div className="px-3 py-2 border-b border-border">
              <div className="text-[11px] font-medium text-muted-foreground mb-1">迭代</div>
              <div className="flex flex-wrap gap-1">
                {iterations.map((it) => (
                  <span
                    key={it.id}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      it.review_result === 'pass'
                        ? 'bg-green-50 border-green-300 text-green-700'
                        : it.review_result === 'fail'
                          ? 'bg-red-50 border-red-300 text-red-700'
                          : it.status === 'running'
                            ? 'bg-blue-50 border-blue-300 text-blue-700 animate-pulse'
                            : 'bg-gray-50 border-gray-300 text-gray-600'
                    }`}
                    title={it.review_reason ?? it.status}
                  >
                    T{it.turn_index + 1}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="px-3 py-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {totalTokens.toLocaleString()} tok · ${loop.total_cost_usd.toFixed(4)}
            </span>
            <span>{new Date(loop.started_at).toLocaleString()}</span>
          </div>
        </>
      )}
    </div>
  );
}
