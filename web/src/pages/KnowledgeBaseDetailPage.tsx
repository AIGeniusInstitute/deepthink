import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common/PageHeader';
import { toast } from 'sonner';
import {
  ArrowLeft,
  FileText,
  HelpCircle,
  Layers,
  Link as LinkIcon,
  MessageSquare,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { useKnowledgeBasesStore, type KbDocumentMeta } from '@/stores/knowledge-bases';
import { KbChunkViewer } from '@/components/knowledge-base/KbChunkViewer';
import { KbSearchLab } from '@/components/knowledge-base/KbSearchLab';
import { KbChatPanel } from '@/components/knowledge-base/KbChatPanel';
import { KbFaqPanel } from '@/components/knowledge-base/KbFaqPanel';
import { KbDoc2QueryPanel } from '@/components/knowledge-base/KbDoc2QueryPanel';

type Tab = 'documents' | 'faq' | 'chunks' | 'search' | 'chat';

const TABS: Array<{ id: Tab; label: string; icon: typeof FileText }> = [
  { id: 'documents', label: '文档', icon: FileText },
  { id: 'faq', label: 'FAQ 条目', icon: HelpCircle },
  { id: 'chunks', label: '分块', icon: Layers },
  { id: 'search', label: '检索测试台', icon: Search },
  { id: 'chat', label: '问答', icon: MessageSquare },
];

/** 非终态即仍需轮询。 */
const PENDING_STATUSES = new Set(['pending', 'parsing', 'chunking', 'embedding']);

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  pending: 'bg-slate-100 text-slate-600',
  parsing: 'bg-blue-100 text-blue-700',
  chunking: 'bg-blue-100 text-blue-700',
  embedding: 'bg-indigo-100 text-indigo-700',
};

const STATUS_LABEL: Record<string, string> = {
  ready: '就绪',
  failed: '失败',
  pending: '排队中',
  parsing: '解析中',
  chunking: '分块中',
  embedding: '向量化中',
};

