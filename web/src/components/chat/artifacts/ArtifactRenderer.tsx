/**
 * ArtifactRenderer — unified entry point for rendering all artifact types.
 *
 * Dispatches by `kind` to the appropriate renderer, wraps each one in a
 * card with ArtifactToolbar, and provides expand/collapse + fullscreen.
 *
 * Designed to be called from MarkdownRenderer (code-block, image, link
 * entry points) — not exported to MessageBubble directly, since message
 * attachments already have their own rendering path.
 */
import { useState, Suspense, lazy, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { ArtifactKind, ArtifactSource } from './types';
import { ArtifactToolbar, type ArtifactCapabilities } from './ArtifactToolbar';
import { useArtifactUrl } from './useArtifactUrl';
import { SvgRenderer } from './SvgRenderer';
import { HtmlRenderer } from './HtmlRenderer';
import { PdfRenderer } from './PdfRenderer';
import { MediaRenderer } from './MediaRenderer';
import { CodeRenderer } from './CodeRenderer';
import { TextRenderer } from './TextRenderer';
import { CsvRenderer } from './CsvRenderer';
import { JsonRenderer } from './JsonTreeRenderer';
import { MarkdownFileRenderer } from './MarkdownFileRenderer';
import { PptxRenderer } from './PptxRenderer';

// Lazy-load heavy renderers (their third-party libs are dynamically imported
// inside, but we also lazy-load the component code itself so even the
// component definition isn't pulled into the initial bundle).
const DocxRenderer = lazy(() => import('./DocxRenderer').then(m => ({ default: m.DocxRenderer })));
const XlsxRenderer = lazy(() => import('./XlsxRenderer').then(m => ({ default: m.XlsxRenderer })));

interface Props {
  kind: ArtifactKind;
  source: ArtifactSource;
  /** Group JID context for resolving relative file paths */
  groupJid?: string;
}

function capabilitiesFor(kind: ArtifactKind): ArtifactCapabilities {
  switch (kind) {
    case 'pdf':
      return { download: true, copySource: false, openNewTab: true, fullscreen: true, expandable: false };
    case 'docx':
      return { download: true, copySource: false, openNewTab: false, fullscreen: true, expandable: false };
    case 'xlsx':
      return { download: true, copySource: false, openNewTab: false, fullscreen: true, expandable: true };
    case 'pptx':
      return { download: true, copySource: false, openNewTab: true, fullscreen: false, expandable: false };
    case 'video':
      return { download: true, copySource: false, openNewTab: false, fullscreen: true, expandable: false };
    case 'audio':
      return { download: true, copySource: false, openNewTab: false, fullscreen: false, expandable: false };
    case 'image':
      return { download: true, copySource: false, openNewTab: true, fullscreen: true, expandable: false };
    case 'csv':
      return { download: true, copySource: true, openNewTab: false, fullscreen: true, expandable: true };
    case 'json':
      return { download: true, copySource: true, openNewTab: false, fullscreen: true, expandable: true };
    case 'code':
      return { download: true, copySource: true, openNewTab: false, fullscreen: true, expandable: true };
    case 'text':
      return { download: true, copySource: true, openNewTab: false, fullscreen: true, expandable: true };
    case 'svg':
      return { download: true, copySource: true, openNewTab: true, fullscreen: true, expandable: false };
    case 'html':
      return { download: true, copySource: true, openNewTab: true, fullscreen: true, expandable: false };
    case 'markdown':
      return { download: true, copySource: true, openNewTab: false, fullscreen: true, expandable: true };
    default:
      return { download: true, copySource: false, openNewTab: true, fullscreen: false, expandable: false };
  }
}

function ArtifactLoading() {
  return (
    <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
      <span className="inline-block w-3 h-3 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin" />
      加载中...
    </div>
  );
}

export function ArtifactRenderer({ kind, source, groupJid }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Resolve group JID from prop or source
  const effectiveSource = useMemo<ArtifactSource>(() => ({
    ...source,
    groupJid: source.groupJid ?? groupJid,
  }), [source, groupJid]);

  const previewUrl = useArtifactUrl(effectiveSource, { endpoint: 'preview' });

  const capabilities = capabilitiesFor(kind);

  // Fullscreen portal
  const fullscreenNode = fullscreen && createPortal(
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" role="dialog" aria-modal="true">
      <div className="flex items-center justify-between px-4 py-2 bg-black/50 text-white">
        <span className="text-sm font-mono">{source.fileName || kind.toUpperCase()}</span>
        <button
          onClick={() => setFullscreen(false)}
          className="p-1.5 rounded hover:bg-white/10"
          aria-label="关闭全屏"
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        <ArtifactBody
          kind={kind}
          source={effectiveSource}
          previewUrl={previewUrl}
          fullscreen={true}
        />
      </div>
    </div>,
    document.body,
  );

  return (
    <div className="my-4 rounded-lg border border-border overflow-hidden bg-background">
      <ArtifactToolbar
        kind={kind}
        source={effectiveSource}
        capabilities={capabilities}
        expanded={expanded}
        onToggleExpand={capabilities.expandable ? () => setExpanded(e => !e) : undefined}
        onFullscreen={capabilities.fullscreen ? () => setFullscreen(true) : undefined}
      />
      <div
        className={
          capabilities.expandable && !expanded
            ? 'max-h-[600px] overflow-auto'
            : 'overflow-auto'
        }
      >
        <Suspense fallback={<ArtifactLoading />}>
          <ArtifactBody
            kind={kind}
            source={effectiveSource}
            previewUrl={previewUrl}
            fullscreen={false}
          />
        </Suspense>
      </div>
      {fullscreenNode}
    </div>
  );
}

/** Inner body — extracted so fullscreen can reuse it without the toolbar */
function ArtifactBody({
  kind,
  source,
  previewUrl,
  fullscreen,
}: {
  kind: ArtifactKind;
  source: ArtifactSource;
  previewUrl: string | null;
  fullscreen: boolean;
}) {
  switch (kind) {
    case 'svg':
      // If file-backed (no inlineContent), we need to fetch or use img with previewUrl.
      // SVG file: use <img> directly with the previewUrl (image/svg+xml inline).
      if (!source.inlineContent && previewUrl) {
        return (
          <div className="flex items-center justify-center bg-[repeating-conic-gradient(#f5f5f5_0%_25%,white_0%_50%)] bg-[length:16px_16px] p-3">
            <img
              src={previewUrl}
              alt={source.alt || source.fileName || 'SVG'}
              className="max-w-full object-contain"
              style={{ maxHeight: fullscreen ? '90vh' : '600px', background: 'white' }}
            />
          </div>
        );
      }
      return <SvgRenderer source={source} />;

    case 'html':
      if (!source.inlineContent && previewUrl) {
        // File-backed HTML: load via sandboxed iframe + URL (server returns CSP-protected inline)
        return (
          <iframe
            title={source.fileName || 'HTML artifact'}
            src={previewUrl}
            sandbox="allow-scripts allow-popups allow-forms allow-modals"
            className="w-full bg-white"
            style={{ minHeight: fullscreen ? '90vh' : '400px', border: 'none' }}
          />
        );
      }
      return <HtmlRenderer source={source} />;

    case 'pdf':
      return <PdfRenderer source={source} previewUrl={previewUrl} />;

    case 'docx':
      return <DocxRenderer source={source} previewUrl={previewUrl} />;

    case 'xlsx':
      return <XlsxRenderer source={source} previewUrl={previewUrl} />;

    case 'pptx':
      return <PptxRenderer source={source} />;

    case 'image':
      return <MediaRenderer source={source} previewUrl={previewUrl} kind="image" />;

    case 'video':
      return <MediaRenderer source={source} previewUrl={previewUrl} kind="video" />;

    case 'audio':
      return <MediaRenderer source={source} previewUrl={previewUrl} kind="audio" />;

    case 'code':
      return <CodeRenderer source={source} previewUrl={previewUrl} language={source.language} />;

    case 'text':
      return <TextRenderer source={source} previewUrl={previewUrl} />;

    case 'csv':
      return <CsvRenderer source={source} previewUrl={previewUrl} />;

    case 'json':
      return <JsonRenderer source={source} previewUrl={previewUrl} />;

    case 'markdown':
      return <MarkdownFileRenderer source={source} previewUrl={previewUrl} />;

    default:
      return (
        <div className="p-4 text-sm text-muted-foreground flex items-center gap-3">
          <span>无法预览此文件类型。</span>
          {previewUrl && (
            <a href={previewUrl} download={source.fileName} className="text-primary hover:underline">
              下载
            </a>
          )}
        </div>
      );
  }
}
