/**
 * Office 文件预览/编辑覆盖层（docx / xlsx / pptx）。
 *
 * 设计（见 docs/tech_solution F1+F2）：
 * - xlsx：SheetJS 解析 → 多 sheet 表格预览；编辑模式 contenteditable；保存用
 *   XLSX.utils.table_to_sheet + XLSX.write 导出 .xlsx 写回（PUT /files/binary）。
 * - docx：mammoth 转 HTML 预览；编辑模式 contenteditable；保存用 html-docx-js
 *   将 innerHTML 转为 .docx 写回（有损，简单文档可用）。
 * - pptx：LibreOffice 可用时 /convert → PDF iframe 预览；否则下载提示。
 *   pptx 编辑需 OnlyOffice（未配置时明确提示），不在本组件实现编辑。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  Presentation,
  Table as TableIcon,
  Download,
  Save,
  Loader2,
  X,
  Pencil,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import { useFileStore, type FileEntry, toBase64Url } from '../../stores/files';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { withBasePath } from '../../utils/url';
import { downloadFromUrl } from '../../utils/download';
import { showToast } from '../../utils/toast';
import { Button } from '@/components/ui/button';

type Kind = 'docx' | 'xlsx' | 'pptx';

interface Props {
  groupJid: string;
  file: FileEntry;
  kind: Kind;
  onClose: () => void;
}

function buildUrl(jid: string, filePath: string, seg: 'preview' | 'convert' | 'download') {
  return withBasePath(
    `/api/groups/${encodeURIComponent(jid)}/files/${seg}/${toBase64Url(filePath)}`,
  );
}

// ─── xlsx ───────────────────────────────────────────────────────

interface SheetData {
  name: string;
  rows: string[][];
}
const XLSX_MAX_ROWS = 1000;

function XlsxBody({
  sheets,
  active,
  editMode,
  tableRef,
}: {
  sheets: SheetData[];
  active: number;
  editMode: boolean;
  tableRef: React.RefObject<HTMLTableElement | null>;
}) {
  const sheet = sheets[active];
  if (!sheet) return null;
  const [header, ...body] = sheet.rows;
  const maxCols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0);
  return (
    <table ref={tableRef} className="min-w-full border-collapse text-sm" contentEditable={editMode} suppressContentEditableWarning>
      {header && (
        <thead className="bg-muted sticky top-0">
          <tr>
            {Array.from({ length: maxCols }).map((_, i) => (
              <th key={i} className="px-3 py-1.5 text-left font-semibold border border-border whitespace-nowrap">
                {header[i] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody className="divide-y divide-border">
        {body.map((r, i) => (
          <tr key={i} className="odd:bg-muted/20">
            {Array.from({ length: maxCols }).map((_, j) => (
              <td key={j} className="px-3 py-1.5 border border-border whitespace-nowrap align-top">
                {r[j] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── OfficeFileOverlay ──────────────────────────────────────────

export function OfficeFileOverlay({ groupJid, file, kind, onClose }: Props) {
  const { saveFileBinary, saveHtmlAsDocx } = useFileStore();
  useEscapeKey(onClose);

  // shared state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // xlsx
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const xlsxTableRef = useRef<HTMLTableElement | null>(null);
  // docx
  const [docxHtml, setDocxHtml] = useState('');
  const docxRef = useRef<HTMLDivElement | null>(null);
  // pptx
  const [libreOk, setLibreOk] = useState<boolean | null>(null);
  const [pptxSrc, setPptxSrc] = useState<string | null>(null);

  const previewUrl = buildUrl(groupJid, file.path, 'preview');
  const convertUrl = buildUrl(groupJid, file.path, 'convert');
  const downloadUrl = buildUrl(groupJid, file.path, 'download');

  const loadXlsx = useCallback(async () => {
    setLoading(true);
    try {
      const [mod, res] = await Promise.all([import('xlsx'), fetch(previewUrl)]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const XLSX = (mod as any).default ?? mod;
      const wb = XLSX.read(buf, { type: 'array' });
      const data: SheetData[] = wb.SheetNames.map((name: string) => {
        const ws = wb.Sheets[name];
        const rows: string[][] = XLSX.utils.sheet_to_json(ws, {
          header: 1,
          raw: false,
          defval: '',
        });
        const truncated = rows.length > XLSX_MAX_ROWS;
        return { name, rows: truncated ? rows.slice(0, XLSX_MAX_ROWS) : rows };
      });
      setSheets(data);
      setActiveSheet(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'parse failed');
    } finally {
      setLoading(false);
    }
  }, [previewUrl]);

  const loadDocx = useCallback(async () => {
    setLoading(true);
    try {
      const [mod, res] = await Promise.all([import('mammoth/mammoth.browser.js'), fetch(previewUrl)]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const mammoth = (mod as any).default ?? mod;
      const result = await mammoth.convertToHtml({ arrayBuffer: buf });
      setDocxHtml(DOMPurify.sanitize(result.value || ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'parse failed');
    } finally {
      setLoading(false);
    }
  }, [previewUrl]);

  const loadPptx = useCallback(async () => {
    setLoading(true);
    try {
      const statusRes = await fetch(
        withBasePath(`/api/groups/${encodeURIComponent(groupJid)}/files/libreoffice-status`),
      );
      const status = await statusRes.json().catch(() => ({ available: false }));
      setLibreOk(!!status.available);
      if (status.available) setPptxSrc(convertUrl);
    } catch {
      setLibreOk(false);
    } finally {
      setLoading(false);
    }
  }, [convertUrl, groupJid]);

  useEffect(() => {
    if (kind === 'xlsx') loadXlsx();
    else if (kind === 'docx') loadDocx();
    else loadPptx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const reload = () => {
    setError(null);
    setDirty(false);
    setEditMode(false);
    if (kind === 'xlsx') loadXlsx();
    else if (kind === 'docx') loadDocx();
    else loadPptx();
  };

  // ── 保存 ──
  const handleSaveXlsx = async () => {
    if (!xlsxTableRef.current) return;
    setSaving(true);
    try {
      const XLSX = await import('xlsx');
      const X = (XLSX as any).default ?? XLSX;
      // 从当前 sheet 的 DOM 表格构建 worksheet
      const ws = X.utils.table_to_sheet(xlsxTableRef.current);
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, ws, sheets[activeSheet]?.name || 'Sheet1');
      // 其余 sheet 用已缓存数据追加（仅当前 sheet 被编辑）
      sheets.forEach((s, i) => {
        if (i === activeSheet) return;
        const w = X.utils.aoa_to_sheet(s.rows);
        X.utils.book_append_sheet(wb, w, s.name);
      });
      const out: ArrayBuffer = X.write(wb, { bookType: 'xlsx', type: 'array' });
      const ok = await saveFileBinary(groupJid, file.path, out);
      if (ok) {
        setDirty(false);
        showToast('已保存', `${file.name} 已写回`);
        await loadXlsx();
        setEditMode(false);
      } else {
        showToast('保存失败', '写回 xlsx 失败');
      }
    } catch (err) {
      showToast('保存失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDocx = async () => {
    if (!docxRef.current) return;
    setSaving(true);
    try {
      const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{font-family: Calibri, 'Microsoft YaHei', sans-serif; font-size: 11pt;}
        h1{font-size:18pt} h2{font-size:14pt} h3{font-size:12pt}
      </style></head><body>${docxRef.current.innerHTML}</body></html>`;
      const ok = await saveHtmlAsDocx(groupJid, file.path, fullHtml);
      if (ok) {
        setDirty(false);
        showToast('已保存', `${file.name} 已写回（docx，由后端 LibreOffice 转换）`);
        await loadDocx();
        setEditMode(false);
      } else {
        showToast('保存失败', '写回 docx 失败（需后端安装 LibreOffice）');
      }
    } catch (err) {
      showToast('保存失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (kind === 'xlsx') handleSaveXlsx();
    else if (kind === 'docx') handleSaveDocx();
  };

  const Icon = kind === 'docx' ? FileText : kind === 'xlsx' ? TableIcon : Presentation;
  const title = kind === 'docx' ? 'Word 文档' : kind === 'xlsx' ? 'Excel 表格' : 'PowerPoint';
  const editable = kind !== 'pptx';

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3 lg:p-6"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-xl shadow-xl w-full max-w-5xl h-[85vh] supports-[height:100dvh]:h-[85dvh] flex flex-col animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="w-4 h-4 text-blue-500 flex-shrink-0" />
            <span className="font-medium text-foreground text-sm truncate">{file.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">{title}</span>
            {dirty && <span className="text-xs text-amber-500">未保存</span>}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {editable && (
              editMode ? (
                <>
                  <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
                    {saving && <Loader2 className="size-4 animate-spin" />}
                    <Save className="w-3.5 h-3.5" />
                    保存
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditMode(false); reload(); }} title="取消编辑">
                    取消
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditMode(true)} title="编辑">
                    <Pencil className="w-3.5 h-3.5" />
                    编辑
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => downloadFromUrl(downloadUrl, file.name)} title="下载原文件">
                    <Download className="w-3.5 h-3.5" />
                  </Button>
                </>
              )
            )}
            {kind === 'pptx' && (
              <Button size="sm" variant="ghost" onClick={() => downloadFromUrl(downloadUrl, file.name)} title="下载">
                <Download className="w-3.5 h-3.5" />
                下载
              </Button>
            )}
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted cursor-pointer" aria-label="关闭">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <AlertCircle className="w-10 h-10" />
              <p className="text-sm">{title} 加载失败：{error}</p>
              <Button size="sm" variant="ghost" onClick={reload}>
                <RefreshCw className="w-3.5 h-3.5" /> 重试
              </Button>
            </div>
          ) : kind === 'xlsx' ? (
            <div className="flex flex-col h-full">
              {sheets.length > 1 && (
                <div className="flex border-b border-border bg-muted/30 overflow-x-auto">
                  {sheets.map((s, i) => (
                    <button key={s.name} onClick={() => setActiveSheet(i)}
                      className={`px-3 py-1.5 text-xs whitespace-nowrap border-r border-border ${i === activeSheet ? 'bg-background text-foreground font-medium border-b-2 border-b-primary' : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'}`}>
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="overflow-auto p-2">
                <XlsxBody sheets={sheets} active={activeSheet} editMode={editMode} tableRef={xlsxTableRef} />
              </div>
              {editMode && (
                <div className="px-3 py-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 border-t border-amber-200">
                  编辑模式：直接点击单元格修改；保存将当前 sheet 写回 .xlsx。其余 sheet 保持原数据。
                </div>
              )}
            </div>
          ) : kind === 'docx' ? (
            <div className="p-6">
              <div
                ref={docxRef}
                contentEditable={editMode}
                suppressContentEditableWarning
                onInput={() => setDirty(true)}
                className="prose prose-sm dark:prose-invert max-w-none focus:outline-none"
                style={{ minHeight: '60vh' }}
                dangerouslySetInnerHTML={{ __html: docxHtml }}
              />
              {editMode && (
                <div className="mt-3 px-3 py-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 rounded">
                  编辑模式：直接修改正文；保存为 .docx（html→docx 转换对复杂排版有损，建议用于简单文档）。
                </div>
              )}
            </div>
          ) : (
            // pptx
            <div className="h-full flex flex-col">
              {pptxSrc ? (
                <iframe src={pptxSrc} className="w-full flex-1 border-0" title="pptx preview" />
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                  <AlertCircle className="w-10 h-10" />
                  <p className="text-sm">
                    {libreOk === false
                      ? 'LibreOffice 不可用，无法将 pptx 转为 PDF 预览。'
                      : 'pptx 预览不可用。'}
                  </p>
                  <p className="text-xs">pptx 在线编辑需要 OnlyOffice（未配置）。可下载后本地编辑。</p>
                  <Button size="sm" variant="ghost" onClick={() => downloadFromUrl(downloadUrl, file.name)}>
                    <Download className="w-3.5 h-3.5" /> 下载原文件
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground flex-shrink-0">
          {kind === 'pptx'
            ? 'pptx 预览（LibreOffice→PDF）· 编辑需 OnlyOffice · Esc 关闭'
            : editMode
              ? '直接修改内容 · 保存写回原文件 · Esc 关闭'
              : `${title} 预览 · 点击「编辑」可修改 · Esc 关闭`}
        </div>
      </div>
    </div>,
    document.body,
  );
}
