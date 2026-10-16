import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common/PageHeader';
import { toast } from 'sonner';
import {
  ArrowLeft,
  FileText,
  FolderUp,
  HelpCircle,
  Layers,
  Link as LinkIcon,
  MessageSquare,
  PenLine,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { useKnowledgeBasesStore, type KbDocumentMeta } from '@/stores/knowledge-bases';
import {
  collectDroppedFiles,
  collectFromInput,
  mapWithConcurrency,
} from '@/lib/collect-dropped-files';
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

/** 非终态即仍需轮询。`ocr` 也在其中 —— 扫描件识别要几十分钟，列表必须持续刷新。 */
const PENDING_STATUSES = new Set(['pending', 'parsing', 'ocr', 'chunking', 'embedding']);

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  pending: 'bg-slate-100 text-slate-600',
  parsing: 'bg-blue-100 text-blue-700',
  ocr: 'bg-amber-100 text-amber-700',
  chunking: 'bg-blue-100 text-blue-700',
  embedding: 'bg-indigo-100 text-indigo-700',
};

const STATUS_LABEL: Record<string, string> = {
  ready: '就绪',
  failed: '失败',
  pending: '排队中',
  parsing: '解析中',
  ocr: 'OCR 识别中',
  chunking: '分块中',
  embedding: '向量化中',
};

/** parser_type 是内部标识，界面上换成用户看得懂的说法。 */
const PARSER_LABEL: Record<string, string> = {
  pdf_ocr: 'PDF·OCR',
  url: '网页',
};

/**
 * 单文件选择框能选什么。目录上传与拖拽不受此限制 —— `accept` 只作用于那个
 * input，拖进来的东西照样逐个判类型，判不出来的会出现在结果清单里。
 */
const UPLOAD_ACCEPT =
  '.md,.markdown,.txt,.pdf,.docx,.pptx,.xlsx,.epub,.xmind,.html,.htm,.csv,.tsv,.json,.zip';

/** 上传后半段（解析 + 入库）是 CPU 密集的，并发按 3 走。 */
const UPLOAD_CONCURRENCY = 3;

/** 一次目录/拖拽上传里单个文件的处理结果，逐条展示给用户。 */
interface UploadOutcome {
  path: string;
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
}

