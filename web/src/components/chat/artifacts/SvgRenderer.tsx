/**
 * SVG renderer. Renders inline SVG markup as an <img> with a data URL.
 *
 * If the SVG contains <script> tags or external references (which <img>
 * would silently drop), falls back to a sandboxed iframe so the user can
 * still see the intended behavior without leaking DOM access to the parent.
 */
import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
}

export function SvgRenderer({ source }: Props) {
  const content = source.inlineContent ?? '';
  const hasScript = useMemo(
    () => /<script\b/i.test(content) || /<use\b[^>]*href\s*=\s*["']https?:/i.test(content) || /<image\b[^>]*href\s*=\s*["']https?:/i.test(content),
    [content],
  );

  if (!content && source.filePath) {
    // File-backed SVG: just use <img> with the preview URL.
    // The /preview endpoint returns image/svg+xml inline.
    // We can't build the URL here without the hook; ArtifactRenderer passes
    // resolved url via source.previewUrl when needed. For now, fall back to
    // rendering an <img> through the parent's url construction.
    return null;
  }

  if (!content) return null;

  const sanitized = DOMPurify.sanitize(content, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    FORBID_TAGS: hasScript ? [] : ['script'],
  });
  const encoded = encodeURIComponent(sanitized);
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encoded}`;

  if (hasScript) {
    // Need sandbox iframe so scripts can run but stay isolated
    return (
      <iframe
        title={source.fileName || 'SVG artifact'}
        srcDoc={sanitized}
        sandbox="allow-scripts"
        className="w-full bg-white"
        style={{ minHeight: '300px', border: 'none' }}
      />
    );
  }

  return (
    <div className="flex items-center justify-center bg-[repeating-conic-gradient(#f5f5f5_0%_25%,white_0%_50%)] bg-[length:16px_16px] p-3">
      <img
        src={dataUrl}
        alt={source.alt || source.fileName || 'SVG'}
        className="max-w-full max-h-[600px] object-contain"
        style={{ background: 'white' }}
      />
    </div>
  );
}
