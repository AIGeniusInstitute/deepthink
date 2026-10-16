import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useKnowledgeBasesStore } from '../stores/knowledge-bases';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { BookOpen, ChevronRight, Plus, Trash2 } from 'lucide-react';

/**
 * 知识库列表。
 *
 * 这里只负责列出与增删：文档、分块、检索与问答都在详情页，避免同一套交互在
 * 两个页面各维护一份。
 */
export function KnowledgeBasesPage() {
  const { list, loading, load, create, remove } = useKnowledgeBasesStore();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) {
      toast.error('请输入名称');
      return;
    }
    const kb = await create(newName.trim(), newDesc);
    if (kb) {
      toast.success('知识库已创建');
      setNewName('');
      setNewDesc('');
      setShowCreate(false);
      navigate(`/knowledge-bases/${kb.id}`);
    } else {
      toast.error('创建失败');
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader
        title="知识库"
        subtitle="把文档切成分块并建立向量与关键词索引，为 Agent 提供带引用溯源的私有知识"
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="size-4 mr-1" /> 新建知识库
          </Button>
        }
      />

      {loading && <div className="text-sm text-muted-foreground mt-4">加载中…</div>}

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {list.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground col-span-full">
            暂无知识库，点击右上角「新建知识库」创建第一个。
          </div>
        )}
        {list.map((kb) => (
          <Card
            key={kb.id}
            data-testid="kb-card"
            className="cursor-pointer transition hover:shadow-md"
            onClick={() => navigate(`/knowledge-bases/${kb.id}`)}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate flex items-center gap-2">
                    <BookOpen className="size-4 shrink-0" /> {kb.name}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {kb.description || '无描述'}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{kb.docCount} 个文档</div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!confirm(`删除知识库「${kb.name}」？其中的文档与分块将一并删除。`)) return;
                      void remove(kb.id).then((ok) =>
                        ok ? toast.success('已删除') : toast.error('删除失败'),
                      );
                    }}
                  >
                    <Trash2 className="size-4 text-red-500" />
                  </Button>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {showCreate && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => setShowCreate(false)}
        >
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <CardContent className="p-4 space-y-3">
              <div className="font-semibold">新建知识库</div>
              <input
                data-testid="kb-create-name"
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
                <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>
                  取消
                </Button>
                <Button size="sm" data-testid="kb-create-submit" onClick={handleCreate}>
                  创建
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
