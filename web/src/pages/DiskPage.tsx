import { useEffect, useState, useMemo } from 'react';
import { useChatStore } from '../stores/chat';
import { useFileStore, type FileEntry, type TrashItem } from '../stores/files';
import { PageHeader } from '../components/common/PageHeader';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { EmptyState } from '../components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { FolderOpen, Search, Trash2, RotateCcw, HardDriveDownload } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * AgentNet Disk — 企业级 Agent 平台文件网盘（独立全页）。
 * 复用既有 FilePanel（面包屑/列表/预览/上传/编辑），
 * 外层加：工作区切换器 + 文件搜索 + 回收站。
 */
export function DiskPage() {
  const groups = useChatStore((s) => s.groups);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const groupJids = useMemo(() => Object.keys(groups), [groups]);

  const [selectedJid, setSelectedJid] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // 默认选第一个工作区
  useEffect(() => {
    if (!selectedJid && groupJids.length > 0) {
      setSelectedJid(groupJids[0]);
    }
  }, [groupJids, selectedJid]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="网盘"
        subtitle="企业级 Agent 平台文件存储与协作"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSearchOpen(true)}>
              <Search className="h-4 w-4 mr-1" /> 搜索
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTrashOpen(true)}>
              <Trash2 className="h-4 w-4 mr-1" /> 回收站
            </Button>
          </div>
        }
      />
      <div className="flex flex-1 min-h-0 border-t">
        {/* 工作区切换器 */}
        <aside className="w-56 shrink-0 border-r overflow-y-auto bg-muted/30">
          <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            工作区
          </div>
          {groupJids.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">暂无工作区</div>
          ) : (
            <ul className="space-y-0.5 px-2">
              {groupJids.map((jid) => {
                const g = groups[jid];
                const active = jid === selectedJid;
                return (
                  <li key={jid}>
                    <button
                      onClick={() => setSelectedJid(jid)}
                      className={cn(
                        'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left hover:bg-accent transition-colors',
                        active && 'bg-accent font-medium',
                      )}
                      title={g.name}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                      <span className="truncate">{g.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* 文件管理主区（复用 FilePanel） */}
        <main className="flex-1 min-w-0 overflow-hidden">
          {selectedJid ? (
            <DiskFileArea groupJid={selectedJid} />
          ) : (
            <EmptyState
              icon={FolderOpen}
              title="暂无可用工作区"
              description="请先在「工作台」创建或加入一个工作区，即可在网盘管理其文件。"
            />
          )}
        </main>
      </div>

      {/* 搜索弹窗 */}
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} groupJid={selectedJid} />

      {/* 回收站抽屉 */}
      <TrashSheet open={trashOpen} onOpenChange={setTrashOpen} groupJid={selectedJid} />
    </div>
  );
}

// 复用 FilePanel（lazy 加载避免把 1357 行组件打进主 chunk）
import { lazy, Suspense } from 'react';
const FilePanel = lazy(() =>
  import('../components/chat/FilePanel').then((m) => ({ default: m.FilePanel })),
);

function DiskFileArea({ groupJid }: { groupJid: string }) {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <FilePanel groupJid={groupJid} />
    </Suspense>
  );
}

// ─── 搜索弹窗 ───
function SearchDialog({
  open, onOpenChange, groupJid,
}: { open: boolean; onOpenChange: (v: boolean) => void; groupJid: string | null }) {
  const searchFiles = useFileStore((s) => s.searchFiles);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const runSearch = async () => {
    if (!groupJid || !q.trim()) return;
    setLoading(true);
    const r = await searchFiles(groupJid, q.trim());
    setResults(r);
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>文件搜索</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            placeholder="输入文件名关键词…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            autoFocus
          />
          <Button onClick={runSearch} disabled={loading || !q.trim()}>
            <Search className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-2 max-h-80 overflow-y-auto">
          {loading ? (
            <LoadingSpinner />
          ) : results.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {q.trim() ? '无匹配文件' : '输入关键词后回车搜索'}
            </p>
          ) : (
            <ul className="space-y-1">
              {results.map((f) => (
                <li key={f.path} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent text-sm">
                  <FolderOpen className={cn('h-4 w-4', f.type === 'file' && 'text-muted-foreground')} />
                  <span className="font-medium">{f.name}</span>
                  <span className="truncate text-muted-foreground text-xs">{f.path}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{formatSize(f.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── 回收站抽屉 ───
function TrashSheet({
  open, onOpenChange, groupJid,
}: { open: boolean; onOpenChange: (v: boolean) => void; groupJid: string | null }) {
  const store = useFileStore();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    if (!groupJid) return;
    setLoading(true);
    setItems(await store.listTrash(groupJid));
    setLoading(false);
  };

  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groupJid]);

  const handleRestore = async (id: string) => {
    if (!groupJid) return;
    if (await store.restoreTrash(groupJid, id)) {
      await refresh();
    }
  };
  const handlePurge = async (id: string) => {
    if (!groupJid) return;
    if (await store.purgeTrash(groupJid, id)) {
      await refresh();
    }
  };
  const handleEmpty = async () => {
    if (!groupJid) return;
    if (!confirm('确认清空回收站？此操作不可恢复。')) return;
    if (await store.emptyTrash(groupJid)) {
      await refresh();
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[420px] sm:max-w-[420px] flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5" /> 回收站
          </SheetTitle>
        </SheetHeader>
        <div className="flex justify-end mb-2">
          <Button variant="outline" size="sm" onClick={handleEmpty} disabled={items.length === 0}>
            清空
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <LoadingSpinner />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">回收站为空</p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((it) => (
                <li key={it.id} className="rounded border p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium truncate">{it.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{formatSize(it.sizeBytes)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">原路径: {it.originalPath}</div>
                  <div className="text-xs text-muted-foreground">删除于 {new Date(it.deletedAt).toLocaleString()}</div>
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" variant="outline" onClick={() => handleRestore(it.id)}>
                      <RotateCcw className="h-3 w-3 mr-1" /> 恢复
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => handlePurge(it.id)}>
                      <HardDriveDownload className="h-3 w-3 mr-1" /> 彻底删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default DiskPage;
