/**
 * XLSX renderer. Uses SheetJS (xlsx) to parse the workbook and renders
 * a sheet-tabbed table view. The library is dynamically imported.
 *
 * Renders only up to 1000 rows per sheet to keep DOM size bounded;
 * larger sheets show a truncation notice and the user can download
 * the original file for full data.
 */
import { useEffect, useState } from 'react';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
  previewUrl: string | null;
}

const MAX_ROWS_PER_SHEET = 1000;

interface SheetData {
  name: string;
  rows: string[][];
  truncated: boolean;
}

export function XlsxRenderer({ previewUrl }: Props) {
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
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
          import('xlsx'),
          fetch(previewUrl),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        const XLSX = (mod as any).default ?? mod;
        const wb = XLSX.read(arrayBuffer, { type: 'array' });
        const sheetData: SheetData[] = wb.SheetNames.map((name: string) => {
          const ws = wb.Sheets[name];
          const rows: string[][] = XLSX.utils.sheet_to_json(ws, {
            header: 1,
            raw: false,
            defval: '',
          });
          const truncated = rows.length > MAX_ROWS_PER_SHEET;
          return {
            name,
            rows: truncated ? rows.slice(0, MAX_ROWS_PER_SHEET) : rows,
            truncated,
          };
        });
        if (!cancelled) {
          setSheets(sheetData);
          setActiveSheet(0);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'parse failed');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [previewUrl]);

  if (loading) return <div className="p-4 text-sm text-muted-foreground">XLSX 解析中...</div>;
  if (error) return <div className="p-4 text-sm text-red-600">XLSX 加载失败：{error}</div>;
  if (!sheets.length) return <div className="p-4 text-sm text-muted-foreground">工作簿为空</div>;

  const sheet = sheets[activeSheet];
  const [header, ...body] = sheet.rows;
  const maxCols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0);

  return (
    <div className="flex flex-col">
      {sheets.length > 1 && (
        <div className="flex border-b border-border bg-muted/30 overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActiveSheet(i)}
              className={`px-3 py-1.5 text-xs whitespace-nowrap border-r border-border ${
                i === activeSheet
                  ? 'bg-background text-foreground font-medium border-b-2 border-b-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
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
      </div>
      {sheet.truncated && (
        <div className="px-3 py-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 border-t border-amber-200">
          单 sheet 行数超过 {MAX_ROWS_PER_SHEET}，仅显示前 {MAX_ROWS_PER_SHEET} 行。请下载查看完整数据。
        </div>
      )}
    </div>
  );
}
