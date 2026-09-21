/**
 * CreateGroupDialog — dialog for creating a new Agent Swarm Group.
 */
import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Loader2 } from 'lucide-react';
import { useAgentGroupStore } from '@/stores/agent-group';
import type { CreateSeatPayload } from '@/api/agent-groups';

export function CreateGroupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createGroup = useAgentGroupStore(s => s.createGroup);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [seats, setSeats] = useState<CreateSeatPayload[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (!open) { setName(''); setDescription(''); setSeats([]); setError(''); } }, [open]);

  const addSeat = () => {
    setSeats([...seats, { agentDefinitionId: '', speakPolicy: 'auto' }]);
  };
  const removeSeat = (i: number) => setSeats(seats.filter((_, j) => j !== i));
  const updateSeat = (i: number, f: Partial<CreateSeatPayload>) => {
    setSeats(seats.map((s, j) => j === i ? { ...s, ...f } : s));
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setError('群组名称不能为空'); return; }
    if (seats.length === 0) { setError('请至少添加一个 Agent 席位'); return; }
    if (seats.some(s => !s.agentDefinitionId.trim())) { setError('所有席位必须填写 Agent 定义 ID'); return; }
    setSubmitting(true);
    setError('');
    const result = await createGroup({
      name: name.trim(),
      description: description.trim() || undefined,
      seats: seats.map(s => ({ ...s, agentDefinitionId: s.agentDefinitionId.trim() })),
    });
    setSubmitting(false);
    if (result) onClose();
    else setError('创建失败，请重试');
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <h2 className="text-sm font-semibold text-foreground">创建 Agent 群组</h2>
            <button onClick={onClose} className="size-7 rounded-md flex items-center justify-center hover:bg-muted"><X className="size-4" /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="text-xs font-medium text-foreground">群组名称 *</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="输入群组名称" className="w-full mt-1 px-3 py-1.5 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground">描述</label>
              <input value={description} onChange={e => setDescription(e.target.value)} placeholder="可选描述" className="w-full mt-1 px-3 py-1.5 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-foreground">Agent 席位 ({seats.length})</label>
                <button onClick={addSeat} className="flex items-center gap-1 text-xs text-primary hover:underline"><Plus className="size-3" />添加</button>
              </div>
              {seats.length === 0 && <p className="text-xs text-muted-foreground">请至少添加一个 Agent 席位</p>}
              {seats.map((seat, i) => (
                <div key={i} className="flex items-center gap-2 mb-2 p-2 rounded-md border border-border">
                  <div className="flex-1 space-y-1">
                    <input value={seat.agentDefinitionId} onChange={e => updateSeat(i, { agentDefinitionId: e.target.value })} placeholder="Agent 定义 ID *" className="w-full px-2 py-1 rounded border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                    <div className="flex gap-2">
                      <input value={seat.rolePrompt ?? ''} onChange={e => updateSeat(i, { rolePrompt: e.target.value })} placeholder="角色提示 (可选)" className="flex-1 px-2 py-1 rounded border border-border bg-background text-xs" />
                      <select value={seat.speakPolicy ?? 'auto'} onChange={e => updateSeat(i, { speakPolicy: e.target.value as 'auto' | 'mention_only' | 'silent' })} className="px-2 py-1 rounded border border-border bg-background text-xs">
                        <option value="auto">自动发言</option>
                        <option value="mention_only">仅@提及</option>
                        <option value="silent">静默</option>
                      </select>
                    </div>
                  </div>
                  <button onClick={() => removeSeat(i)} className="size-6 rounded flex items-center justify-center hover:bg-red-100 text-red-500 shrink-0"><Trash2 className="size-3.5" /></button>
                </div>
              ))}
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>

          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted">取消</button>
            <button onClick={() => void handleSubmit()} disabled={submitting} className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground disabled:opacity-50 flex items-center gap-1">
              {submitting && <Loader2 className="size-3 animate-spin" />}创建
            </button>
          </div>
        </div>
      </div>
    </>
  );
}