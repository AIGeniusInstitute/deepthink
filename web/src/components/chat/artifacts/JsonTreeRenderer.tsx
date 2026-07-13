/**
 * JSON renderer. Parses JSON and renders a collapsible tree.
 * Handles arrays, objects, and primitives. Cycles impossible in JSON.
 */
import { useEffect, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
  previewUrl: string | null;
}

export function JsonRenderer({ source, previewUrl }: Props) {
  const [text, setText] = useState<string>(source.inlineContent ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source.inlineContent || !previewUrl) return;
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
  }, [source.inlineContent, previewUrl]);

  if (error) return <div className="p-4 text-sm text-red-600">JSON 加载失败：{error}</div>;

  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    return (
      <div className="p-4 text-sm text-red-600">
        JSON 解析失败：{err instanceof Error ? err.message : 'invalid'}
        <pre className="mt-2 text-xs whitespace-pre-wrap break-words text-muted-foreground">{text.slice(0, 500)}</pre>
      </div>
    );
  }

  return (
    <div className="p-3 overflow-auto max-h-[600px] font-mono text-sm">
      <JsonNode value={data} name={null} defaultOpen={true} />
    </div>
  );
}

function JsonNode({ value, name, defaultOpen, depth = 0 }: { value: unknown; name: string | null; defaultOpen?: boolean; depth?: number }) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 2);
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === 'object' && !isArr;

  if (isArr || isObj) {
    const entries = isArr
      ? (value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);
    const brace = isArr ? '[]' : '{}';
    return (
      <div className="ml-4">
        <button
          onClick={() => setOpen(o => !o)}
          className="inline-flex items-center gap-1 hover:bg-foreground/5 rounded px-1"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {name !== null && <span className="text-blue-600 dark:text-blue-400">{JSON.stringify(name)}:</span>}
          <span className="text-muted-foreground">{brace[0]}</span>
          {!open && <span className="text-muted-foreground">{brace[1]}</span>}
          {!open && <span className="text-muted-foreground/60 ml-1">{entries.length} 项</span>}
        </button>
        {open && (
          <>
            {entries.map(([k, v]) => (
              <div key={k} className="ml-2">
                <JsonNode value={v} name={k} defaultOpen={depth < 1} depth={depth + 1} />
              </div>
            ))}
            <div className="ml-4 text-muted-foreground">{brace[1]}</div>
          </>
        )}
      </div>
    );
  }

  // Primitive
  return (
    <div className="ml-4">
      {name !== null && <span className="text-blue-600 dark:text-blue-400">{JSON.stringify(name)}: </span>}
      <PrimitiveValue value={value} />
    </div>
  );
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === 'string') return <span className="text-green-600 dark:text-green-400">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-purple-600 dark:text-purple-400">{String(value)}</span>;
  return <span className="text-muted-foreground">{String(value)}</span>;
}
