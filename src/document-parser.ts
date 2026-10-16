/**
 * Document parser: extract plain text from PDF / DOCX / URL.
 *
 * Used by paas-knowledge-bases.ts to support multiple document types.
 * Output is always plain UTF-8 text — FTS5 indexes the text, and the
 * embedding layer embeds the same string.
 */

import type { Buffer } from 'node:buffer';
import { assertResolvesToPublicAddress, validateSafeHttpsUrl } from './url-safety.js';

export type ParserType =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'epub'
  | 'xmind'
  | 'html'
  | 'csv'
  | 'json'
  | 'text'
  | 'markdown';

/** Formats accepted by the upload endpoint, for error messages and UI hints. */
export const SUPPORTED_PARSERS: ParserType[] = [
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'epub',
  'xmind',
  'html',
  'csv',
  'json',
  'markdown',
  'text',
];

/** 文件扩展名 -> 解析器。集中一处，上传校验与错误提示共用同一份真相。 */
const EXTENSION_PARSERS: Array<[string, ParserType]> = [
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
  ['.pptx', 'pptx'],
  ['.xlsx', 'xlsx'],
  ['.epub', 'epub'],
  ['.xmind', 'xmind'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.csv', 'csv'],
  ['.tsv', 'csv'],
  ['.json', 'json'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.txt', 'text'],
];

/** mime -> 解析器（只在扩展名缺失/不认识时才轮到它）。 */
const MIME_PARSERS: Array<[string, ParserType]> = [
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/epub+zip', 'epub'],
  ['text/html', 'html'],
  ['text/csv', 'csv'],
  ['text/tab-separated-values', 'csv'],
  ['application/json', 'json'],
  ['text/markdown', 'markdown'],
  ['text/x-markdown', 'markdown'],
  ['text/plain', 'text'],
];

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const DOCX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 (zip)

export function detectParser(filename: string, mimeType?: string): ParserType | null {
  const lower = filename.toLowerCase();
  for (const [ext, parser] of EXTENSION_PARSERS) {
    if (lower.endsWith(ext)) return parser;
  }
  for (const [mime, parser] of MIME_PARSERS) {
    if (mimeType === mime) return parser;
  }
  return null;
}

export function sniffParserFromBuffer(buf: Buffer): ParserType | null {
  if (buf.length >= 4 && PDF_MAGIC.every((b, i) => buf[i] === b)) return 'pdf';
  if (buf.length >= 4 && DOCX_MAGIC.every((b, i) => buf[i] === b)) return 'docx';
  return null;
}

/**
 * Last-resort classification for uploads with an unhelpful name and MIME type:
 * accept the buffer as text only if it plausibly *is* text. Binary formats we
 * cannot extract would otherwise be indexed as mojibake and pollute retrieval.
 */
export function sniffTextFromBuffer(buf: Buffer): ParserType | null {
  const sample = buf.subarray(0, 4096);
  if (sample.length === 0) return null;
  if (sample.includes(0)) return null; // NUL byte ⇒ binary
  let printable = 0;
  for (const byte of sample) {
    // Allow ASCII, and any high byte (UTF-8 continuation / CJK lead byte).
    if (byte >= 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte >= 0x80) {
      printable++;
    }
  }
  return printable / sample.length > 0.95 ? 'text' : null;
}

/**
 * 扫描件（无文字层）专用错误类型。
 *
 * 上传路径需要区分「PDF 坏了」和「PDF 是扫描件」：前者该报错给用户，后者该转去
 * OCR。用异常类型而不是匹配错误文案，否则改一个字的提示语就会悄悄让 OCR 回退失效。
 */
export class PdfHasNoTextLayerError extends Error {
  constructor() {
    super('PDF has no extractable text (possibly a scanned image)');
    this.name = 'PdfHasNoTextLayerError';
  }
}

/**
 * `pdf-parse` v2 是**具名类导出**（`export { PDFParse }`），没有默认导出 ——
 * v1 那套 `pdf(buffer)` 的函数式调用在 v2 下会退化成调用命名空间对象，报
 * `pdfParse is not a function`。用法是 `new PDFParse({data})` + `getText()`，
 * 且必须 `destroy()` 释放 pdfjs 的文档句柄（大文件不释放会一直占着内存）。
 *
 * 第二个坑：`getText()` 的 `pageJoiner` 默认值是 `'\n-- {n} of {total} --'`，
 * 也就是**给每一页伪造一条页码标记**。纯扫描件（无文字层）本该抽出空串，被这么一加
 * 就成了「287 页 × 一条标记」的非空文本 —— 下面的空值守卫永远不会触发，知识库会把
 * 纯噪声当正文静默入库。传空串关掉它，抽出的才是真正的正文。
 */
export async function parsePdf(buf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as typeof import('pdf-parse');
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText({ pageJoiner: '' });
    const text = (result?.text ?? '').trim();
    if (!text) throw new PdfHasNoTextLayerError();
    return text;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export async function parseDocx(buf: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer: buf });
  const text = (result?.value ?? '').trim();
  if (!text) throw new Error('DOCX has no extractable text');
  return text;
}

export async function parseHtml(html: string): Promise<string> {
  return stripHtml(html);
}

/**
 * CSV/TSV → one line per record, cells joined by " | ".
 *
 * Deliberately naive: quoted fields containing the delimiter are not handled.
 * A real CSV parser is a dependency and a maintenance surface for a format
 * whose whole point is that it is line-oriented; documents that need exact
 * cell semantics belong in a spreadsheet importer, not here.
 */
export async function parseDelimited(text: string, delimiter: string): Promise<string> {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    out.push(
      line
        .split(delimiter)
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
        .join(' | '),
    );
  }
  const result = out.join('\n').trim();
  if (!result) throw new Error('Delimited file has no non-empty rows');
  return result;
}

