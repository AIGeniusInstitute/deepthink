/**
 * Source code renderer. Wraps a <pre><code> block with highlight.js
 * classes. Used when a file path (rather than a fenced code block) is
 * detected as code. Fenced code blocks still use MarkdownRenderer's
 * CodeBlock path, which already has highlighting.
 *
 * highlight.js is loaded via rehype-highlight in MarkdownRenderer, but
 * here we call hljs directly to highlight arbitrary content.
 */
import { useEffect, useRef, useState } from 'react';
import hljs from 'highlight.js';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
  previewUrl: string | null;
  language?: string;
}

export function CodeRenderer({ source, previewUrl, language }: Props) {
  const [code, setCode] = useState<string>(source.inlineContent ?? '');
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLElement>(null);

  // Fetch file content if not inline
  useEffect(() => {
    if (source.inlineContent || !previewUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(previewUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setCode(text);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'fetch failed');
      }
    })();
    return () => { cancelled = true; };
  }, [source.inlineContent, previewUrl]);

  // Apply hljs after content is set
  useEffect(() => {
    if (!codeRef.current) return;
    try {
      const result = language
        ? hljs.highlight(code, { language, ignoreIllegals: true })
        : hljs.highlightAuto(code);
      codeRef.current.innerHTML = result.value;
      codeRef.current.className = `hljs language-${language || 'plaintext'}`;
    } catch {
      codeRef.current.textContent = code;
    }
  }, [code, language]);

  if (error) {
    return <div className="p-4 text-sm text-red-600">代码加载失败：{error}</div>;
  }

  return (
    <pre className="!bg-[var(--code-block-bg)] rounded-lg p-3.5 overflow-x-auto font-mono text-sm m-0">
      <code ref={codeRef} className={`language-${language || 'plaintext'}`}>
        {code}
      </code>
    </pre>
  );
}
