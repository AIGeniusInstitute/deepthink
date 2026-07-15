import { useEffect, useState } from 'react';
import { useAgentsPaasStore, type AgentDefinition, type ResourceType, type AvailableResource, type AgentVersion } from '../stores/agents-paas';
import { useGroupsStore } from '../stores/groups';
import { api } from '../api/client';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Bot, Plus, Trash2, Link as LinkIcon, Folder, History, RotateCcw } from 'lucide-react';

const RESOURCE_LABEL: Record<ResourceType, string> = {
  mcp_server: 'MCP Server',
  skill: 'Skill',
  knowledge_base: 'Knowledge Base',
};

export function AgentStudioPage() {
  const { list, quota, used, loading, load, loadAvailable, available, create, remove, addMount, removeMount, update, listVersions, restoreVersion, versions } = useAgentsPaasStore();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [model, setModel] = useState('');
  const [engine, setEngine] = useState<'claude' | 'atomcode'>('claude');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  useEffect(() => { load(); loadAvailable(); }, [load, loadAvailable]);
  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  useEffect(() => { loadGroups(); }, [loadGroups]);

  const selected = list.find((a) => a.id === selectedId) ?? null;
  const boundGroups = selected
    ? Object.entries(groups)
        .filter(([, g]) => g.agent_def_id === selected.id)
        .map(([jid, g]) => ({ jid, name: g.name, folder: g.folder }))
    : [];
  const allGroupEntries = Object.entries(groups).map(([jid, g]) => ({ jid, name: g.name, folder: g.folder }));

  const handleCreate = async () => {
    if (!name.trim()) { toast.error('Name required'); return; }
    if (used >= quota) { toast.error(`Quota exceeded (${used}/${quota})`); return; }
    const ag = await create({
      name: name.trim(),
      system_prompt: systemPrompt || undefined,
      model: model || null,
      engine,
      enabled: true,
    });
    if (ag) {
      toast.success('Agent created');
      setName(''); setSystemPrompt(''); setModel(''); setEngine('claude'); setShowCreate(false);
      setSelectedId(ag.id);
    } else toast.error('Create failed');
  };

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

      {loading && <div className="text-sm text-muted-foreground mt-4">加载中…</div>}

      <div className="mt-6 grid grid-cols-12 gap-4">
        <div className="col-span-12 md:col-span-4 space-y-2">
          {list.length === 0 && !loading && (
            <div className="text-sm text-muted-foreground">暂无 Agent，点击右上角新建。</div>
          )}
          {list.map((ag) => (
            <Card
              key={ag.id}
              className={`cursor-pointer transition hover:shadow-md ${selectedId === ag.id ? 'ring-2 ring-teal-500' : ''}`}
              onClick={() => setSelectedId(ag.id)}
            >
              <CardContent className="p-3">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="font-medium truncate flex items-center gap-2">
                      <Bot className="size-4" /> {ag.name}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {ag.mounts?.length ?? 0} 挂载 · {ag.model ?? '默认模型'} · {ag.engine}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`删除 Agent "${ag.name}"？`)) {
                        remove(ag.id).then((ok) => {
                          if (ok) { toast.success('Deleted'); if (selectedId === ag.id) setSelectedId(null); }
                          else toast.error('Delete failed');
                        });
                      }
                    }}
                  >
                    <Trash2 className="size-4 text-red-500" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="col-span-12 md:col-span-8">
          {selected ? (
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-semibold">{selected.name}</div>
                    <div className="text-sm text-muted-foreground">{selected.description || '无描述'}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const v = !selected.enabled;
                      update(selected.id, { enabled: v }).then((ok) => ok ? toast.success(v ? 'Enabled' : 'Disabled') : toast.error('Update failed'));
                    }}
                  >
                    {selected.enabled ? '已启用' : '已禁用'} · 点击切换
                  </Button>
                </div>

                <div className="text-sm">
                  <div className="font-medium mb-1">System Prompt</div>
                  <textarea
                    className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                    rows={5}
                    defaultValue={selected.systemPrompt}
                    placeholder="（留空则使用平台默认行为指令）"
                    onBlur={(e) => {
                      if (e.target.value !== selected.systemPrompt) {
                        update(selected.id, { system_prompt: e.target.value }).then((ok) => ok && toast.success('Saved'));
                      }
                    }}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-sm font-medium mb-1">模型</div>
                    <input
                      className="w-full px-3 py-1.5 border rounded-md bg-background text-sm"
                      defaultValue={selected.model ?? ''}
                      placeholder="留空使用 provider 默认"
                      onBlur={(e) => {
                        const v = e.target.value || null;
                        if (v !== selected.model) update(selected.id, { model: v });
                      }}
                    />
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-1">max_turns</div>
                    <input
                      type="number"
                      className="w-full px-3 py-1.5 border rounded-md bg-background text-sm"
                      defaultValue={selected.maxTurns ?? ''}
                      placeholder="留空使用 SDK 默认"
                      onBlur={(e) => {
                        const raw = e.target.value;
                        const v = raw ? Number(raw) : null;
                        if (v !== selected.maxTurns) update(selected.id, { max_turns: v });
                      }}
                    />
                  </div>
                </div>

                <MountsSection
                  agent={selected}
                  available={available}
                  onAdd={(t, id) => addMount(selected.id, t, id)}
                  onRemove={(mid) => removeMount(selected.id, mid)}
                />

                <BoundGroupsSection
                  boundGroups={boundGroups}
                  allGroups={allGroupEntries}
                  onBind={async (jid) => {
                    try {
                      await api.patch(`/api/groups/${encodeURIComponent(jid)}`, { agent_def_id: selected.id });
                      await loadGroups();
                      toast.success('Agent bound to group');
                    } catch {
                      toast.error('Bind failed');
                    }
                  }}
                  onUnbind={async (jid) => {
                    try {
                      await api.patch(`/api/groups/${encodeURIComponent(jid)}`, { agent_def_id: null });
                      await loadGroups();
                      toast.success('Unbound');
                    } catch {
                      toast.error('Unbind failed');
                    }
                  }}
                />

                <VersionHistorySection
                  agent={selected}
                  versions={versions[selected.id] ?? []}
                  onLoad={() => { void listVersions(selected.id); }}
                  onRestore={async (vid) => {
                    const ok = await restoreVersion(selected.id, vid);
                    if (ok) toast.success('已回滚到该版本');
                    else toast.error('回滚失败');
                  }}
                  showAll={showVersions}
                  onToggleShow={() => setShowVersions((v) => !v)}
                />
              </CardContent>
            </Card>
          ) : (
            <div className="text-sm text-muted-foreground">选择左侧 Agent 查看详情</div>
          )}
        </div>
      </div>

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
              <textarea
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                rows={6}
                placeholder="System Prompt（可空，留空则继承平台默认）"
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

