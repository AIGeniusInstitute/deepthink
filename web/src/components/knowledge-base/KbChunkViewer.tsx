import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { History, Pencil, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { useKnowledgeBasesStore, type KbChunk } from '@/stores/knowledge-bases';

/**
 * 分块查看器。
 *
 * 除了列出分块，它还承担一个更重要的职责：把「引用」变成可核验的东西 ——
 * 点开一个分块就能按 start_at/end_at 回源文档取原文，两相对照。偏移如果错了，
 * 在这里一眼就能看出来，而不是等到用户发现引用对不上正文。
 */
export function KbChunkViewer({ docId }: { docId: string }) {
  const { listChunks, updateChunk, removeChunk, listChunkRevisions, revertChunk, getDocumentContent } =
    useKnowledgeBasesStore();
  const [chunks, setChunks] = useState<KbChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [revisionsOf, setRevisionsOf] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Array<{ id: string; content: string; created_at: string }>>([]);
  /** 回源核验结果：chunk id → 原文切片。 */
  const [verified, setVerified] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setChunks(await listChunks(docId, true));
    } finally {
      setLoading(false);
    }
  }, [docId, listChunks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleVerify = async (chunk: KbChunk) => {
    if (verified[chunk.id]) {
      setVerified((prev) => {
        const next = { ...prev };
        delete next[chunk.id];
        return next;
      });
      return;
    }
    try {
      const original = await getDocumentContent(chunk.doc_id, chunk.start_at, chunk.end_at);
      setVerified((prev) => ({ ...prev, [chunk.id]: original }));
    } catch {
      toast.error('回源失败');
    }
  };

  const handleSave = async (chunk: KbChunk) => {
    const updated = await updateChunk(chunk.id, draft);
    if (!updated) {
      toast.error('保存失败：内容不能为空');
      return;
    }
    toast.success('已保存（原内容已留档，向量已失效待重建）');
    setEditingId(null);
    await refresh();
  };

  const handleRevisions = async (chunkId: string) => {
    if (revisionsOf === chunkId) {
      setRevisionsOf(null);
      return;
    }
    setRevisions(await listChunkRevisions(chunkId));
    setRevisionsOf(chunkId);
  };

  if (loading && chunks.length === 0) {
    return <div className="text-sm text-muted-foreground">加载分块中…</div>;
  }
  if (chunks.length === 0) {
    return <div className="text-sm text-muted-foreground">该文档尚未生成分块，可能仍在处理中。</div>;
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-muted-foreground">
        共 {chunks.length} 个分块 · 每个分块记录其在原文中的字符区间
      </div>
      {chunks.map((c) => (
        <Card key={c.id} data-testid="kb-chunk-card" className="border-l-2 border-l-teal-400">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                <span className="font-mono px-1.5 py-0.5 rounded bg-muted">#{c.chunk_index}</span>
                <span className="font-mono">
                  [{c.start_at}, {c.end_at})
                </span>
                <span>{c.char_count} 字</span>
                {c.heading_path && (
                  <span className="truncate px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                    {c.heading_path}
                  </span>
                )}
                {c.embedded ? (
                  <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">已向量化</span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">未向量化</span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => void handleVerify(c)} title="按偏移回源核验">
                  <RotateCcw className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingId(c.id);
                    setDraft(c.content ?? c.preview);
                  }}
                  title="编辑"
                >
                  <Pencil className="size-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void handleRevisions(c.id)} title="历史版本">
                  <History className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!confirm(`删除分块 #${c.chunk_index}？`)) return;
                    if (await removeChunk(c.id)) {
                      toast.success('已删除');
                      await refresh();
                    } else toast.error('删除失败');
                  }}
                  title="删除"
                >
                  <Trash2 className="size-4 text-red-500" />
                </Button>
              </div>
            </div>

            {editingId === c.id ? (
              <div className="space-y-2">
                <textarea
                  className="w-full px-2 py-1.5 text-sm border rounded-md bg-background font-mono"
                  rows={6}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void handleSave(c)}>
                    <Save className="size-4 mr-1" /> 保存
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                    <X className="size-4 mr-1" /> 取消
                  </Button>
                </div>
              </div>
            ) : (
              <pre className="whitespace-pre-wrap text-sm bg-muted/40 rounded p-2 max-h-60 overflow-auto">
                {c.content ?? c.preview}
              </pre>
            )}

            {c.generated_questions && c.generated_questions.length > 0 && (
              <div className="text-xs border-t pt-2" data-testid="kb-chunk-questions">
                <div className="font-medium mb-1 text-muted-foreground">
                  预生成问题（{c.generated_questions.length}）· 只进向量索引，不是分块正文
                </div>
                <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
                  {c.generated_questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </div>
            )}

            {verified[c.id] !== undefined && (
              <div className="text-xs border-t pt-2">
                <div className="font-medium mb-1">
                  回源核验：
                  <span className={verified[c.id] === c.content ? 'text-emerald-600' : 'text-red-600'}>
                    {verified[c.id] === c.content ? ' 与原文一致 ✓' : ' 与原文不一致 ✗'}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap text-muted-foreground bg-muted/40 rounded p-2 max-h-40 overflow-auto">
                  {verified[c.id]}
                </pre>
              </div>
            )}

            {revisionsOf === c.id && (
              <div className="text-xs border-t pt-2 space-y-1">
                <div className="font-medium">历史版本（{revisions.length}）</div>
                {revisions.length === 0 && <div className="text-muted-foreground">暂无修订记录</div>}
                {revisions.map((r) => (
                  <div key={r.id} className="flex items-start gap-2">
                    <pre className="flex-1 whitespace-pre-wrap text-muted-foreground bg-muted/40 rounded p-1.5 max-h-24 overflow-auto">
                      {r.content.slice(0, 300)}
                    </pre>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const ok = await revertChunk(c.id, r.id);
                        if (ok) {
                          toast.success('已回滚');
                          setRevisionsOf(null);
                          await refresh();
                        } else toast.error('回滚失败');
                      }}
                    >
                      回滚
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
