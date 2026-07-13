/**
 * Artifact rendering types and extension → kind mapping.
 *
 * Shared by ArtifactRenderer and MarkdownRenderer to keep extension
 * recognition consistent across code-block, markdown-image, and
 * markdown-link entry points.
 */

export type ArtifactKind =
  | 'svg'
  | 'html'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'code'
  | 'image'
  | 'video'
  | 'audio'
  | 'csv'
  | 'json'
  | 'markdown'
  | 'text'
  | 'mermaid'
  | 'unknown';

export interface ArtifactSource {
  /** Inline content from a fenced code block */
  inlineContent?: string;
  /** Relative file path inside the workspace (for /preview fetch) */
  filePath?: string;
  /** File name used for download button label */
  fileName?: string;
  /** Group JID used to build /preview URL */
  groupJid?: string;
  /** Code language for code kind (e.g. "python", "go") */
  language?: string;
  /** Original markdown alt text (for image alt fallback) */
  alt?: string;
}

/** Map file extension → ArtifactKind. Keep in sync with backend MIME_MAP. */
export const EXTENSION_TO_KIND: Record<string, ArtifactKind> = {
  // Visual / document
  svg: 'svg',
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
  docx: 'docx',
  doc: 'docx',
  xlsx: 'xlsx',
  xls: 'xlsx',
  pptx: 'pptx',
  ppt: 'pptx',
  // Media
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  avi: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  aac: 'audio',
  m4a: 'audio',
  flac: 'audio',
  // Data
  csv: 'csv',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  // Source code
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  cc: 'code',
  cxx: 'code',
  py: 'code',
  python: 'code',
  go: 'code',
  rs: 'code',
  rust: 'code',
  js: 'code',
  javascript: 'code',
  ts: 'code',
  typescript: 'code',
  jsx: 'code',
  tsx: 'code',
  css: 'code',
  scss: 'code',
  less: 'code',
  xml: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  ini: 'code',
  conf: 'code',
  sql: 'code',
  php: 'code',
  rb: 'code',
  ruby: 'code',
  kt: 'code',
  kts: 'code',
  swift: 'code',
  scala: 'code',
  lua: 'code',
  r: 'code',
  dart: 'code',
  vue: 'code',
  svelte: 'code',
  perl: 'code',
  pl: 'code',
  // Text
  txt: 'text',
  log: 'text',
};

/** Languages whose fenced code block should inline-render as the visual artifact. */
export const INLINE_CODE_LANGUAGES = new Set(['svg', 'html', 'htm', 'mermaid']);

/** Map a code-fence language tag → ArtifactKind (returns undefined for plain code). */
export function detectInlineKind(language: string | undefined): ArtifactKind | undefined {
  if (!language) return undefined;
  const lang = language.toLowerCase();
  if (lang === 'mermaid') return 'mermaid';
  if (lang === 'svg') return 'svg';
  if (lang === 'html' || lang === 'htm') return 'html';
  return undefined;
}

/** Extract file extension (without dot, lowercased) from a URL or path. */
export function getExt(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  // Strip query and hash
  const clean = input.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = clean.slice(dot + 1).toLowerCase();
  return ext || undefined;
}

/** Detect artifact kind from a file path/URL. */
export function detectKindFromPath(filePath: string | undefined | null): ArtifactKind {
  const ext = getExt(filePath);
  if (!ext) return 'unknown';
  return EXTENSION_TO_KIND[ext] ?? 'unknown';
}

/** Human-readable label for each kind, used in toolbar + aria. */
export const KIND_LABEL: Record<ArtifactKind, string> = {
  svg: 'SVG',
  html: 'HTML',
  pdf: 'PDF',
  docx: 'DOCX',
  xlsx: 'XLSX',
  pptx: 'PPTX',
  code: 'Source Code',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  csv: 'CSV',
  json: 'JSON',
  markdown: 'Markdown',
  text: 'Text',
  mermaid: 'Mermaid',
  unknown: 'File',
};

/** Extensions that browsers can natively render inside an <iframe> via /preview. */
export const IFRAME_PREVIEW_KINDS: ReadonlySet<ArtifactKind> = new Set(['pdf', 'html', 'svg']);
