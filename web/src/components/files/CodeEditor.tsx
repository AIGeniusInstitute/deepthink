/**
 * Monaco-based code editor overlay for FilePanel.
 * 提供语法高亮、行号、折叠、可编辑保存，支持 100+ 语言（见 language-map）。
 * 同时承担"代码文件预览"与"编辑保存"两种用途（editable=true/false）。
 */
import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Editor from '@monaco-editor/react';
import {
  FileCode,
  Save,
  Loader2,
  X,
  Pencil,
  Eye,
} from 'lucide-react';
import { useFileStore, type FileEntry } from '../../stores/files';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { Button } from '@/components/ui/button';
import { extToLanguage } from './language-map';

interface Props {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
  /** 默认可编辑；false 则只读预览 */
  editable?: boolean;
}

export function CodeEditor({ groupJid, file, onClose, editable = true }: Props) {
  const { getFileContent, saveFileContent } = useFileStore();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editMode, setEditMode] = useState(editable);

  useEscapeKey(onClose);

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const language = extToLanguage(ext);

  const load = useCallback(async () => {
    setLoading(true);
    const text = await getFileContent(groupJid, file.path);
    if (text !== null) setContent(text);
    setLoading(false);
  }, [groupJid, file.path, getFileContent]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    const ok = await saveFileContent(groupJid, file.path, content);
    setSaving(false);
    if (ok) setDirty(false);
  }, [dirty, saving, groupJid, file.path, content, saveFileContent]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  const isDark =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');

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
            <FileCode className="w-4 h-4 text-emerald-500" />
            <span className="font-medium text-foreground text-sm truncate">
              {file.name}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
              {language}
            </span>
            {dirty && (
              <span className="text-xs text-amber-500 flex-shrink-0">未保存</span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {editMode ? (
              <>
                <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  <Save className="w-3.5 h-3.5" />
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditMode(false)}
                  title="切换为只读预览"
                >
                  <Eye className="w-3.5 h-3.5" />
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditMode(true)}
                title="编辑"
              >
                <Pencil className="w-3.5 h-3.5" />
                编辑
              </Button>
            )}
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted cursor-pointer"
              aria-label="关闭"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Editor
              height="100%"
              language={language}
              value={content}
              theme={isDark ? 'vs-dark' : 'light'}
              loading={<Loader2 className="w-5 h-5 animate-spin" />}
              options={{
                readOnly: !editMode,
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                tabSize: 2,
                automaticLayout: true,
              }}
              onMount={() => {}}
              onChange={(val) => {
                const next = val ?? '';
                setContent((prev) => {
                  if (prev !== next) setDirty(true);
                  return next;
                });
              }}
            />
          )}
        </div>

        <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground flex-shrink-0">
          {editMode ? 'Ctrl/Cmd+S 保存 · Esc 关闭' : '只读预览 · 点击「编辑」可修改'}
        </div>
      </div>
    </div>,
    document.body,
  );
}
