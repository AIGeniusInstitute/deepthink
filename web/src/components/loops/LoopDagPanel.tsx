import { useState } from 'react';
import type { LoopTraceNode } from '../../stores/loops';
import { editTraceNode } from '../../stores/loops';

const NODE_COLORS: Record<string, string> = {
  turn: 'bg-blue-50 border-blue-300',
  tool: 'bg-gray-50 border-gray-300',
  review: 'bg-yellow-50 border-yellow-300',
  goal_check: 'bg-purple-50 border-purple-300',
  skill: 'bg-green-50 border-green-300',
  subagent: 'bg-indigo-50 border-indigo-300',
};

const STATUS_DOT: Record<string, string> = {
  running: 'bg-blue-500',
  completed: 'bg-green-500',
  pass: 'bg-green-500',
  failed: 'bg-red-500',
  fail: 'bg-red-500',
  needs_improvement: 'bg-yellow-500',
  skipped: 'bg-gray-400',
};

interface Props {
  roots: LoopTraceNode[];
  /** When provided, enables node output editing (only if loop is terminal). */
  loopId?: string;
  loopStatus?: string;
}

export function LoopDagPanel({ roots, loopId, loopStatus }: Props) {
  const [selected, setSelected] = useState<LoopTraceNode | null>(null);

  if (roots.length === 0) {
    return <div className="text-muted-foreground text-xs">暂无 trace 节点</div>;
  }

  return (
    <div>
      <div className="border rounded p-2 bg-muted/20">
        <DagTree nodes={roots} depth={0} onSelect={setSelected} />
      </div>
      {selected && (
        <TraceDetailDrawer
          node={selected}
          loopId={loopId}
          loopStatus={loopStatus}
          onClose={() => setSelected(null)}
          onUpdated={() => {
            // Trigger parent re-fetch by reloading — parent polls every 5s anyway
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function DagTree({
  nodes,
  depth,
  onSelect,
}: {
  nodes: LoopTraceNode[];
  depth: number;
  onSelect: (n: LoopTraceNode) => void;
}) {
  return (
    <div className="space-y-1">
      {nodes.map((node) => (
        <div key={node.id}>
          <div
            onClick={() => onSelect(node)}
            className={`inline-block border rounded px-2 py-1 text-xs cursor-pointer hover:bg-background transition-colors ${NODE_COLORS[node.node_type] ?? 'bg-background'}`}
            style={{ marginLeft: `${depth * 16}px` }}
          >
            <span
              className={`inline-block w-2 h-2 rounded-full mr-1 ${STATUS_DOT[node.status ?? ''] ?? 'bg-gray-300'} ${node.status === 'running' ? 'animate-pulse' : ''}`}
            />
            <span className="font-mono text-muted-foreground">[{node.node_type}]</span>{' '}
            <span className="text-foreground">{node.title ?? node.tool_name ?? `#${node.id}`}</span>
            {node.tokens > 0 && (
              <span className="ml-2 text-muted-foreground">{node.tokens} tok</span>
            )}
            {node.ended_at && (
              <span className="ml-2 text-muted-foreground/70">
                {Math.round(
                  (new Date(node.ended_at).getTime() - new Date(node.started_at).getTime()) / 1000,
                )}
                s
              </span>
            )}
            {(node as any).edited_at && (
              <span className="ml-2 text-[10px] text-amber-600" title="已编辑">✏️</span>
            )}
          </div>
          {node.children && node.children.length > 0 && (
            <DagTree nodes={node.children} depth={depth + 1} onSelect={onSelect} />
          )}
        </div>
      ))}
    </div>
  );
}

function TraceDetailDrawer({
  node,
  loopId,
  loopStatus,
  onClose,
  onUpdated,
}: {
  node: LoopTraceNode;
  loopId?: string;
  loopStatus?: string;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.output_summary ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEdit = !!loopId && loopStatus !== undefined && ['completed', 'failed', 'cancelled'].includes(loopStatus);

  const handleSave = async () => {
    if (!loopId) return;
    setSaving(true);
    setError(null);
    try {
      await editTraceNode(loopId, node.id, draft);
      setEditing(false);
      onUpdated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-background rounded shadow-lg w-[600px] max-h-[80vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-medium">
            [{node.node_type}] {node.title ?? node.tool_name ?? `#${node.id}`}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            ✕
          </button>
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          <div>ID: {node.id}</div>
          <div>状态: {node.status ?? '-'}</div>
          <div>开始: {node.started_at}</div>
          <div>结束: {node.ended_at ?? '-'}</div>
          <div>Tokens: {node.tokens}</div>
          {node.tool_name && <div>工具: {node.tool_name}</div>}
          {node.tool_use_id && <div>Tool Use ID: {node.tool_use_id}</div>}
        </div>
        {node.input_summary && (
          <div className="mb-3">
            <div className="text-xs font-medium text-muted-foreground mb-1">Input</div>
            <pre className="bg-muted/30 p-2 text-xs whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
              {node.input_summary}
            </pre>
          </div>
        )}
        {node.output_summary !== null && node.output_summary !== undefined && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs font-medium text-muted-foreground">Output</div>
              {canEdit && !editing && (
                <button
                  onClick={() => {
                    setDraft(node.output_summary ?? '');
                    setEditing(true);
                  }}
                  className="text-[11px] text-primary hover:underline"
                >
                  ✏️ 编辑
                </button>
              )}
            </div>
            {editing ? (
              <div>
                <textarea
                  className="w-full p-2 text-xs bg-background border border-border rounded font-mono"
                  rows={10}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={saving}
                />
                {error && <div className="text-[11px] text-red-600 mt-1">{error}</div>}
                <div className="flex justify-end gap-2 mt-2">
                  <button
                    onClick={() => setEditing(false)}
                    disabled={saving}
                    className="text-[11px] px-2 py-1 border border-border rounded hover:bg-muted"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="text-[11px] px-2 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
                  >
                    {saving ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            ) : (
              <pre className="bg-muted/30 p-2 text-xs whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {node.output_summary}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
