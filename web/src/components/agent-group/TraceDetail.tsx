/**
 * TraceDetail — drawer showing trace events for a selected pipeline node.
 */
import { useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useAgentGroupStore } from '@/stores/agent-group';
import type { PipelineNode } from '@/api/agent-groups';

export function TraceDetail({ node, onClose }: { node: PipelineNode | null; onClose: () => void }) {
  const traceData = useAgentGroupStore(s => s.traceData);
  const traceLoading = useAgentGroupStore(s => s.traceLoading);
  const fetchNodeTrace = useAgentGroupStore(s => s.fetchNodeTrace);

  useEffect(() => {
    if (node?.id) { void fetchNodeTrace(node.id); }
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-background border-l border-border shadow-xl z-50 flex flex-col">
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{node.title || '节点详情'}</h2>
            <p className="text-[10px] text-muted-foreground">ID: {node.id.slice(0, 12)}</p>
          </div>
          <button onClick={onClose} className="size-7 rounded-md flex items-center justify-center hover:bg-muted"><X className="size-4" /></button>
        </div>

        {/* overview */}
        <div className="px-4 py-3 border-b border-border shrink-0">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-muted-foreground">状态: </span><span className="text-foreground">{node.status}</span></div>
            <div><span className="text-muted-foreground">类型: </span><span className="text-foreground">{node.nodeType || '-'}</span></div>
          </div>
        </div>

        {/* events */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-2 border-b border-border"><h3 className="text-xs font-semibold text-foreground">Trace Events</h3></div>
          {traceLoading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
          ) : traceData?.events?.length ? (
            traceData.events.map((evt, i) => (
              <div key={evt.id || i} className="px-4 py-2 border-b border-border/50 hover:bg-muted/30">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[10px] px-1 py-0.5 rounded bg-accent text-foreground font-mono">{evt.eventType}</span>
                  <span className="text-[10px] text-muted-foreground">{evt.createdAt ? new Date(evt.createdAt).toLocaleTimeString() : ''}</span>
                </div>
                <p className="text-xs text-foreground whitespace-pre-wrap break-words">{evt.content?.slice(0, 500)}</p>
              </div>
            ))
          ) : (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">暂无 Trace 事件</div>
          )}
        </div>
      </div>
    </>
  );
}