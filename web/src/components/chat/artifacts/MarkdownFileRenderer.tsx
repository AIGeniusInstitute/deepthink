/**
 * Markdown file renderer. Fetches the .md file content and renders it
 * through the existing MarkdownRenderer, so all markdown features
 * (tables, code blocks, mermaid, katex, images) work natively.
 *
 * Note: this creates a recursive path (MarkdownRenderer → ArtifactRenderer
 * → MarkdownFileRenderer → MarkdownRenderer). The recursion terminates
 * because the inner MarkdownRenderer renders plain text, not file links
 * that would re-trigger artifact rendering — we pass `groupJid` through
 * so nested image links resolve, but nested file links of non-image
 * kinds will fall back to plain <a> tags (no infinite recursion).
 */
import { useEffect, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
  previewUrl: string | null;
}

export function MarkdownFileRenderer({ source, previewUrl }: Props) {
  const [text, setText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!previewUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(previewUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const t = await res.text();
        if (!cancelled) setText(t);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'fetch failed');
      }
    })();
    return () => { cancelled = true; };
  }, [previewUrl]);

  if (error) return <div className="p-4 text-sm text-red-600">Markdown 加载失败：{error}</div>;
  if (!text) return <div className="p-4 text-sm text-muted-foreground">加载中...</div>;

  return (
    <div className="p-3">
      <MarkdownRenderer content={text} groupJid={source.groupJid} variant="chat" />
    </div>
  );
}