export function KnowledgeBaseDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const {
    list,
    load,
    listDocuments,
    uploadDocument,
    uploadFromUrl,
    createTextDocument,
    uploadArchive,
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
  const [parentChild, setParentChild] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // 批量上传的现场：进度 + 逐条结果。用户必须能看到「200 个里坏了哪 3 个、为什么」，
  // 所以这里存的不是计数器而是完整清单。
  const [batch, setBatch] = useState<{
    total: number;
    done: number;
    outcomes: UploadOutcome[];
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showText, setShowText] = useState(false);
  const [textTitle, setTextTitle] = useState('');
  const [textBody, setTextBody] = useState('');
  const [savingText, setSavingText] = useState(false);

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

  // `webkitdirectory` 不是标准 DOM 属性，React 的 JSX 不认它（写了也不生效），
  // 只能挂载后直接设到元素上。设了它之后这个 input 就只能选目录、不能选单个文件。
  //
  // 这里**必须用 ref 回调，不能用 useEffect(..., [])**：文档页签是
  // `{tab === 'documents' && ...}` 条件渲染的，切到「检索测试台」再切回来时，
  // 这个 input 是被卸载后重新挂载的**新节点**，而 [] 依赖的 effect 只跑过首次挂载那一次 ——
  // 结果就是新节点上没有 webkitdirectory，「上传目录」静默退化成普通的多选文件框，
  // 用户选完目录拿不到任何文件（选文件则丢掉相对路径），页面上没有任何报错。
  const attachDirInput = useCallback((el: HTMLInputElement | null) => {
    dirInputRef.current = el;
    if (el) el.setAttribute('webkitdirectory', '');
  }, []);

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
    parent_child: parentChild,
  });

  const handleUpload = async (file: File) => {
    // `.zip` 必须走整包端点。送到单文件端点的话，zip 的 magic 会被认成 docx、
    // 然后 mammoth 报「DOCX 没有可提取文本」—— 用户完全看不懂哪里不对。
    if (file.name.toLowerCase().endsWith('.zip')) {
      await handleBatchUpload([file]);
      return;
    }
    const res = await uploadDocument(id, file, chunkCfg());
    if (res.ok) {
      toast.success(
        res.ocr
          ? '已上传。这是扫描件，正在后台 OCR 识别，耗时取决于页数，可在列表中查看进度'
          : '已上传，正在后台解析与分块',
      );
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

  /**
   * 逐条上传一批文件（来自目录选择或拖拽）。
   *
   * 不做成一个批量请求：任何一个失败就不知道是哪个，而重试天然应该按文件粒度。
   * 逐条调既有的单文件端点，扫描件 OCR 分流这些既有行为一并复用。
   */
  const handleBatchUpload = async (files: File[]) => {
    if (files.length === 0) {
      toast.error('没有找到可上传的文件（隐藏文件与空目录会被跳过）');
      return;
    }
    const outcomes: UploadOutcome[] = [];
    // `done` 与 `outcomes.length` 不是一回事：一个 zip 会展开成多行结果，
    // 而进度要按**输入文件数**走。
    let done = 0;
    const publish = () => setBatch({ total: files.length, done, outcomes: [...outcomes] });
    publish();

    await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file) => {
      const path = file.webkitRelativePath || file.name;
      // zip 走服务端解包：500MB 的包不该在浏览器里解，而且回执是逐条的。
      if (path.toLowerCase().endsWith('.zip')) {
        const res = await uploadArchive(id, file);
        const summary = res?.summary ?? { added: 0, skipped: 0, failed: 0 };
        outcomes.push({
          path,
          status: summary.failed > 0 ? 'failed' : summary.added > 0 ? 'ok' : 'skipped',
          detail: `解包后：入库 ${summary.added} · 跳过 ${summary.skipped} · 失败 ${summary.failed}`,
        });
        // 包内每个条目的成败也逐条列出来，否则用户只知道"这个 zip 有问题"。
        for (const entry of [
          ...(res?.failed ?? []).map((e) => ({ ...e, status: 'failed' as const })),
          ...(res?.skipped ?? []).map((e) => ({ ...e, status: 'skipped' as const })),
        ]) {
          outcomes.push({
            path: `${path} › ${entry.path}`,
            status: entry.status,
            detail: entry.reason,
          });
        }
      } else {
        const res = await uploadDocument(id, file, chunkCfg());
        outcomes.push({
          path,
          status: res.ok ? 'ok' : 'failed',
          detail: res.ok ? (res.ocr ? '扫描件，已转后台 OCR' : undefined) : res.error,
        });
      }
      done++;
      publish();
    });

    await refreshDocs();
    const ok = outcomes.filter((o) => o.status === 'ok').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    const skipped = outcomes.filter((o) => o.status === 'skipped').length;
    if (failed > 0) {
      toast.error(`完成：成功 ${ok} · 跳过 ${skipped} · 失败 ${failed}（明细见下方清单）`);
    } else {
      toast.success(`完成：成功 ${ok}${skipped ? ` · 跳过 ${skipped}` : ''}`);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // 必须走 webkitGetAsEntry 递归：拖文件夹时 `dataTransfer.files` 里
    // Chrome 放的是 size 为 0 的假条目、Firefox 干脆是空的。详见该模块注释。
    const files = await collectDroppedFiles(e.dataTransfer);
    await handleBatchUpload(files);
  };

  const handleSaveText = async () => {
    if (!textTitle.trim() || !textBody.trim()) {
      toast.error('标题和正文都不能为空');
      return;
    }
    setSavingText(true);
    const res = await createTextDocument(id, textTitle.trim(), textBody);
    setSavingText(false);
    if (res.ok) {
      toast.success('已保存，正在后台分块与向量化');
      setShowText(false);
      setTextTitle('');
      setTextBody('');
      await refreshDocs();
    } else {
      toast.error(res.error ?? '保存失败');
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

                <label className="flex items-center gap-1.5 text-xs select-none cursor-pointer pb-1.5">
                  <input
                    type="checkbox"
                    data-testid="kb-parent-child"
                    className="size-4 accent-teal-600"
                    checked={parentChild}
                    onChange={(e) => setParentChild(e.target.checked)}
                  />
                  父子分块
                </label>

                <div className="flex-1" />

                <Button size="sm" variant="outline" onClick={() => setShowUrl(true)}>
                  <LinkIcon className="size-4 mr-1" /> URL 抓取
                </Button>
                <Button size="sm" variant="outline" onClick={handleRebuild} disabled={rebuilding}>
                  <RefreshCw className={`size-4 mr-1 ${rebuilding ? 'animate-spin' : ''}`} />
                  {rebuilding ? '重建中…' : '重建索引'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="kb-upload-text-button"
                  onClick={() => setShowText(true)}
                >
                  <PenLine className="size-4 mr-1" /> 手写 Markdown
                </Button>

                {/* 不能用 <label> 包 <Button> 来触发文件选择：<button> 是 interactive content，
                    规范要求 <label> 对它的点击「什么都不做」，于是点击被吞掉、文件框不弹。
                    改用显式转发，与仓库其余 5 处 file input 写法一致。 */}
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    data-testid="kb-upload-input"
                    accept={UPLOAD_ACCEPT}
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleUpload(f);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    size="sm"
                    data-testid="kb-upload-button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="size-4 mr-1" /> 上传文档
                  </Button>
                </div>

                <div>
                  {/* webkitdirectory 让这个 input 变成"选目录"，选中的每个文件都带
                      webkitRelativePath —— 相对路径就是这么保住的。React 不认这个
                      非标准属性，只能等挂载后直接设到 DOM 上。 */}
                  <input
                    ref={attachDirInput}
                    type="file"
                    data-testid="kb-upload-dir-input"
                    className="hidden"
                    onChange={(e) => {
                      const files = collectFromInput(e.target.files);
                      e.target.value = '';
                      void handleBatchUpload(files);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="kb-upload-dir-button"
                    onClick={() => dirInputRef.current?.click()}
                  >
                    <FolderUp className="size-4 mr-1" /> 上传目录
                  </Button>
                </div>
              </div>

              {/* 拖拽区。用 onDragOver 的 preventDefault 打开 drop 的接收，
                  否则浏览器默认行为是直接打开这个文件。 */}
              <div
                data-testid="kb-dropzone"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => void handleDrop(e)}
                className={`rounded-lg border border-dashed px-4 py-3 text-xs transition-colors ${
                  dragging
                    ? 'border-teal-500 bg-teal-50 text-teal-800'
                    : 'border-muted-foreground/25 text-muted-foreground'
                }`}
              >
                {dragging
                  ? '松手即上传'
                  : '把文件或整个目录拖到这里也可以上传（目录会递归读取，隐藏项自动跳过）'}
              </div>

              {batch && (
                <div
                  data-testid="kb-upload-result"
                  className="rounded-lg border bg-muted/30 px-3 py-2 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      上传进度 {batch.done}/{batch.total}
                      {' · '}
                      成功 {batch.outcomes.filter((o) => o.status === 'ok').length}
                      {' · '}
                      跳过 {batch.outcomes.filter((o) => o.status === 'skipped').length}
                      {' · '}
                      失败 {batch.outcomes.filter((o) => o.status === 'failed').length}
                    </span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setBatch(null)}
                    >
                      收起
                    </button>
                  </div>
                  {/* 逐条列出 —— 一次性把 200 个打包成"成功/失败"是不可接受的。 */}
                  <div className="max-h-48 overflow-auto space-y-0.5">
                    {batch.outcomes.map((o, i) => (
                      <div key={`${o.path}-${i}`} className="flex items-start gap-2">
                        <span
                          className={
                            o.status === 'ok'
                              ? 'text-emerald-600'
                              : o.status === 'skipped'
                                ? 'text-amber-600'
                                : 'text-red-600'
                          }
                        >
                          {o.status === 'ok' ? '✓' : o.status === 'skipped' ? '⊘' : '✕'}
                        </span>
                        <span className="font-mono break-all">{o.path}</span>
                        {o.detail && <span className="text-muted-foreground">— {o.detail}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="text-xs text-muted-foreground">
                支持 .md / .txt / .pdf / .docx / .pptx / .xlsx / .epub / .xmind / .html / .csv /
                .json / .zip / URL，单文件 ≤ 100MB。
                上传后先解析，再按上述配置切块并向量化，整个过程在后台进行。
                勾选「父子分块」会先按小节切出父块、再在父块内切子块，检索单元是子块、
                命中后可用父块补足上下文（父块本身不参与向量化）。
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
                                {PARSER_LABEL[d.parser_type] ?? d.parser_type}
                              </span>
                            )}
                            {/* OCR 是分钟级操作，只给一个转圈用户无法判断是卡死还是在跑，
                                所以把 parse_stage 里的 `ocr 12/287` 直接摊开显示。 */}
                            {status === 'ocr' && d.parse_stage ? (
                              <span
                                data-testid="kb-doc-ocr-progress"
                                className="text-xs text-amber-700 shrink-0"
                              >
                                {d.parse_stage}
                              </span>
                            ) : null}
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

      {showText && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => setShowText(false)}
        >
          <Card
            className="w-full max-w-2xl"
            data-testid="kb-text-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <CardContent className="p-4 space-y-3">
              <div className="font-semibold">手写 Markdown</div>
              <div className="text-xs text-muted-foreground">
                不落盘，直接入库。分块与向量化和文件上传完全一致 —— 用 <code>#</code>{' '}
                标题划分小节，配合「heading」分块策略效果最好。
              </div>
              <input
                data-testid="kb-text-title"
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                placeholder="文档标题（也是列表里显示的名字）"
                value={textTitle}
                onChange={(e) => setTextTitle(e.target.value)}
              />
              <textarea
                data-testid="kb-text-body"
                className="w-full h-72 px-3 py-2 border rounded-md bg-background text-sm font-mono"
                placeholder={'# 小节标题\n\n正文…'}
                value={textBody}
                onChange={(e) => setTextBody(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowText(false)}>
                  取消
                </Button>
                <Button
                  size="sm"
                  data-testid="kb-text-save"
                  disabled={savingText}
                  onClick={handleSaveText}
                >
                  {savingText ? '保存中…' : '保存入库'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
