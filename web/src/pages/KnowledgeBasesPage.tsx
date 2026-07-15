import { useEffect, useState } from 'react';
import { useKnowledgeBasesStore } from '../stores/knowledge-bases';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { BookOpen, Plus, Trash2, Upload, Search } from 'lucide-react';

export function KnowledgeBasesPage() {
  const { list, loading, load, create, remove, listDocuments, uploadDocument, removeDocument, search } = useKnowledgeBasesStore();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [selectedKb, setSelectedKb] = useState<string | null>(null);
  const [docs, setDocs] = useState<Array<{ id: string; filename: string; size_bytes: number; created_at: string }>>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ filename: string; snippet: string; kb_name?: string | null }>>([]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selectedKb) { setDocs([]); return; }
    listDocuments(selectedKb).then(setDocs).catch(() => setDocs([]));
  }, [selectedKb, listDocuments]);

  const handleCreate = async () => {
    if (!newName.trim()) { toast.error('Name required'); return; }
    const kb = await create(newName.trim(), newDesc);
    if (kb) {
      toast.success('Knowledge base created');
      setNewName(''); setNewDesc(''); setShowCreate(false);
      setSelectedKb(kb.id);
    } else {
      toast.error('Create failed');
    }
  };

  const handleUpload = async (kbId: string, file: File) => {
    const ok = await uploadDocument(kbId, file);
    if (ok) {
      toast.success('Document uploaded');
      const fresh = await listDocuments(kbId);
      setDocs(fresh);
      await load();
    } else {
      toast.error('Upload failed (only .md/.txt ≤ 5MB)');
    }
  };

  const handleSearch = async () => {
    if (!selectedKb || !searchQuery.trim()) return;
    const hits = await search(selectedKb, searchQuery);
    setSearchResults(hits);
  };

  const selectedKbObj = list.find((k) => k.id === selectedKb);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader
        title="知识库"
        subtitle="为你的 Agent 挂载私有知识（FTS5 全文检索，支持 .md / .txt）"
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="size-4 mr-1" /> 新建知识库
          </Button>
        }
      />

      {loading && <div className="text-sm text-muted-foreground mt-4">加载中…</div>}

      <div className="mt-6 grid grid-cols-12 gap-4">
        <div className="col-span-12 md:col-span-4 space-y-2">
          {list.length === 0 && !loading && (
            <div className="text-sm text-muted-foreground">暂无知识库，点击右上角「新建」创建第一个。</div>
          )}
          {list.map((kb) => (
            <Card
              key={kb.id}
              className={`cursor-pointer transition hover:shadow-md ${selectedKb === kb.id ? 'ring-2 ring-teal-500' : ''}`}
              onClick={() => { setSelectedKb(kb.id); setSearchResults([]); setSearchQuery(''); }}
            >
              <CardContent className="p-3">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="font-medium truncate flex items-center gap-2">
                      <BookOpen className="size-4" /> {kb.name}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {kb.docCount} 文档 · {kb.description || '无描述'}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`删除知识库 "${kb.name}"？所有文档将被一并删除。`)) {
                        remove(kb.id).then((ok) => {
                          if (ok) { toast.success('Deleted'); if (selectedKb === kb.id) setSelectedKb(null); }
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
          {selectedKbObj ? (
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-semibold">{selectedKbObj.name}</div>
                    <div className="text-sm text-muted-foreground">{selectedKbObj.description}</div>
                  </div>
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      accept=".md,.markdown,.txt,text/markdown,text/plain"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleUpload(selectedKbObj.id, f);
                        e.target.value = '';
                      }}
                    />
                    <Button size="sm" variant="outline">
                      <Upload className="size-4 mr-1" /> 上传文档
                    </Button>
                  </label>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="搜索文档内容…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="flex-1 px-3 py-1.5 text-sm border rounded-md bg-background"
                  />
                  <Button size="sm" onClick={handleSearch}>
                    <Search className="size-4 mr-1" /> 搜索
                  </Button>
                </div>

                {searchResults.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">检索结果（{searchResults.length}）</div>
                    {searchResults.map((r, i) => (
                      <div key={i} className="border-l-2 border-teal-400 pl-3 text-sm">
                        <div className="font-medium">{r.filename}</div>
                        <pre className="whitespace-pre-wrap text-xs text-muted-foreground mt-1">{r.snippet}</pre>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-2">
                  <div className="text-sm font-medium">文档列表（{docs.length}）</div>
                  {docs.length === 0 && <div className="text-sm text-muted-foreground">空，点击「上传文档」添加。</div>}
                  {docs.map((d) => (
                    <div key={d.id} className="flex items-center justify-between py-1.5 border-b last:border-0">
                      <div className="min-w-0">
                        <div className="text-sm truncate">{d.filename}</div>
                        <div className="text-xs text-muted-foreground">{(d.size_bytes / 1024).toFixed(1)} KB · {d.created_at}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`删除文档 ${d.filename}？`)) {
                            removeDocument(selectedKbObj.id, d.id).then((ok) => {
                              if (ok) {
                                toast.success('Deleted');
                                listDocuments(selectedKbObj.id).then(setDocs);
                              } else toast.error('Delete failed');
                            });
                          }
                        }}
                      >
                        <Trash2 className="size-4 text-red-500" />
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="text-sm text-muted-foreground">选择左侧知识库查看详情</div>
          )}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <CardContent className="p-4 space-y-3">
              <div className="font-semibold">新建知识库</div>
              <input
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                placeholder="名称"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <textarea
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                placeholder="描述（可选）"
                rows={3}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
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
