/**
 * Graph node detail panel — input/output/tokens/cost/error/attempt + rerun.
 *
 * Mirrors chat/DagNodeDetail.tsx but rerun calls the server-side resume
 * endpoint (real checkpoint rerun, AC4.4), not a client-side fake replay.
 */
import { useState } from 'react';
import { Play, RotateCcw } from 'lucide-react';
import { useGraphStore, type GraphNodeRun } from '../../stores/graph';
import { NodeTraceSubgraph } from './NodeTraceSubgraph';

interface GraphNodeDetailProps {
  runId: string;
  node: GraphNodeRun;
}

export function GraphNodeDetail({ runId, node }: GraphNodeDetailProps) {
  const rerunNode = useGraphStore((s) => s.rerunNode);
  const resumeRun = useGraphStore((s) => s.resumeRun);
  const [busy, setBusy] = useState(false);

  const handleRerun = async () => {
    setBusy(true);
    await rerunNode(runId, node.node_id);
    setBusy(false);
  };
  const handleResume = async () => {
    setBusy(true);
    await resumeRun(runId);
    setBusy(false);
  };

  const tokens = node.input_tokens + node.output_tokens;

  return (
    <div className="h-full overflow-y-auto p-4 text-sm space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-foreground">节点 {node.node_id}</h4>
        <span
          className="text-[10px] px-2 py-0.5 rounded uppercase"
          style={{
            backgroundColor: statusBg(node.status),
            color: '#1f2937',
          }}
        >
          {node.status}
        </span>
      </div>

      <Row label="类型" value={node.node_type} />
      <Row label="尝试" value={`#${node.attempt}`} />
      <Row label="幂等" value={node.is_idempotent ? '是' : '否'} />
      {node.started_at && <Row label="开始" value={fmt(node.started_at)} />}
      {node.ended_at && <Row label="结束" value={fmt(node.ended_at)} />}
      {tokens > 0 && <Row label="Tokens" value={String(tokens)} />}
      {node.cost_usd > 0 && (
        <Row label="成本" value={`$${node.cost_usd.toFixed(4)}`} />
      )}

      {node.input_summary && (
        <Section title="输入">
          <pre className="text-[11px] whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-40 overflow-y-auto">
            {node.input_summary}
          </pre>
        </Section>
      )}
      {node.output_summary && (
        <Section title="输出">
          <pre className="text-[11px] whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-40 overflow-y-auto">
            {node.output_summary}
          </pre>
        </Section>
      )}
      {node.error && (
        <Section title="错误">
          <pre className="text-[11px] whitespace-pre-wrap break-all bg-red-50 text-red-700 rounded p-2 max-h-40 overflow-y-auto">
            {node.error}
          </pre>
        </Section>
      )}

      {node.node_type === 'agent' && (
        <Section title="节点内子步骤 trace（Super Agent Team）">
          <NodeTraceSubgraph runId={runId} nodeId={node.node_id} />
        </Section>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={handleRerun}
          disabled={busy}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
        >
          <RotateCcw className="w-3 h-3" /> 重跑节点
        </button>
        <button
          onClick={handleResume}
          disabled={busy}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
        >
          <Play className="w-3 h-3" /> 续跑
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-mono text-xs">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{title}</div>
      {children}
    </div>
  );
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusBg(status: string): string {
  switch (status) {
    case 'running':
      return '#fef3c7';
    case 'completed':
      return '#d1fae5';
    case 'failed':
      return '#fee2e2';
    case 'paused':
      return '#fef9c3';
    default:
      return '#e5e7eb';
  }
}
