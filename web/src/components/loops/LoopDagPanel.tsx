import { useState } from 'react';
import type { LoopTraceNode } from '../../stores/loops';

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

export function LoopDagPanel({ roots }: { roots: LoopTraceNode[] }) {
  const [selected, setSelected] = useState<LoopTraceNode | null>(null);

  if (roots.length === 0) {
    return <div className="text-gray-400 text-xs">暂无 trace 节点</div>;
  }

  return (
    <div>
      <div className="border rounded p-2 bg-gray-50">
        <DagTree nodes={roots} depth={0} onSelect={setSelected} />
      </div>
      {selected && <TraceDetailDrawer node={selected} onClose={() => setSelected(null)} />}
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
            className={`inline-block border rounded px-2 py-1 text-xs cursor-pointer hover:bg-white ${NODE_COLORS[node.node_type] ?? 'bg-white'}`}
            style={{ marginLeft: `${depth * 16}px` }}
          >
            <span
              className={`inline-block w-2 h-2 rounded-full mr-1 ${STATUS_DOT[node.status ?? ''] ?? 'bg-gray-300'}`}
            />
            <span className="font-mono text-gray-700">[{node.node_type}]</span>{' '}
            <span className="text-gray-800">{node.title ?? node.tool_name ?? `#${node.id}`}</span>
            {node.tokens > 0 && (
              <span className="ml-2 text-gray-500">{node.tokens} tok</span>
            )}
            {node.ended_at && (
              <span className="ml-2 text-gray-400">
                {Math.round(new Date(node.ended_at).getTime() - new Date(node.started_at).getTime()) / 1000}s
              </span>
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
  onClose,
}: {
  node: LoopTraceNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded shadow-lg w-[600px] max-h-[80vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-medium">
            [{node.node_type}] {node.title ?? node.tool_name ?? `#${node.id}`}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            ✕
          </button>
        </div>
        <div className="text-xs text-gray-500 mb-3">
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
            <div className="text-xs font-medium text-gray-600 mb-1">Input</div>
            <pre className="bg-gray-100 p-2 text-xs whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
              {node.input_summary}
            </pre>
          </div>
        )}
        {node.output_summary && (
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">Output</div>
            <pre className="bg-gray-100 p-2 text-xs whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
              {node.output_summary}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
