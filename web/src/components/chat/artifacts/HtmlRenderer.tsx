/**
 * HTML renderer. Sandboxed iframe with srcDoc.
 *
 * `sandbox="allow-scripts"` (no allow-same-origin) keeps the iframe
 * cross-origin from the parent, so it cannot access Cookies, localStorage,
 * or parent DOM. DOMPurify strips known-bad tags (<object>, <embed>,
 * <base>, <meta http-equiv>) as defense-in-depth even though the sandbox
 * already blocks most attacks.
 */
import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
}

export function HtmlRenderer({ source }: Props) {
  const srcDoc = useMemo(() => {
    const raw = source.inlineContent ?? '';
    if (!raw) return '';
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target', 'sandbox'],
      FORBID_TAGS: ['base', 'object', 'embed', 'frame', 'iframe'],
      FORBID_ATTR: ['http-equiv'],
    });
  }, [source.inlineContent]);

  if (!srcDoc) return null;

  return (
    <iframe
      title={source.fileName || 'HTML artifact'}
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-popups allow-forms allow-modals"
      className="w-full bg-white"
      style={{ minHeight: '400px', border: 'none' }}
    />
  );
}
