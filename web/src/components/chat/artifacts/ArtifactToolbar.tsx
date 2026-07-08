/**
 * Unified toolbar shown above every artifact body. Provides download,
 * copy-source, open-in-new-tab, fullscreen, and expand/collapse actions.
 *
 * Visibility of each action is controlled by `capabilities` so individual
 * renderers can opt out (e.g. PDF can't copy source as text).
 */
import { useState, useEffect } from 'react';
import { Copy, Check, Download, Maximize2, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import type { ArtifactKind } from './types';
import { KIND_LABEL } from './types';
import { buildDownloadUrl } from './useArtifactUrl';
import type { ArtifactSource } from './types';

export interface ArtifactCapabilities {
  download?: boolean;
  copySource?: boolean;
  openNewTab?: boolean;
  fullscreen?: boolean;
  expandable?: boolean;
}

export interface ArtifactToolbarProps {
  kind: ArtifactKind;
  source: ArtifactSource;
  sourceText?: string; // for copySource
  capabilities: ArtifactCapabilities;
  expanded: boolean;
  onToggleExpand?: () => void;
  onFullscreen?: () => void;
  className?: string;
}

export function ArtifactToolbar({
  kind,
  source,
  sourceText,
  capabilities,
  expanded,
  onToggleExpand,
  onFullscreen,
  className = '',
}: ArtifactToolbarProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    const text = sourceText ?? source.inlineContent ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  const downloadUrl = buildDownloadUrl(source);
  const fileName = source.fileName || 'artifact';

  return (
    <div
      className={`flex items-center gap-1 px-3 py-1.5 bg-muted/40 border-b border-border text-xs ${className}`}
    >
      <span className="font-mono font-medium text-muted-foreground mr-2">{KIND_LABEL[kind]}</span>
      {source.fileName && (
        <span className="text-muted-foreground/80 truncate max-w-[200px]" title={source.fileName}>
          {source.fileName}
        </span>
      )}

      <div className="flex-1" />

      {capabilities.copySource && (sourceText || source.inlineContent) && (
        <button
          onClick={handleCopy}
          className="h-6 px-1.5 rounded flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
          title="复制源码"
          aria-label="复制源码"
        >
          {copied ? <Check size={12} className="text-primary" /> : <Copy size={12} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      )}

      {capabilities.openNewTab && downloadUrl && (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="h-6 px-1.5 rounded flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
          title="在新窗口打开"
          aria-label="在新窗口打开"
        >
          <ExternalLink size={12} />
        </a>
      )}

      {capabilities.download && downloadUrl && (
        <a
          href={downloadUrl}
          download={fileName}
          className="h-6 px-1.5 rounded flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
          title="下载"
          aria-label="下载"
        >
          <Download size={12} />
        </a>
      )}

      {capabilities.fullscreen && onFullscreen && (
        <button
          onClick={onFullscreen}
          className="h-6 px-1.5 rounded flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
          title="全屏查看"
          aria-label="全屏查看"
        >
          <Maximize2 size={12} />
        </button>
      )}

      {capabilities.expandable && onToggleExpand && (
        <button
          onClick={onToggleExpand}
          className="h-6 px-1.5 rounded flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
          title={expanded ? '折叠' : '展开'}
          aria-label={expanded ? '折叠' : '展开'}
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          <span>{expanded ? '折叠' : '展开'}</span>
        </button>
      )}
    </div>
  );
}

export const DEFAULT_CAPABILITIES: ArtifactCapabilities = {
  download: true,
  copySource: true,
  openNewTab: true,
  fullscreen: true,
  expandable: true,
};
