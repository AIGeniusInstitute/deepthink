/**
 * CSV renderer. Parses CSV text into rows and renders as an HTML table.
 * Uses a minimal RFC-4180-compliant parser (handles quoted fields with
 * embedded commas, newlines, and escaped quotes).
 */
import { useEffect, useMemo, useState } from 'react';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
  previewUrl: string | null;
}

const MAX_ROWS = 1000;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function CsvRenderer({ source, previewUrl }: Props) {
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

  const { rows, truncated } = useMemo(() => {
    if (!text) return { rows: [] as string[][], truncated: false };
    const all = parseCsv(text);
    if (all.length > MAX_ROWS) {
      return { rows: all.slice(0, MAX_ROWS), truncated: true };
    }
    return { rows: all, truncated: false };
  }, [text]);

  if (error) return <div className="p-4 text-sm text-red-600">CSV 加载失败：{error}</div>;
  if (!rows.length) return <div className="p-4 text-sm text-muted-foreground">空 CSV</div>;

  const [header, ...body] = rows;
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);

  return (
    <div className="overflow-auto max-h-[600px]">
      <table className="min-w-full border-collapse text-sm">
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
      {truncated && (
        <div className="px-3 py-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 border-t border-amber-200">
          行数超过 {MAX_ROWS}，仅显示前 {MAX_ROWS} 行。请下载查看完整数据。
        </div>
      )}
    </div>
  );
}
