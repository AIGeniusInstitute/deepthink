import { useEffect, useState } from 'react';
import { sandboxApi, type SandboxExecution } from '../../api/sandbox';

interface SandboxExecutionListProps {
  sessionId: string;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  completed: { label: '成功', color: 'text-green-400' },
  timeout: { label: '超时', color: 'text-yellow-400' },
  oom: { label: 'OOM', color: 'text-red-400' },
  killed: { label: '被杀', color: 'text-red-400' },
  error: { label: '错误', color: 'text-orange-400' },
};

export function SandboxExecutionList({ sessionId }: SandboxExecutionListProps) {
  const [executions, setExecutions] = useState<SandboxExecution[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await sandboxApi.listExecutions(sessionId);
      setExecutions(r.executions);
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [sessionId]);

  const toggleExpand = (exec: SandboxExecution) => {
    if (expandedId === exec.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(exec.id);
  };

  return (
    <div className="h-full flex flex-col bg-[#0f0f14]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1a1b26] border-b border-[#2a2b36] text-xs">
        <span className="text-neutral-400">执行历史</span>
        <button
          onClick={load}
          disabled={loading}
          className="text-neutral-500 hover:text-neutral-300 disabled:opacity-40"
        >
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-3 text-xs text-red-400">{error}</div>
        ) : executions.length === 0 ? (
          <div className="p-3 text-xs text-neutral-500">暂无执行记录</div>
        ) : (
          executions.map((exec) => {
            const st = STATUS_LABELS[exec.status] ?? { label: exec.status, color: 'text-neutral-400' };
            const isExpanded = expandedId === exec.id;
            return (
              <div key={exec.id} className="border-b border-[#1a1b26]">
                <button
                  onClick={() => toggleExpand(exec)}
                  className="w-full text-left px-3 py-2 hover:bg-white/5 flex items-center gap-2 text-xs"
                >
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                    exec.status === 'completed' ? 'bg-green-400' :
                    exec.status === 'timeout' ? 'bg-yellow-400' :
                    'bg-red-400'
                  }`} />
                  <span className={st.color}>{st.label}</span>
                  <span className="text-neutral-500">{exec.language}</span>
                  <span className="text-neutral-500 ml-auto">
                    {exec.duration_ms}ms
                  </span>
                  {exec.exit_code != null && exec.exit_code !== 0 && (
                    <span className="text-red-400">exit={exec.exit_code}</span>
                  )}
                  <span className="text-neutral-600">
                    {isExpanded ? '▲' : '▼'}
                  </span>
                </button>
                {isExpanded && (
                  <div className="px-3 pb-2 text-xs text-neutral-400 space-y-1">
                    <div>
                      <span className="text-neutral-500">状态: </span>
                      <span className={st.color}>{st.label}</span>
                      <span className="text-neutral-600 ml-2">
                        exit={exec.exit_code} | {exec.duration_ms}ms
                      </span>
                      {exec.truncated ? (
                        <span className="text-yellow-400 ml-2">输出已截断</span>
                      ) : null}
                    </div>
                    <div>
                      <span className="text-neutral-500">stdout: </span>
                      {exec.stdout_bytes} 字节
                    </div>
                    {exec.stderr_bytes > 0 && (
                      <div>
                        <span className="text-neutral-500">stderr: </span>
                        {exec.stderr_bytes} 字节
                      </div>
                    )}
                    <div className="text-neutral-600">
                      {new Date(exec.created_at).toLocaleString()}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}