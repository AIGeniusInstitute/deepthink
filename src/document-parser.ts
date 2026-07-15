/**
 * Document parser: extract plain text from PDF / DOCX / URL.
 *
 * Used by paas-knowledge-bases.ts to support multiple document types.
 * Output is always plain UTF-8 text — FTS5 indexes the text, and the
 * embedding layer embeds the same string.
 */

import type { Buffer } from 'node:buffer';

export type ParserType = 'pdf' | 'docx' | 'text' | 'markdown' | null;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const DOCX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 (zip)

export function detectParser(filename: string, mimeType?: string): ParserType {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') return 'pdf';
  if (
    lower.endsWith('.docx') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) return 'docx';
  if (
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/x-markdown'
  ) return 'markdown';
  if (lower.endsWith('.txt') || mimeType === 'text/plain' || mimeType === 'application/octet-stream') return 'text';
  // Fallback: sniff magic bytes
  return null;
}

export function sniffParserFromBuffer(buf: Buffer): ParserType {
  if (buf.length >= 4 && PDF_MAGIC.every((b, i) => buf[i] === b)) return 'pdf';
  if (buf.length >= 4 && DOCX_MAGIC.every((b, i) => buf[i] === b)) return 'docx';
  return null;
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

export async function fetchUrlContent(url: string, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const maxBytes = opts?.maxBytes ?? 1_000_000;

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Only http(s) URLs are supported');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'DeepThink-KB-Fetcher/1.0' },
    });
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