/**
 * JSON → indented text, one scalar per line as `path: value`.
 *
 * Flattening rather than `JSON.stringify(value, null, 2)` because retrieval
 * matches on text: a leaf path (`user.address.city: 北京`) is a far better
 * chunk than a brace-delimited blob.
 */
export async function parseJson(text: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lines: string[] = [];
  flattenJson(parsed, '', lines, 0);
  const result = lines.join('\n').trim();
  if (!result) throw new Error('JSON has no scalar values to index');
  return result;
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_LINES = 200_000;

function flattenJson(value: unknown, path: string, out: string[], depth: number): void {
  if (out.length >= MAX_JSON_LINES || depth > MAX_JSON_DEPTH) return;
  if (value === null || typeof value !== 'object') {
    out.push(`${path || '(root)'}: ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => flattenJson(item, `${path}[${i}]`, out, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flattenJson(child, path ? `${path}.${key}` : key, out, depth + 1);
  }
}

/** 重定向跳数上限。设为 0 可禁用跟随（URL 入库不需要跨站跳转）。 */
const MAX_REDIRECTS = 5;

/**
 * 校验单个跳转目标。字面量判定（快，且填内网字面 IP 时不依赖网络）之后
 * 再做 DNS 解析判定——域名可以指向内网，只查字面量会漏。
 */
async function assertSafeFetchTarget(rawUrl: string): Promise<void> {
  const reason = validateSafeHttpsUrl(rawUrl, { allowHttp: true });
  if (reason) {
    throw new Error(`Blocked URL: ${reason}`);
  }
  await assertResolvesToPublicAddress(new URL(rawUrl).hostname, 'URL hostname');
}

export async function fetchUrlContent(url: string, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const maxBytes = opts?.maxBytes ?? 1_000_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 逐跳校验：`redirect: 'follow'` 只校验首跳，一个指向内网的重定向即可绕过。
    let current = url;
    for (let hop = 0; ; hop++) {
      await assertSafeFetchTarget(current);

      const res = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'DeepThink-KB-Fetcher/1.0' },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new Error(`Redirect (${res.status}) without Location header`);
        }
        if (hop >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
        }
        current = new URL(location, current).toString();
        continue;
      }

      if (!res.ok) {
        throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!/text\/(html|plain)/i.test(contentType) && !/xml/i.test(contentType)) {
        throw new Error(`Unsupported content type: ${contentType}`);
      }
      const html = await res.text();
      const truncated = html.length > maxBytes ? html.slice(0, maxBytes) : html;
      return stripHtml(truncated);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 网页正文抽取。
 *
 * `import` 而不是 `require`：本仓库是 ESM（`package.json` 里 `"type": "module"`，
 * 生产跑 `node dist/index.js`），`require` 在这里是**未定义标识符**，调用即抛
 * `ReferenceError: require is not defined`。测试之所以没暴露它，是因为 vitest 的
 * 模块转换给 ESM 注入了一个 `require` 兼容层 —— 测得过、线上跑不过。
 * 动态 `import()` 与文件里 `parseDocx`/`parsePdf` 的写法保持一致。
 */
async function stripHtml(html: string): Promise<string> {
  // cheerio: extract article/main text, fallback to body
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  $('script,style,nav,footer,header,aside,form,iframe').remove();
  const root = $('article').first().length ? $('article').first()
    : $('main').first().length ? $('main').first()
    : $('body').length ? $('body')
    : $.root();
  // `root` 可能是 Cheerio<Element> 也可能是 Cheerio<Document>（`$.root()` 那一支），
  // 两者的 `text()` 签名不通用，所以经 `any` 调用 —— 运行时行为完全一致。
  const text = (root as { text(): string }).text().replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('No text content extracted from URL');
  return text;
}
