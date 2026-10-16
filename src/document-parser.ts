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
  | 'html'
  | 'csv'
  | 'json'
  | 'text'
  | 'markdown';

/** Formats accepted by the upload endpoint, for error messages and UI hints. */
export const SUPPORTED_PARSERS: ParserType[] = [
  'pdf',
  'docx',
  'html',
  'csv',
  'json',
  'markdown',
  'text',
];

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const DOCX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 (zip)

export function detectParser(filename: string, mimeType?: string): ParserType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') return 'pdf';
  if (
    lower.endsWith('.docx') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) return 'docx';
  if (lower.endsWith('.html') || lower.endsWith('.htm') || mimeType === 'text/html') return 'html';
  if (lower.endsWith('.csv') || mimeType === 'text/csv') return 'csv';
  if (lower.endsWith('.tsv') || mimeType === 'text/tab-separated-values') return 'csv';
  if (lower.endsWith('.json') || mimeType === 'application/json') return 'json';
  if (
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/x-markdown'
  ) return 'markdown';
  if (lower.endsWith('.txt') || mimeType === 'text/plain') return 'text';
  // Fallback: sniff magic bytes
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

export async function parsePdf(buf: Buffer): Promise<string> {
  const mod = await import('pdf-parse');
  const pdfParse = (mod as any).default ?? (mod as any);
  const result = await pdfParse(buf);
  const text = (result?.text ?? '').trim();
  if (!text) throw new Error('PDF has no extractable text (possibly a scanned image)');
  return text;
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

function stripHtml(html: string): string {
  // cheerio: extract article/main text, fallback to body
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  $('script,style,nav,footer,header,aside,form,iframe').remove();
  const root = $('article').first().length ? $('article').first()
    : $('main').first().length ? $('main').first()
    : $('body').length ? $('body')
    : $.root();
  const text = root.text().replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('No text content extracted from URL');
  return text;
}