export function KnowledgeBaseDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const {
    list,
    load,
    listDocuments,
    uploadDocument,
    uploadFromUrl,
    removeDocument,
    reparseDocument,
    cancelIngest,
    rebuildIndex,
  } = useKnowledgeBasesStore();

  const [tab, setTab] = useState<Tab>('documents');
  const [docs, setDocs] = useState<KbDocumentMeta[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [showUrl, setShowUrl] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [rebuilding, setRebuilding] = useState(false);
  const [strategy, setStrategy] = useState<'auto' | 'heading' | 'heuristic' | 'recursive'>('auto');
  const [chunkSize, setChunkSize] = useState(512);
  const [chunkOverlap, setChunkOverlap] = useState(80);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kb = list.find((k) => k.id === id);
  const isFaq = kb?.type === 'faq';

  // FAQ 库没有文档也没有分块（条目就是它的全部内容），这两屏对它是空的，
  // 留着一排能点进去的空白页签只会让人以为是坏了。
  const visibleTabs = TABS.filter((t) =>
    isFaq ? t.id !== 'documents' && t.id !== 'chunks' : t.id !== 'faq',
  );

  useEffect(() => {
    if (isFaq && tab === 'documents') setTab('faq');
  }, [isFaq, tab]);

  const refreshDocs = useCallback(async () => {
    if (!id) return;
    try {
      const fresh = await listDocuments(id);
      setDocs(fresh);
    } catch {
      setDocs([]);
    }
  }, [id, listDocuments]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void refreshDocs();
  }, [refreshDocs]);

  // 入库流水线在后台跑，前端按状态轮询到终态为止：只有还有文档在处理的
  // 时候才定时拉一次，静止时不该有常驻请求。
  useEffect(() => {
    const busy = docs.some((d) => PENDING_STATUSES.has(d.parse_status ?? 'ready'));
    if (!busy) {
      if (pollRef.current) clearTimeout(pollRef.current);
      return;
    }
    pollRef.current = setTimeout(() => void refreshDocs(), 1500);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [docs, refreshDocs]);

  const chunkCfg = () => ({
    strategy,
    chunk_size: chunkSize,
    chunk_overlap: chunkOverlap,
  });

  const handleUpload = async (file: File) => {
    const res = await uploadDocument(id, file, chunkCfg());
    if (res.ok) {
      toast.success('已上传，正在后台解析与分块');
      await refreshDocs();
    } else {
      toast.error(res.error ?? '上传失败');
    }
  };

  const handleUrl = async () => {
    if (!urlValue.trim()) return;
    const res = await uploadFromUrl(id, urlValue.trim());
    if (res.ok) {
      toast.success('URL 内容已入库');
      setUrlValue('');
      setShowUrl(false);
      await refreshDocs();
    } else {
      toast.error(res.error ?? 'URL 抓取失败');
    }
  };

  const handleRebuild = async () => {
    setRebuilding(true);
    const res = await rebuildIndex(id);
    setRebuilding(false);
    if (res) {
      toast.success(
        `索引重建完成：重新分块 ${res.rechunked_documents ?? 0} 个文档，向量化 ${res.success ?? 0}/${res.attempted ?? 0}` +
          (res.dimension_changed ? '（向量维度已变更，需要重新嵌入）' : ''),
      );
      await refreshDocs();
    } else {
      toast.error('索引重建失败');
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <PageHeader
        title={kb?.name ?? '知识库'}
        subtitle={kb?.description || `文档 ${docs.length} 个 · 分块级混合检索（向量 + 关键词 RRF 融合）`}
        actions={
          <Link to="/knowledge-bases">
            <Button variant="outline" size="sm">
              <ArrowLeft className="size-4 mr-1" /> 返回列表
            </Button>
          </Link>
        }
      />

      <div className="mt-4 flex items-center gap-1 border-b">
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              data-testid={`kb-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px ${
                tab === t.id
                  ? 'border-teal-600 text-teal-700 font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="size-4" /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {tab === 'documents' && kb && (
          <div className="mb-4">
            <KbDoc2QueryPanel kb={kb} />
          </div>
        )}

        {tab === 'documents' && (
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs">
                  <div className="text-muted-foreground mb-1">分块策略</div>
                  <select
                    className="px-2 py-1.5 text-sm border rounded-md bg-background"
                    value={strategy}
                    onChange={(e) => setStrategy(e.target.value as typeof strategy)}
                  >
                    <option value="auto">自动识别</option>
                    <option value="heading">按标题</option>
                    <option value="heuristic">按段落</option>
                    <option value="recursive">递归切分</option>
                  </select>
                </label>
                <label className="text-xs">
                  <div className="text-muted-foreground mb-1">分块大小</div>
                  <input
                    type="number"
                    min={64}
                    max={8192}
                    value={chunkSize}
                    onChange={(e) => setChunkSize(Number(e.target.value) || 512)}
                    className="w-24 px-2 py-1.5 text-sm border rounded-md bg-background"
                  />
                </label>
                <label className="text-xs">
                  <div className="text-muted-foreground mb-1">重叠</div>
                  <input
                    type="number"
                    min={0}
                    max={4096}
                    value={chunkOverlap}
                    onChange={(e) => setChunkOverlap(Number(e.target.value) || 0)}
                    className="w-24 px-2 py-1.5 text-sm border rounded-md bg-background"
                  />
                </label>

                <div className="flex-1" />

                <Button size="sm" variant="outline" onClick={() => setShowUrl(true)}>
                  <LinkIcon className="size-4 mr-1" /> URL 抓取
                </Button>
                <Button size="sm" variant="outline" onClick={handleRebuild} disabled={rebuilding}>
                  <RefreshCw className={`size-4 mr-1 ${rebuilding ? 'animate-spin' : ''}`} />
                  {rebuilding ? '重建中…' : '重建索引'}
                </Button>
                <label className="cursor-pointer">
                  <input
                    type="file"
                    data-testid="kb-upload-input"
                    accept=".md,.markdown,.txt,.pdf,.docx,.html,.htm,.csv,.tsv,.json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleUpload(f);
                      e.target.value = '';
                    }}
                  />
                  <Button size="sm" data-testid="kb-upload-button">
                    <Upload className="size-4 mr-1" /> 上传文档
                  </Button>
                </label>
              </div>

              <div className="text-xs text-muted-foreground">
                支持 .md / .txt / .pdf / .docx / .html / .csv / .json / URL，单文件 ≤ 20MB。
                上传后先解析，再按上述配置切块并向量化，整个过程在后台进行。
              </div>

              {docs.length === 0 ? (
                <div className="text-sm text-muted-foreground">暂无文档，点击「上传文档」添加。</div>
              ) : (
                <div className="space-y-1">
                  {docs.map((d) => {
                    const status = d.parse_status ?? 'ready';
                    return (
                      <div
                        key={d.id}
                        data-testid="kb-doc-row"
                        className="flex items-center justify-between py-2 border-b last:border-0 gap-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate flex items-center gap-2">
                            <span className="truncate">{d.filename}</span>
                            <span
                              data-testid="kb-doc-status"
                              className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${STATUS_STYLE[status] ?? STATUS_STYLE.pending}`}
                            >
                              {STATUS_LABEL[status] ?? status}
                            </span>
                            {d.parser_type && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 shrink-0">
                                {d.parser_type}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {(d.size_bytes / 1024).toFixed(1)} KB · 分块 {d.chunk_count ?? 0} ·
                            已向量化 {d.embedded_chunk_count ?? 0} · {d.created_at}
                          </div>
                          {d.error_message && (
                            <div className="text-xs text-red-600 mt-0.5">失败原因：{d.error_message}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {PENDING_STATUSES.has(status) && (
                            <Button size="sm" variant="ghost" onClick={() => void cancelIngest(d.id)}>
                              取消
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            title="查看分块"
                            onClick={() => {
                              setSelectedDoc(d.id);
                              setTab('chunks');
                            }}
                          >
                            <Layers className="size-4 text-teal-600" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="重新分块"
                            onClick={async () => {
                              if (await reparseDocument(d.id, chunkCfg())) {
                                toast.success('已重新提交处理');
                                await refreshDocs();
                              } else toast.error('重新处理失败');
                            }}
                          >
                            <RefreshCw className="size-4 text-blue-600" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="删除"
                            onClick={async () => {
                              if (!confirm(`删除文档 ${d.filename}？`)) return;
                              if (await removeDocument(id, d.id)) {
                                toast.success('已删除');
                                if (selectedDoc === d.id) setSelectedDoc(null);
                                await refreshDocs();
                              } else toast.error('删除失败');
                            }}
                          >
                            <Trash2 className="size-4 text-red-500" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {tab === 'chunks' && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">选择文档：</span>
                <select
                  data-testid="kb-doc-select"
                  className="px-2 py-1.5 text-sm border rounded-md bg-background min-w-[240px]"
                  value={selectedDoc ?? ''}
                  onChange={(e) => setSelectedDoc(e.target.value || null)}
                >
                  <option value="">— 请选择 —</option>
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.filename}（{d.chunk_count ?? 0} 块）
                    </option>
                  ))}
                </select>
              </div>
              {selectedDoc ? (
                <KbChunkViewer docId={selectedDoc} />
              ) : (
                <div className="text-sm text-muted-foreground">选择一份文档以查看其分块。</div>
              )}
            </CardContent>
          </Card>
        )}

        {tab === 'faq' && kb && <KbFaqPanel kb={kb} />}

        {tab === 'search' && (
          <Card>
            <CardContent className="p-4">
              <KbSearchLab kbId={id} isFaq={isFaq} />
            </CardContent>
          </Card>
        )}

        {tab === 'chat' && (
          <Card>
            <CardContent className="p-4">
              <KbChatPanel kbId={id} isFaq={isFaq} />
            </CardContent>
          </Card>
        )}
      </div>

      {showUrl && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => setShowUrl(false)}
        >
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <CardContent className="p-4 space-y-3">
              <div className="font-semibold">从 URL 抓取文档</div>
              <div className="text-xs text-muted-foreground">
                15s 超时，1MB 文本上限，自动剥离 script/style/nav/footer
              </div>
              <input
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                placeholder="https://example.com/article"
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleUrl()}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowUrl(false)}>
                  取消
                </Button>
                <Button size="sm" onClick={handleUrl}>
                  <Zap className="size-4 mr-1" /> 抓取
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
