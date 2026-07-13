/**
 * PDF renderer. Uses the browser's native PDF viewer via an <iframe>
 * pointing at the /preview endpoint (which returns Content-Disposition:
 * inline + Content-Type: application/pdf).
 */
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
  previewUrl: string | null;
}

export function PdfRenderer({ source, previewUrl }: Props) {
  if (!previewUrl) {
    return <div className="p-4 text-sm text-muted-foreground">PDF 预览不可用</div>;
  }
  return (
    <iframe
      title={source.fileName || 'PDF artifact'}
      src={previewUrl}
      className="w-full bg-white"
      style={{ minHeight: '600px', border: 'none' }}
    />
  );
}
