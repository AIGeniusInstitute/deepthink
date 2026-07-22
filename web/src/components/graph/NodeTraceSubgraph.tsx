/**
 * Super Agent Team — node-internal sub-graph trace panel.
 *
 * Fetches GET /api/graph/runs/:id/nodes/:nodeId/trace and renders the agent
 * node's internal execution steps (turn/tool span tree, by parent_node_id)
 * + each tool call's raw input/output (collapsible). Lets the user drill into
 * a graph agent node to see exactly what it did, step by step, fully traceable.
 *
 * P0 renders a tree-style list (parent → children) rather than a second
 * reactflow canvas — simpler, and the trace is inherently a span tree.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '../../api/client';

interface TraceNode {
  id: number;
  node_type: string;
  parent_node_id: number | null;
  title: string | null;
  input_summary: string | null;
  output_summary: string | null;
  status: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  started_at: string | null;
}

interface ToolCall {
  tool_use_id: string;
  tool_name: string;
  input_json: string | null;
  output_json: string | null;
  status: string | null;
}

interface NodeTraceSubgraphProps {
  runId: string;
  nodeId: string;
}

export function NodeTraceSubgraph({ runId, nodeId }: NodeTraceSubgraphProps) {
  const [traceNodes, setTraceNodes] = useState<TraceNode[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch<{ traceNodes: TraceNode[]; toolCalls: ToolCall[] }>(
          `/api/graph/runs/${runId}/nodes/${nodeId}/trace`,
        );
        if (cancelled) return;
        setTraceNodes(data.traceNodes ?? []);
        setToolCalls(data.toolCalls ?? []);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    // Poll while the parent graph run is likely active (5s, same as graph store).
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, nodeId]);

  if (loading) {
    return <div className="text-xs text-muted-foreground p-2">加载节点内 trace…</div>;
  }
  if (error) {
    return <div className="text-xs text-red-600 p-2">trace 加载失败：{error}</div>;
  }
  if (traceNodes.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-2">
        暂无子步骤 trace（agent 节点尚未执行或未产生 trace）。
      </div>
    );
  }

  // Build a parent → children map for the span tree.
  const childrenOf = new Map<number | null, TraceNode[]>();
  for (const n of traceNodes) {
    const key = n.parent_node_id;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(n);
  }
  const toolCallByUseId = new Map(toolCalls.map((t) => [t.tool_use_id, t]));
  const roots = childrenOf.get(null) ?? [];

  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground mb-1">
        节点内子步骤（{traceNodes.length} 步 / {toolCalls.length} 工具调用）
      </div>
      {roots.map((n) => (
        <TraceNodeItem
          key={n.id}
          node={n}
          childrenOf={childrenOf}
          toolCallByUseId={toolCallByUseId}
        />
      ))}
    </div>
  );
}

function TraceNodeItem({
  node,
  childrenOf,
  toolCallByUseId,
}: {
  node: TraceNode;
  childrenOf: Map<number | null, TraceNode[]>;
  toolCallByUseId: Map<string, ToolCall>;
}) {
  const [open, setOpen] = useState(false);
  const children = childrenOf.get(node.id) ?? [];
  const toolCall = node.tool_use_id ? toolCallByUseId.get(node.tool_use_id) : undefined;
  const hasDetail = children.length > 0 || !!toolCall || !!node.output_summary;
  const statusColor =
    node.status === 'done' || node.status === 'completed'
      ? 'text-emerald-600'
      : node.status === 'failed'
        ? 'text-red-600'
        : node.status === 'running'
          ? 'text-amber-600'
          : 'text-muted-foreground';

  return (
    <div className="border-l border-border pl-2 ml-1">
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`flex items-center gap-1 text-xs w-full text-left py-0.5 ${hasDetail ? 'hover:bg-muted/40 rounded' : 'cursor-default'}`}
      >
        {hasDetail ? (
          open ? (
            <ChevronDown className="w-3 h-3 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0" />
          )
        ) : (
          <span className="w-3" />
        )}
        <span className={`font-mono ${statusColor}`}>●</span>
        <span className="text-foreground">{node.title || node.node_type}</span>
        <span className="text-[10px] text-muted-foreground uppercase">{node.node_type}</span>
        {node.tool_name && (
          <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground">
            {node.tool_name}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-4 space-y-1 mb-1">
          {node.input_summary && (
            <pre className="text-[10px] whitespace-pre-wrap break-all bg-muted/40 rounded p-1.5 max-h-32 overflow-y-auto">
              in: {node.input_summary}
            </pre>
          )}
          {node.output_summary && (
            <pre className="text-[10px] whitespace-pre-wrap break-all bg-muted/40 rounded p-1.5 max-h-32 overflow-y-auto">
              out: {node.output_summary}
            </pre>
          )}
          {toolCall && (
            <div className="space-y-1">
              {toolCall.input_json && (
                <pre className="text-[10px] whitespace-pre-wrap break-all bg-blue-50 text-blue-800 rounded p-1.5 max-h-40 overflow-y-auto">
                  工具入参: {toolCall.input_json}
                </pre>
              )}
              {toolCall.output_json && (
                <pre className="text-[10px] whitespace-pre-wrap break-all bg-emerald-50 text-emerald-800 rounded p-1.5 max-h-40 overflow-y-auto">
                  工具输出: {toolCall.output_json}
                </pre>
              )}
            </div>
          )}
          {children.map((c) => (
            <TraceNodeItem
              key={c.id}
              node={c}
              childrenOf={childrenOf}
              toolCallByUseId={toolCallByUseId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
