import { useEffect, useState } from 'react';
import {
  cancelLoop,
  fetchLoopDetail,
  fetchLoopTraceTree,
  useLoopsStore,
  type LoopIteration,
  type LoopRun,
  type LoopTraceNode,
} from '../stores/loops';
import { LoopDagPanel } from '../components/loops/LoopDagPanel';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  running: 'bg-blue-100 text-blue-700',
  reviewing: 'bg-yellow-100 text-yellow-700',
  iterating: 'bg-purple-100 text-purple-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

const KIND_LABELS: Record<string, string> = {
  goal: '🎯 目标循环',
  loop: '🔄 时间循环',
  schedule: '📅 定时循环',
  proactive: '🤖 主动循环',
};

export function LoopsPage() {
  const { loops, loading, error, fetchLoops, filterStatus, filterKind, setFilter } = useLoopsStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    fetchLoops();
    const interval = setInterval(fetchLoops, 10_000);
    return () => clearInterval(interval);
  }, [filterStatus, filterKind]);

  return (
    <div className="flex h-full">
      <div className="w-2/3 border-r overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">Loop Engineering</h1>
          <div className="flex gap-2 text-sm">
            <select
              value={filterStatus}
              onChange={(e) => setFilter(e.target.value, filterKind)}
              className="border rounded px-2 py-1"
            >
              <option value="">全部状态</option>
              <option value="running">运行中</option>
              <option value="completed">已完成</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
            </select>
            <select
              value={filterKind}
              onChange={(e) => setFilter(filterStatus, e.target.value)}
              className="border rounded px-2 py-1"
            >
              <option value="">全部类型</option>
              <option value="goal">🎯 目标</option>
              <option value="loop">🔄 时间</option>
              <option value="schedule">📅 定时</option>
              <option value="proactive">🤖 主动</option>
            </select>
          </div>
        </div>

        {loading && loops.length === 0 && <div className="text-gray-500">加载中…</div>}
        {error && <div className="text-red-600">错误：{error}</div>}
        {!loading && loops.length === 0 && (
          <div className="text-gray-500">
            <p>暂无循环记录。</p>
            <p className="mt-2 text-sm">
              使用斜杠命令发起：
            </p>
            <ul className="mt-1 text-sm text-gray-600 space-y-1">
              <li><code className="bg-gray-100 px-1">/goal 修复 README 错字 max_turns=5</code></li>
              <li><code className="bg-gray-100 px-1">/loop 5m 检查 CI 失败</code></li>
              <li><code className="bg-gray-100 px-1">/schedule 0 9 * * * 每日早报</code></li>
              <li><code className="bg-gray-100 px-1">/proactive 0 * * * * 处理反馈 workflow=parallel</code></li>
            </ul>
          </div>
        )}

        <div className="space-y-2">
          {loops.map((loop) => (
            <LoopCard
              key={loop.id}
              loop={loop}
              selected={selectedId === loop.id}
              onSelect={() => setSelectedId(loop.id)}
              onCancel={async () => {
                if (confirm(`取消循环 ${loop.id.slice(0, 12)}…？`)) {
                  await cancelLoop(loop.id);
                  fetchLoops();
                }
              }}
            />
          ))}
        </div>
      </div>

      <div className="w-1/3 overflow-y-auto p-4">
        {selectedId ? (
          <LoopDetailPanel loopId={selectedId} />
        ) : (
          <div className="text-gray-400">← 选择一个循环查看 DAG 与 Trace</div>
        )}
      </div>
    </div>
  );
}

function LoopCard({
  loop,
  selected,
  onSelect,
  onCancel,
}: {
  loop: LoopRun;
  selected: boolean;
  onSelect: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`border rounded p-3 cursor-pointer hover:bg-gray-50 ${
        selected ? 'ring-2 ring-blue-400' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">{KIND_LABELS[loop.kind] ?? loop.kind}</span>
          <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLORS[loop.status] ?? 'bg-gray-100'}`}>
            {loop.status}
          </span>
        </div>
        <div className="text-xs text-gray-500">
          {loop.current_turn}/{loop.max_turns} 轮
        </div>
      </div>
      <div className="mt-2 text-sm text-gray-700 line-clamp-2">{loop.goal_text}</div>
      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
        <span>
          Token: {(loop.total_input_tokens + loop.total_output_tokens).toLocaleString()} · $
          {loop.total_cost_usd.toFixed(4)}
        </span>
        <div className="flex items-center gap-2">
          <span>{new Date(loop.started_at).toLocaleString()}</span>
          {(loop.status === 'running' || loop.status === 'reviewing' || loop.status === 'iterating' || loop.status === 'pending') && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              className="text-red-600 hover:underline"
            >
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function LoopDetailPanel({ loopId }: { loopId: string }) {
  const [loop, setLoop] = useState<LoopRun | null>(null);
  const [iterations, setIterations] = useState<LoopIteration[]>([]);
  const [traceRoots, setTraceRoots] = useState<LoopTraceNode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [detail, trace] = await Promise.all([
          fetchLoopDetail(loopId),
          fetchLoopTraceTree(loopId),
        ]);
        if (cancelled) return;
        setLoop(detail.loop);
        setIterations(detail.iterations);
        setTraceRoots(trace.roots);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loopId]);

  if (loading && !loop) return <div className="text-gray-500">加载中…</div>;
  if (!loop) return <div className="text-red-600">循环不存在</div>;

  return (
    <div>
      <h2 className="text-lg font-bold mb-2">{KIND_LABELS[loop.kind]}</h2>
      <div className="text-sm text-gray-700 mb-4">{loop.goal_text}</div>
      <div className="text-xs text-gray-500 mb-4">
        ID: <code className="bg-gray-100 px-1">{loop.id}</code>
      </div>

      <div className="mb-4">
        <h3 className="font-medium mb-2">迭代列表</h3>
        <div className="space-y-1">
          {iterations.map((it) => (
            <div key={it.id} className="text-xs border rounded p-2">
              <div className="flex justify-between">
                <span>Turn {it.turn_index + 1}</span>
                <span className="text-gray-500">
                  {it.input_tokens + it.output_tokens} tokens · ${it.cost_usd.toFixed(4)}
                </span>
              </div>
              {it.review_result && (
                <div className="mt-1">
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      it.review_result === 'pass'
                        ? 'bg-green-100 text-green-700'
                        : it.review_result === 'fail'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-yellow-100 text-yellow-700'
                    }`}
                  >
                    {it.review_result}
                  </span>
                  {it.review_reason && (
                    <span className="ml-2 text-gray-600">{it.review_reason.slice(0, 80)}</span>
                  )}
                </div>
              )}
            </div>
          ))}
          {iterations.length === 0 && <div className="text-gray-400 text-xs">暂无迭代</div>}
        </div>
      </div>

      <div>
        <h3 className="font-medium mb-2">执行 DAG</h3>
        <LoopDagPanel roots={traceRoots} />
      </div>
    </div>
  );
}
