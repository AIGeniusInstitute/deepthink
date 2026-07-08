/**
 * DOCX renderer. Uses mammoth.js to convert .docx → HTML in the browser.
 * The library is dynamically imported to keep the initial bundle small.
 */
import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
  previewUrl: string | null;
}

// Mammoth ships ~150KB; load on first use
const mammothLoader = () => import('mammoth/mammoth.browser.js');

export function DocxRenderer({ previewUrl }: Props) {
  const [html, setHtml] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!previewUrl) {
      setError('预览地址不可用');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [mod, res] = await Promise.all([
          mammothLoader(),
          fetch(previewUrl),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        const mammoth = (mod as any).default ?? mod;
        const result = await mammoth.convertToHtml({ arrayBuffer });
        if (!cancelled) {
          setHtml(result.value || '<p class="text-muted-foreground">文档为空</p>');
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'conversion failed');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [previewUrl]);

  if (loading) return <div className="p-4 text-sm text-muted-foreground">DOCX 转换中...</div>;
  if (error) return <div className="p-4 text-sm text-red-600">DOCX 加载失败：{error}</div>;

  const sanitized = DOMPurify.sanitize(html, {
    ADD_ATTR: ['colspan', 'rowspan'],
  });

  return (
    <div
      className="p-4 prose prose-sm dark:prose-invert max-w-none text-foreground"
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
