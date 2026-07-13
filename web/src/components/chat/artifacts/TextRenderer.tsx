/**
 * Plain text / log renderer. Reads up to 1MB and renders as <pre>.
 */
import { useEffect, useState } from 'react';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
  previewUrl: string | null;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function TextRenderer({ source, previewUrl }: Props) {
  const [text, setText] = useState<string>(source.inlineContent ?? '');
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source.inlineContent || !previewUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(previewUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (blob.size > MAX_TEXT_BYTES) {
          const partial = await blob.slice(0, MAX_TEXT_BYTES).text();
          if (!cancelled) {
            setText(partial);
            setTruncated(true);
          }
        } else {
          const t = await blob.text();
          if (!cancelled) setText(t);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'fetch failed');
      }
    })();
    return () => { cancelled = true; };
  }, [source.inlineContent, previewUrl]);

  if (error) return <div className="p-4 text-sm text-red-600">加载失败：{error}</div>;

  return (
    <div className="relative">
      <pre className="p-3.5 overflow-x-auto font-mono text-sm whitespace-pre-wrap break-words text-foreground bg-muted/20 m-0">
        {text}
      </pre>
      {truncated && (
        <div className="px-3 py-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 border-t border-amber-200">
          文件过大，仅显示前 2MB。请下载查看完整内容。
        </div>
      )}
    </div>
  );
}
