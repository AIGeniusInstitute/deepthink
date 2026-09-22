/**
 * PipelinePanel — right-side panel showing pipeline run nodes in a vertical timeline.
 */
import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Play, Loader2, CheckCircle2, XCircle, Circle } from 'lucide-react';
import { useAgentGroupStore } from '@/stores/agent-group';

export function PipelinePanel({ groupJid, onNodeClick }: { groupJid: string; onNodeClick: (nodeId: string) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const currentRun = useAgentGroupStore(s => s.currentRun);
  const nodes = useAgentGroupStore(s => s.nodes);
  const startRun = useAgentGroupStore(s => s.startRun);
  const fetchRunNodes = useAgentGroupStore(s => s.fetchRunNodes);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    if (currentRun?.id && currentRun.status === 'running') {
      timer = setInterval(() => fetchRunNodes(currentRun.id), 3000);
    }
    return () => { if (timer) clearInterval(timer); };
  }, [currentRun?.id, currentRun?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStart = async () => {
    setStarting(true);
    await startRun(groupJid);
    setStarting(false);
  };

  const statusIcon = (status: string) => {
    const s = (status ?? '').toLowerCase();
    switch (s) {
      case 'running': return <Loader2 className="size-3.5 animate-spin text-blue-500" />;
      case 'completed':
      case 'success': return <CheckCircle2 className="size-3.5 text-green-500" />;
      case 'failed': return <XCircle className="size-3.5 text-red-500" />;
      default: return <Circle className="size-3.5 text-gray-400" />;
    }
  };

  const nodeTitle = (node: typeof nodes[0]): string => {
    const nt = node.node_type || node.nodeType || '';
    const seatLabel = (() => {
      try {
        const s = typeof node.input_summary === 'string' ? JSON.parse(node.input_summary) : null;
        return s?.agentDefId ?? s?.seatId ?? '';
      } catch { return ''; }
    })();
    const typeLabel = nt === 'agent' ? '🤖 Agent' : nt;
    return seatLabel ? `${typeLabel} · ${seatLabel}` : typeLabel || node.id.slice(0, 8);
  };

  return (
    <div className={`h-full border-l border-border bg-card flex flex-col transition-all ${collapsed ? 'w-10' : 'w-72'}`}>
      {/* header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        {!collapsed && <span className="text-xs font-semibold text-foreground">Pipeline</span>}
        <button onClick={() => setCollapsed(v => !v)} className="size-6 rounded flex items-center justify-center hover:bg-muted">
          {collapsed ? <ChevronLeft className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      </div>

      {collapsed ? null : (
        <>
          {/* controls */}
          <div className="px-3 py-2 border-b border-border shrink-0">
            <button
              onClick={() => void handleStart()}
              disabled={starting || currentRun?.status === 'running'}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
            >
              {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {currentRun ? '重新运行' : '启动 Pipeline'}
            </button>
            {currentRun && (
              <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className={`px-1.5 py-0.5 rounded-full ${currentRun.status === 'running' ? 'bg-blue-100 text-blue-700' : currentRun.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                  {currentRun.status}
                </span>
                <span>{currentRun.id.slice(0, 8)}</span>
              </div>
            )}
          </div>

          {/* nodes */}
          <div className="flex-1 overflow-y-auto py-2">
            {nodes.length === 0 && currentRun && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {currentRun.status === 'running' ? '等待节点启动...' : '暂无节点数据'}
              </div>
            )}
            {nodes.map((node, i) => (
              <div key={node.id}>
                <button
                  onClick={() => onNodeClick(node.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 text-left"
                >
                  <span className="text-[10px] text-muted-foreground w-5">{i + 1}</span>
                  {statusIcon(node.status)}
                  <span className="text-xs text-foreground truncate flex-1">{nodeTitle(node)}</span>
                  {(node.input_tokens || node.output_tokens) ? (
                    <span className="text-[10px] text-muted-foreground">
                      {Number(node.input_tokens || 0) + Number(node.output_tokens || 0)} tok
                    </span>
                  ) : null}
                </button>
                {i < nodes.length - 1 && <div className="w-px h-3 bg-border ml-[21px]" />}
              </div>
            ))}
            {nodes.length === 0 && !currentRun && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">点击"启动 Pipeline"开始运行</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}