function MountsSection({
  agent,
  available,
  onAdd,
  onRemove,
}: {
  agent: AgentDefinition;
  available: AvailableResource | null;
  onAdd: (t: ResourceType, id: string) => void;
  onRemove: (mid: string) => void;
}) {
  const [adding, setAdding] = useState<ResourceType | null>(null);
  const mounts = agent.mounts ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">挂载（{mounts.length}）</div>
        <div className="flex gap-1">
          {(['mcp_server', 'skill', 'knowledge_base'] as ResourceType[]).map((t) => (
            <Button key={t} size="sm" variant="outline" onClick={() => setAdding(t)}>
              <Plus className="size-3 mr-1" /> {RESOURCE_LABEL[t]}
            </Button>
          ))}
        </div>
      </div>

      {mounts.length === 0 && (
        <div className="text-sm text-muted-foreground">暂无挂载。Agent 启用后将使用用户全局 MCP/Skill，不挂 KB。</div>
      )}

      {mounts.map((m) => (
        <div key={m.id} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
          <div className="flex items-center gap-2">
            <LinkIcon className="size-4 text-muted-foreground" />
            <span className="px-1.5 py-0.5 rounded bg-muted text-xs">{RESOURCE_LABEL[m.resourceType]}</span>
            <span className="font-mono text-xs">{m.resourceId}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onRemove(m.id)}>
            <Trash2 className="size-4 text-red-500" />
          </Button>
        </div>
      ))}

      {adding && available && (
        <div className="border rounded-md p-2 bg-muted/30">
          <div className="text-xs font-medium mb-2">选择 {RESOURCE_LABEL[adding]} 挂载</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {(() => {
              const opts =
                adding === 'mcp_server' ? (available.mcp_servers.map((s: { id: string; name: string }) => ({ id: s.id, label: `${s.name} (${s.id})` })))
                : adding === 'skill' ? (available.skills.map((s: { id: string; name: string }) => ({ id: s.id, label: s.name })))
                : (available.knowledge_bases.map((k: { id: string; name: string; doc_count: number }) => ({ id: k.id, label: `${k.name} (${k.doc_count} docs)` })));
              if (opts.length === 0) return <div className="text-xs text-muted-foreground">无可挂载资源</div>;
              return opts.map((o: { id: string; label: string }) => (
                <button
                  key={o.id}
                  className="w-full text-left px-2 py-1 text-sm hover:bg-background rounded"
                  onClick={() => {
                    onAdd(adding, o.id);
                    setAdding(null);
                  }}
                >
                  {o.label}
                </button>
              ));
            })()}
          </div>
          <div className="flex justify-end mt-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>取消</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BoundGroupsSection({
  boundGroups,
  allGroups,
  onBind,
  onUnbind,
}: {
  boundGroups: Array<{ jid: string; name: string; folder: string }>;
  allGroups: Array<{ jid: string; name: string; folder: string }>;
  onBind: (jid: string) => void;
  onUnbind: (jid: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const candidates = allGroups.filter((g) => !boundGroups.some((b) => b.jid === g.jid));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">绑定的群组（{boundGroups.length}）</div>
        <Button size="sm" variant="outline" onClick={() => setShowPicker((v) => !v)}>
          <Plus className="size-3 mr-1" /> 绑定群组
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        绑定后，该群组的下一条消息会以这个 Agent 的 system prompt / 模型 / 挂载执行。
      </div>

      {boundGroups.length === 0 && (
        <div className="text-sm text-muted-foreground">尚未绑定到任何群组。</div>
      )}

      {boundGroups.map((g) => (
        <div key={g.jid} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <Folder className="size-4 text-muted-foreground" />
            <span className="truncate">{g.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{g.folder}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onUnbind(g.jid)}>
            解绑
          </Button>
        </div>
      ))}

      {showPicker && (
        <div className="border rounded-md p-2 bg-muted/30">
          <div className="text-xs font-medium mb-2">选择要绑定的群组</div>
          {candidates.length === 0 ? (
            <div className="text-xs text-muted-foreground">所有群组都已绑定</div>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {candidates.map((g) => (
                <button
                  key={g.jid}
                  className="w-full text-left px-2 py-1 text-sm hover:bg-background rounded"
                  onClick={() => { onBind(g.jid); setShowPicker(false); }}
                >
                  {g.name} <span className="text-xs text-muted-foreground">({g.folder})</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-end mt-2">
            <Button size="sm" variant="ghost" onClick={() => setShowPicker(false)}>取消</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function VersionHistorySection({
  agent,
  versions,
  onLoad,
  onRestore,
  showAll,
  onToggleShow,
}: {
  agent: AgentDefinition;
  versions: AgentVersion[];
  onLoad: () => void | Promise<void>;
  onRestore: (vid: string) => void | Promise<void>;
  showAll: boolean;
  onToggleShow: () => void;
}) {
  useEffect(() => { onLoad(); }, [agent.id, onLoad]);

  const list = showAll ? versions : versions.slice(0, 3);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium flex items-center gap-2">
          <History className="size-4" /> 版本历史（{versions.length}）
        </div>
        {versions.length > 3 && (
          <Button size="sm" variant="ghost" onClick={onToggleShow}>
            {showAll ? '收起' : `展开全部 (${versions.length})`}
          </Button>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        每次修改 Agent 会自动生成版本快照（最多保留 20 个）。回滚前会再生成一个当前状态快照作为 undo。
      </div>

      {versions.length === 0 ? (
        <div className="text-sm text-muted-foreground">尚无版本历史。修改 Agent 后会自动创建快照。</div>
      ) : (
        <div className="space-y-1">
          {list.map((v) => (
            <div key={v.id} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-mono text-xs">v{v.version}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(v.created_at).toLocaleString('zh-CN')} · {v.created_by.slice(0, 8)}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (confirm(`回滚到 v${v.version}？当前状态会自动保存为新版本作为 undo。`)) {
                    onRestore(v.id);
                  }
                }}
              >
                <RotateCcw className="size-4 mr-1" /> 回滚
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
