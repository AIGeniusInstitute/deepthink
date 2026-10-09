/**
 * Agent Studio — Agent 卡片矩阵。
 *
 * 只负责列表展示与新建；点卡片跳转到独立详情页 /agents/:id 做编辑/保存/发布。
 * 详情表单集中在 AgentDetailPage，本页不再持有任何 Agent 字段级状态。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentsPaasStore, type AgentKind, type GeneratedAgentFields } from '../stores/agents-paas';
import { PageHeader, EmptyState } from '@/components/common';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Bot, Plus, Trash2, Wand2, Loader2, ChevronRight, Link as LinkIcon } from 'lucide-react';

export function AgentStudioPage() {
  const { list, quota, used, loading, load, loadAvailable, create, remove, generateAgent } = useAgentsPaasStore();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [model, setModel] = useState('');
  const [engine, setEngine] = useState<'claude' | 'atomcode'>('claude');
  const [maxTurns, setMaxTurns] = useState<string>('');
  const [temperature, setTemperature] = useState<string>('');
  const [kind, setKind] = useState<AgentKind>('assistant');
  const [generating, setGenerating] = useState(false);

  useEffect(() => { load(); loadAvailable(); }, [load, loadAvailable]);

  const handleCreate = async () => {
    if (!name.trim()) { toast.error('Name required'); return; }
    if (used >= quota) { toast.error(`Quota exceeded (${used}/${quota})`); return; }
    const ag = await create({
      name: name.trim(),
      description: description.trim() || undefined,
      system_prompt: systemPrompt || undefined,
      model: model || null,
      engine,
      max_turns: maxTurns ? Number(maxTurns) : null,
      temperature: temperature ? Number(temperature) : null,
      enabled: true,
      kind,
    });
    if (ag) {
      toast.success('Agent created');
      setName(''); setDescription(''); setSystemPrompt(''); setModel(''); setEngine('claude'); setMaxTurns(''); setTemperature(''); setKind('assistant'); setShowCreate(false);
      navigate(`/agents/${ag.id}`);
    } else toast.error('Create failed');
  };

  const handleGenerate = async () => {
    if (description.trim().length < 10) {
      toast.error('请先填写至少 10 字符的描述，再点 AI 生成');
      return;
    }
    setGenerating(true);
    try {
      const fields = await generateAgent({ name: name.trim() || undefined, description: description.trim() });
      if (!fields) {
        toast.error('AI 生成失败（provider 可能不可用或超时）');
        return;
      }
      applyGeneratedFields(fields);
      toast.success('已填入 AI 生成结果，可继续编辑后创建');
    } finally {
      setGenerating(false);
    }
  };

  function applyGeneratedFields(f: GeneratedAgentFields) {
    if (f.name) setName(f.name);
    if (f.description) setDescription(f.description);
    if (f.system_prompt) setSystemPrompt(f.system_prompt);
    setModel(f.model ?? '');
    setEngine(f.engine === 'atomcode' ? 'atomcode' : 'claude');
    setMaxTurns(f.max_turns != null ? String(f.max_turns) : '');
    setTemperature(f.temperature != null ? String(f.temperature) : '');
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader
        title="Agent Studio"
        subtitle={`创建并管理你的 Agent（配额 ${used}/${quota}）`}
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="size-4 mr-1" /> 新建 Agent
          </Button>
        }
      />

      {loading ? (
        <div className="mt-6"><SkeletonCardList count={6} /></div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="还没有 Agent"
          description="创建你的第一个 Agent，或让 AI 根据一段描述自动生成"
          action={
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="size-4 mr-1" /> 新建 Agent
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-6">
          {list.map((ag) => (
            <div
              key={ag.id}
              data-testid="agent-card"
              className="rounded-xl border border-border bg-card p-4 hover:shadow-md transition-shadow cursor-pointer flex flex-col"
              onClick={() => navigate(`/agents/${ag.id}`)}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-9 h-9 shrink-0 rounded-lg bg-teal-500/10 flex items-center justify-center">
                    <Bot className="size-5 text-teal-600" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm truncate">{ag.name}</h3>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {ag.kind === 'orchestrator' && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">编排者</span>
                      )}
                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${ag.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                        {ag.enabled ? '已启用' : '已禁用'}
                      </span>
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`删除 Agent "${ag.name}"？`)) {
                      remove(ag.id).then((ok) => {
                        if (ok) toast.success('Deleted');
                        else toast.error('Delete failed');
                      });
                    }
                  }}
                >
                  <Trash2 className="size-4 text-red-500" />
                </Button>
              </div>

              <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2rem] flex-1">
                {ag.description || '无描述'}
              </p>

              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
                <span className="flex items-center gap-1">
                  <LinkIcon className="size-3" /> {ag.mounts?.length ?? 0}
                </span>
                <span className="truncate">{ag.model ?? '默认模型'}</span>
                <span className="truncate">{ag.engine}</span>
                <ChevronRight className="size-4 ml-auto shrink-0" />
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <CardContent className="p-4 space-y-3">
              <div className="font-semibold">新建 Agent</div>
              <input
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                placeholder="名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <textarea
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                rows={2}
                placeholder="描述（用于 AI 生成的关键输入，至少 10 字符）"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleGenerate}
                  disabled={generating}
                  title="根据名称+描述，AI 自动生成专业 system prompt 等字段"
                >
                  {generating ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Wand2 className="size-4 mr-1" />}
                  AI 生成
                </Button>
                <span className="text-xs text-muted-foreground">生成后可编辑再创建</span>
              </div>
              <div className="flex gap-2 items-center">
                <select
                  className="px-3 py-2 border rounded-md bg-background text-sm"
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as 'claude' | 'atomcode')}
                >
                  <option value="claude">claude engine</option>
                  <option value="atomcode">atomcode engine</option>
                </select>
                <input
                  className="flex-1 px-3 py-2 border rounded-md bg-background text-sm"
                  placeholder="模型 ID（可空）"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  className="px-3 py-2 border rounded-md bg-background text-sm"
                  placeholder="max_turns（可空）"
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                />
                <input
                  type="number"
                  step="0.1"
                  className="px-3 py-2 border rounded-md bg-background text-sm"
                  placeholder="temperature（可空）"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                />
              </div>
              <textarea
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                rows={6}
                placeholder="System Prompt（可空，留空则继承平台默认；点 AI 生成可自动填充）"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>取消</Button>
                <Button size="sm" onClick={handleCreate}>创建</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
