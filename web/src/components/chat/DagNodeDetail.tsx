/**
 * Detail panel for a single DAG node. Shows full context state and supports:
 *   - Editing input_summary / output_summary (saved as annotations)
 *   - "Rerun this node" — sends node.input as a new user message
 *   - "Continue from here" — same as rerun but with a `[continue]` prefix
 *
 * Rerun is implemented client-side: the input text is sent through the
 * existing /api/messages pipeline via chat store's sendMessage action. No
 * dedicated server-side rerun endpoint — keeps the message pipeline single-path.
 */

import { useState, useEffect } from 'react';
import { X, Save, RotateCw, PlayCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useChatStore, type TraceNodeEntry } from '../../stores/chat';
import { Button } from '@/components/ui/button';

interface DagNodeDetailProps {
  chatJid: string;
  node: TraceNodeEntry;
}

const NODE_TYPE_LABELS: Record<TraceNodeEntry['node_type'], string> = {
  turn: 'Turn (回合)',
  tool: 'Tool (工具)',
  skill: 'Skill (技能)',
  subagent: 'Sub-Agent (子代理)',
  review: 'Review (审查)',
  goal_check: 'Goal Check (目标检查)',
};

export function DagNodeDetail({ chatJid, node }: DagNodeDetailProps) {
  const setSelectedNodeId = useChatStore((s) => s.setSelectedTraceNodeId);
  const saveAnnotation = useChatStore((s) => s.saveTraceNodeAnnotation);
  const sendMessage = useChatStore((s) => s.sendMessage);

  const [annotationInput, setAnnotationInput] = useState('');
  const [annotationOutput, setAnnotationOutput] = useState('');
  const [saving, setSaving] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  useEffect(() => {
    setAnnotationInput(node.annotation_input ?? node.input_summary ?? '');
    setAnnotationOutput(node.annotation_output ?? node.output_summary ?? '');
  }, [node.id, node.annotation_input, node.annotation_output, node.input_summary, node.output_summary]);

  const handleSave = async () => {
    setSaving(true);
    const ok = await saveAnnotation(chatJid, node.id, annotationInput, annotationOutput);
    setSaving(false);
    if (ok) {
      toast.success('已保存节点注解');
    } else {
      toast.error('保存失败');
    }
  };

  const handleRerun = async (mode: 'rerun' | 'continue') => {
    const inputText = (node.annotation_input ?? node.input_summary ?? '').trim();
    if (!inputText) {
      toast.error('该节点没有可重跑的输入');
      return;
    }
    const prefix = mode === 'continue' ? `[从节点 #${node.id} 续跑]` : `[重跑节点 #${node.id}]`;
    const message = `${prefix}\n\n${inputText}`;
    if (!window.confirm(`确定${mode === 'continue' ? '从该节点续跑' : '重跑该节点'}？将作为新消息发送到当前会话。`)) {
      return;
    }
    setRerunning(true);
    const ok = await sendMessage(chatJid, message);
    setRerunning(false);
    if (ok) {
      toast.success(`已${mode === 'continue' ? '从节点续跑' : '重跑节点'}`);
      setSelectedNodeId(null);
    } else {
      toast.error('发送失败');
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold">#{node.id}</span>
          <span className="text-xs text-muted-foreground truncate">
            {NODE_TYPE_LABELS[node.node_type]}
          </span>
        </div>
        <button
          onClick={() => setSelectedNodeId(null)}
          className="text-muted-foreground hover:text-foreground p-1 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {/* Metadata */}
        <div className="space-y-1 text-xs">
          {node.parent_node_id != null && (
            <div className="flex gap-2">
              <span className="text-muted-foreground flex-shrink-0">父节点:</span>
              <button
                onClick={() => setSelectedNodeId(node.parent_node_id!)}
                className="text-primary hover:underline cursor-pointer"
              >
                #{node.parent_node_id}
              </button>
            </div>
          )}
          {node.title && (
            <div className="flex gap-2">
              <span className="text-muted-foreground flex-shrink-0">标题:</span>
              <span className="text-foreground break-all">{node.title}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-muted-foreground flex-shrink-0">状态:</span>
            <span className="text-foreground">{node.status ?? '未知'}</span>
          </div>
          {node.tokens != null && node.tokens > 0 && (
            <div className="flex gap-2">
              <span className="text-muted-foreground flex-shrink-0">Tokens:</span>
              <span className="text-foreground">{node.tokens.toLocaleString()}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-muted-foreground flex-shrink-0">开始:</span>
            <span className="text-foreground">{node.started_at}</span>
          </div>
          {node.ended_at && (
            <div className="flex gap-2">
              <span className="text-muted-foreground flex-shrink-0">结束:</span>
              <span className="text-foreground">{node.ended_at}</span>
            </div>
          )}
        </div>

        {/* Input (editable) */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            输入 (Input)
          </label>
          <textarea
            value={annotationInput}
            onChange={(e) => setAnnotationInput(e.target.value)}
            className="w-full min-h-[80px] px-2.5 py-1.5 text-xs font-mono rounded-md border border-input bg-background text-foreground resize-y"
            placeholder="节点输入..."
          />
        </div>

        {/* Output (editable) */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            输出 (Output)
          </label>
          <textarea
            value={annotationOutput}
            onChange={(e) => setAnnotationOutput(e.target.value)}
            className="w-full min-h-[80px] px-2.5 py-1.5 text-xs font-mono rounded-md border border-input bg-background text-foreground resize-y"
            placeholder="节点输出..."
          />
        </div>

        {/* Original summaries (read-only, for reference) */}
        {(node.input_summary || node.output_summary) && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              查看原始输入输出
            </summary>
            <div className="mt-2 space-y-2">
              {node.input_summary && (
                <div>
                  <div className="text-[10px] text-muted-foreground mb-0.5">原始输入</div>
                  <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded max-h-40 overflow-y-auto">
                    {node.input_summary}
                  </pre>
                </div>
              )}
              {node.output_summary && (
                <div>
                  <div className="text-[10px] text-muted-foreground mb-0.5">原始输出</div>
                  <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted p-2 rounded max-h-40 overflow-y-auto">
                    {node.output_summary}
                  </pre>
                </div>
              )}
            </div>
          </details>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex-shrink-0 p-3 border-t border-border space-y-2">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="w-full"
          size="sm"
          variant="outline"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          保存注解
        </Button>
        <div className="flex gap-2">
          <Button
            onClick={() => handleRerun('rerun')}
            disabled={rerunning}
            className="flex-1"
            size="sm"
            variant="outline"
          >
            {rerunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
            重跑此节点
          </Button>
          <Button
            onClick={() => handleRerun('continue')}
            disabled={rerunning}
            className="flex-1"
            size="sm"
          >
            {rerunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
            从此续跑
          </Button>
        </div>
      </div>
    </div>
  );
}
