/**
 * Office document → PDF conversion via LibreOffice headless.
 *
 * Used by the chat artifact renderer to inline-preview PPTX/DOCX/XLSX
 * when no dedicated browser-side parser exists (notably PPTX).
 *
 * Results are cached under data/cache/office-preview/<sha256>.pdf keyed
 * by absolute source path + mtime + size, so repeated previews of the
 * same file don't re-invoke LibreOffice.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const execFileP = promisify(execFile);
const CONVERT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const CACHE_DIR = path.join(DATA_DIR, 'cache', 'office-preview');

const SUPPORTED_SOURCE_EXTS = new Set(['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'odp', 'ods', 'odt', 'rtf']);

let cachedBin: string | null = null;

export function isConvertibleToPdf(ext: string): boolean {
  return SUPPORTED_SOURCE_EXTS.has(ext.toLowerCase());
}

export function getOfficeCacheDir(): string {
  return CACHE_DIR;
}

async function detectLibreOfficeBin(): Promise<string | null> {
  if (cachedBin) return cachedBin;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice', 'libreoffice']
    : ['soffice', 'libreoffice'];
  for (const c of candidates) {
    try {
      await execFileP(c, ['--version'], { timeout: 5_000, maxBuffer: 1 * 1024 * 1024 });
      cachedBin = c;
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

export async function isLibreOfficeAvailable(): Promise<boolean> {
  return (await detectLibreOfficeBin()) !== null;
}

function computeCacheKey(absolutePath: string, stat: fs.Stats): string {
  return crypto
    .createHash('sha256')
    .update(`${absolutePath}:${stat.mtimeMs}:${stat.size}`)
    .digest('hex');
}

/**
 * Convert an Office document to PDF using LibreOffice headless.
 * Returns the absolute path of the cached PDF.
 * Throws if LibreOffice is not installed or conversion fails.
 */
export async function convertToPdf(sourcePath: string): Promise<string> {
  const bin = await detectLibreOfficeBin();
  if (!bin) {
    throw new Error('LibreOffice not installed on the server');
  }

  const stat = fs.statSync(sourcePath);
  const cacheKey = computeCacheKey(sourcePath, stat);
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.pdf`);

  if (fs.existsSync(cachePath)) {
    return cachePath;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmpOutDir = path.join(CACHE_DIR, `tmp-${cacheKey}`);
  fs.rmSync(tmpOutDir, { recursive: true, force: true });
  fs.mkdirSync(tmpOutDir, { recursive: true });

  try {
    // -env:UserInstallation is required to avoid profile lock conflicts when
    // multiple conversions run concurrently in the same process tree.
    await execFileP(
      bin,
      [
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        '--norestore',
        '-env:UserInstallation=file://' + path.join(CACHE_DIR, 'profile'),
        '--convert-to', 'pdf',
        '--outdir', tmpOutDir,
        sourcePath,
      ],
      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );

    const baseName = path.basename(sourcePath, path.extname(sourcePath));
    const generated = path.join(tmpOutDir, `${baseName}.pdf`);
    if (!fs.existsSync(generated)) {
      throw new Error('LibreOffice produced no output file');
    }
    fs.renameSync(generated, cachePath);
    return cachePath;
  } finally {
    fs.rmSync(tmpOutDir, { recursive: true, force: true });
  }
}

/**
 * Convert an HTML document string to a binary Office file (docx/xlsx/pptx/odt…)
 * using LibreOffice headless. Returns the generated file Buffer.
 *
 * Used by the in-browser contenteditable editor to write back edits as a real
 * Office file when no JS-side emitter is available (notably docx from HTML).
 *
 * Throws if LibreOffice is not installed or conversion fails.
 */
export async function convertHtmlToOffice(
  html: string,
  targetExt: string,
): Promise<Buffer> {
  const bin = await detectLibreOfficeBin();
  if (!bin) {
    throw new Error('LibreOffice not installed on the server');
  }
  const ext = targetExt.toLowerCase().replace(/^\./, '');
  const ALLOWED = ['docx', 'doc', 'odt', 'rtf'];
  if (!ALLOWED.includes(ext)) {
    throw new Error(`Unsupported target extension: ${targetExt}`);
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const jobId = crypto.randomUUID();
  const tmpOutDir = path.join(CACHE_DIR, `tmp-htmloffice-${jobId}`);
  fs.rmSync(tmpOutDir, { recursive: true, force: true });
  fs.mkdirSync(tmpOutDir, { recursive: true });
  const srcPath = path.join(tmpOutDir, `source.html`);
  fs.writeFileSync(srcPath, html, 'utf-8');

  // HTML 输入必须显式指定导出过滤器名，否则 LibreOffice 报
  // "no export filter" —— 用 "<ext>:<filter>" 形式。
  const FILTER_FOR_EXT: Record<string, string> = {
    docx: 'MS Word 2007 XML',
    doc: 'MS Word 97',
    odt: 'writer8',
    rtf: 'Rich Text Format',
  };
  const filter = FILTER_FOR_EXT[ext];
  const convertTarget = filter ? `${ext}:${filter}` : ext;

  try {
    await execFileP(
      bin,
      [
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        '--norestore',
        '-env:UserInstallation=file://' + path.join(CACHE_DIR, 'profile'),
        '--convert-to', convertTarget,
        '--outdir', tmpOutDir,
        srcPath,
      ],
      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
    const generated = path.join(tmpOutDir, `source.${ext}`);
    if (!fs.existsSync(generated)) {
      throw new Error('LibreOffice produced no output file');
    }
    return fs.readFileSync(generated);
  } finally {
    fs.rmSync(tmpOutDir, { recursive: true, force: true });
  }
}

/**
 * Clear cached conversion results older than `maxAgeMs`.
 * Called by a periodic maintenance task to bound disk usage.
 */
export function pruneOfficeCache(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  if (!fs.existsSync(CACHE_DIR)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const entry of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.pdf')) continue;
    const full = path.join(CACHE_DIR, entry.name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch (err) {
      logger.warn({ err, file: full }, 'Failed to prune office cache entry');
    }
  }
  return removed;
}
