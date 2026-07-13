/**
 * Build /preview or /convert URLs for an artifact file.
 *
 * Resolves relative paths against the group's data directory, strips
 * "#agent:xxx" suffix used for sub-agent scoping (file API uses the base
 * group JID), and base64url-encodes the path the same way the backend
 * file route expects.
 */
import { useMemo } from 'react';
import { toBase64Url } from '../../../stores/files';
import { withBasePath } from '../../../utils/url';
import type { ArtifactSource } from './types';

export interface ArtifactUrlOptions {
  /** 'preview' (default) or 'convert' (for Office → PDF) */
  endpoint?: 'preview' | 'convert';
}

export function useArtifactUrl(source: ArtifactSource, opts: ArtifactUrlOptions = {}): string | null {
  return useMemo(() => {
    if (!source.filePath || !source.groupJid) return null;
    const endpoint = opts.endpoint ?? 'preview';
    const baseJid = source.groupJid.replace(/#agent:.*$/, '');
    const encoded = toBase64Url(source.filePath);
    return withBasePath(
      `/api/groups/${encodeURIComponent(baseJid)}/files/${endpoint}/${encoded}`,
    );
  }, [source.filePath, source.groupJid, opts.endpoint]);
}

/** Non-hook variant for use inside event handlers. */
export function buildArtifactUrl(
  source: ArtifactSource,
  endpoint: 'preview' | 'convert' = 'preview',
): string | null {
  if (!source.filePath || !source.groupJid) return null;
  const baseJid = source.groupJid.replace(/#agent:.*$/, '');
  const encoded = toBase64Url(source.filePath);
  return withBasePath(
    `/api/groups/${encodeURIComponent(baseJid)}/files/${endpoint}/${encoded}`,
  );
}

/** Build the download URL (forces attachment disposition). */
export function buildDownloadUrl(source: ArtifactSource): string | null {
  return buildArtifactUrl(source, 'preview');
}
