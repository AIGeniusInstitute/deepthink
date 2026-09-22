/**
 * TraceDetail — drawer showing trace events for a selected pipeline node.
 * Backend returns { node, traceNodes, toolCalls } from /node-runs/:id/trace.
 */
import { useEffect } from 'react';
import { X, Loader2, Wrench, Activity } from 'lucide-react';
import { useAgentGroupStore } from '@/stores/agent-group';
import type { PipelineNode } from '@/api/agent-groups';

function statusBadge(status: string | null | undefined) {
  const s = (status ?? '').toLowerCase();
  const colors: Record<string, string> = {
    running: 'bg-blue-100 text-blue-700', completed: 'bg-green-100 text-green-700',
    success: 'bg-green-100 text-green-700', failed: 'bg-red-100 text-red-700',
    pending: 'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${colors[s] || 'bg-gray-100 text-gray-600'}`}>
      {status || 'unknown'}
    </span>
  );
}

export function TraceDetail({ node, onClose }: { node: PipelineNode | null; onClose: () => void }) {
  const traceData = useAgentGroupStore(s => s.traceData);
  const traceLoading = useAgentGroupStore(s => s.traceLoading);
  const fetchNodeTrace = useAgentGroupStore(s => s.fetchNodeTrace);

  useEffect(() => {
    if (node?.id) { void fetchNodeTrace(node.id); }
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) return null;

  const traceNodes = traceData?.traceNodes ?? [];
  const toolCalls = traceData?.toolCalls ?? [];
  const hasData = traceNodes.length > 0 || toolCalls.length > 0;

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-background border-l border-border shadow-xl z-50 flex flex-col">
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {node.node_type || '节点详情'}
            </h2>
            <p className="text-[10px] text-muted-foreground">ID: {node.id.slice(0, 16)}</p>
          </div>
          <button onClick={onClose} className="size-7 rounded-md flex items-center justify-center hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        {/* overview */}
        <div className="px-4 py-3 border-b border-border shrink-0">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-muted-foreground">状态: </span>{statusBadge(node.status)}</div>
            <div><span className="text-muted-foreground">类型: </span>
              <span className="text-foreground">{node.node_type || node.nodeType || '-'}</span>
            </div>
            <div><span className="text-muted-foreground">Tokens: </span>
              <span className="text-foreground">
                {Number(node.input_tokens || 0) + Number(node.output_tokens || 0)}
              </span>
            </div>
            <div><span className="text-muted-foreground">Cost: </span>
              <span className="text-foreground">${Number(node.cost_usd || 0).toFixed(4)}</span>
            </div>
          </div>
          {node.input_summary && (
            <details className="mt-2">
              <summary className="text-xs text-muted-foreground cursor-pointer">Input Summary</summary>
              <pre className="mt-1 text-[10px] bg-muted p-2 rounded max-h-32 overflow-auto whitespace-pre-wrap break-all">
                {(() => { try { return JSON.stringify(JSON.parse(node.input_summary), null, 2); } catch { return node.input_summary; } })()}
              </pre>
            </details>
          )}
        </div>

        {/* trace content */}
        <div className="flex-1 overflow-y-auto">
          {traceLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !hasData ? (
            <div className="px-4 py-12 text-center text-xs text-muted-foreground">
              暂无 Trace 详情
            </div>
          ) : (
            <>
              {/* Tool Calls */}
              {toolCalls.length > 0 && (
                <>
                  <div className="px-4 py-2 border-b border-border sticky top-0 bg-background z-10">
                    <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <Wrench className="size-3" /> Tool Calls ({toolCalls.length})
                    </h3>
                  </div>
                  {toolCalls.map((tc) => (
                    <div key={tc.id} className="px-4 py-2.5 border-b border-border/50 hover:bg-muted/30">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-foreground">{tc.tool_name}</span>
                        {statusBadge(tc.status)}
                      </div>
                      {tc.input_json && (
                        <details className="mt-1">
                          <summary className="text-[10px] text-muted-foreground cursor-pointer">Input</summary>
                          <pre className="mt-1 text-[10px] bg-muted p-1.5 rounded max-h-24 overflow-auto whitespace-pre-wrap break-all">
                            {(() => { try { return JSON.stringify(JSON.parse(tc.input_json), null, 2); } catch { return tc.input_json; } })()}
                          </pre>
                        </details>
                      )}
                      {tc.output_ref && (
                        <div className="mt-1 text-[10px] text-muted-foreground truncate">
                          Output: {tc.output_ref.slice(0, 100)}
                        </div>
                      )}
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {tc.started_at ? new Date(tc.started_at).toLocaleTimeString() : ''}
                        {tc.ended_at ? ` → ${new Date(tc.ended_at).toLocaleTimeString()}` : ''}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {/* Trace Nodes */}
              {traceNodes.length > 0 && (
                <>
                  <div className="px-4 py-2 border-b border-border sticky top-0 bg-background z-10">
                    <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <Activity className="size-3" /> Trace Nodes ({traceNodes.length})
                    </h3>
                  </div>
                  {traceNodes.map((tn) => (
                    <div key={tn.id} className="px-4 py-2.5 border-b border-border/50 hover:bg-muted/30">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[10px] px-1 py-0.5 rounded bg-accent text-foreground font-mono">
                          {tn.node_type}
                        </span>
                        {tn.tool_name && (
                          <span className="text-xs text-foreground">{tn.tool_name}</span>
                        )}
                        {statusBadge(tn.status)}
                      </div>
                      {tn.title && (
                        <p className="text-xs text-foreground mb-0.5">{tn.title}</p>
                      )}
                      {tn.output_summary && (
                        <p className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words">
                          {tn.output_summary.slice(0, 500)}
                        </p>
                      )}
                      <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span>{tn.started_at ? new Date(tn.started_at).toLocaleTimeString() : ''}</span>
                        <span>{tn.tokens} tok</span>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}