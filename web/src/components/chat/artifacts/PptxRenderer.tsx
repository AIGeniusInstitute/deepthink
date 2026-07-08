/**
 * PPTX renderer. Browsers cannot parse .pptx natively, so we rely on
 * the backend /convert endpoint (LibreOffice) to render the file to PDF,
 * then embed the PDF via iframe.
 *
 * If LibreOffice is unavailable on the server, we fall back to a simple
 * download prompt.
 */
import { useEffect, useState } from 'react';
import type { ArtifactSource } from './types';
import { buildArtifactUrl } from './useArtifactUrl';

interface Props {
  source: ArtifactSource;
}

export function PptxRenderer({ source }: Props) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const convertUrl = buildArtifactUrl(source, 'convert');
  const libreOfficeStatusUrl = source.groupJid
    ? `/api/groups/${encodeURIComponent(source.groupJid.replace(/#agent:.*$/, ''))}/files/libreoffice-status`
    : null;

  useEffect(() => {
    if (!libreOfficeStatusUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(libreOfficeStatusUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { available?: boolean };
        if (!cancelled) setAvailable(Boolean(data.available));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'status check failed');
          setAvailable(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [libreOfficeStatusUrl]);

  if (!convertUrl) {
    return <div className="p-4 text-sm text-muted-foreground">PPTX 预览不可用</div>;
  }

  if (available === null) {
    return <div className="p-4 text-sm text-muted-foreground">检查 LibreOffice 可用性...</div>;
  }

  if (!available) {
    return (
      <div className="p-4 text-sm text-muted-foreground flex items-center gap-3">
        <span>服务端未安装 LibreOffice，无法在线预览 PPTX。</span>
        <a
          href={convertUrl}
          download={source.fileName || 'presentation.pptx'}
          className="text-primary hover:underline"
        >
          下载原文件
        </a>
        {error && <span className="text-xs text-red-500">({error})</span>}
      </div>
    );
  }

  return (
    <iframe
      title={source.fileName || 'PPTX artifact'}
      src={convertUrl}
      className="w-full bg-white"
      style={{ minHeight: '600px', border: 'none' }}
    />
  );
}
