/**
 * Bun Runtime Auto-installer
 *
 * Ensures the Bun binary is available on the host machine for OpenCode engine.
 * Downloads from GitHub Releases if missing, caches in data/bin/bun-<version>/.
 *
 * Triggered:
 *   - lazily by getOpencodeConfig() when bunPath is empty
 *   - eagerly on backend startup (async, non-blocking)
 */

import { spawn } from 'node:child_process';
import { mkdir, chmod, stat, writeFile, unlink, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const BUN_VERSION = '1.3.14';
const BUN_INSTALL_ROOT = join(DATA_DIR, 'bin', `bun-v${BUN_VERSION}`);
const BUN_BINARY_PATH = join(BUN_INSTALL_ROOT, 'bun');

/** Resolves to true if path exists, false on error. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function getPlatformAsset(): { asset: string; subdir: string } {
  const platform = process.platform;
  const arch = process.arch;
  const osMap: Record<string, string> = { darwin: 'darwin', linux: 'linux' };
  const archMap: Record<string, string> = { arm64: 'arm64', x64: 'x64' };
  const osStr = osMap[platform];
  const archStr = archMap[arch];
  if (!osStr || !archStr) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return {
    asset: `bun-${osStr}-${archStr}.zip`,
    subdir: `bun-${osStr}-${archStr}`,
  };
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('unzip', ['-o', '-q', zipPath, '-d', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip exit ${code}: ${stderr}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Ensure Bun is installed. Returns the path to the bun binary.
 * - If already installed at BUN_INSTALL_ROOT, returns immediately.
 * - Otherwise downloads the zip from GitHub Releases, extracts, chmods 0o755.
 *
 * `forceCheck`: when true, always re-check filesystem (skip in-process cache).
 */
let _cachedBunPath: string | null = null;

export async function ensureBunInstalled(
  forceCheck = false,
): Promise<{ bunPath: string; installed: boolean }> {
  if (_cachedBunPath && !forceCheck) {
    return { bunPath: _cachedBunPath, installed: false };
  }
  // Already installed?
  if (await pathExists(BUN_BINARY_PATH)) {
    try {
      const st = await stat(BUN_BINARY_PATH);
      if (st.isFile() && (st.mode & 0o111)) {
        _cachedBunPath = BUN_BINARY_PATH;
        return { bunPath: BUN_BINARY_PATH, installed: false };
      }
    } catch { /* fall through */ }
  }

  // Clean partial install dir then re-download
  await mkdir(BUN_INSTALL_ROOT, { recursive: true });
  const { asset, subdir } = getPlatformAsset();
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}`;
  const zipPath = join(BUN_INSTALL_ROOT, 'bun.zip');

  logger.info({ url, dest: BUN_INSTALL_ROOT }, 'ensureBunInstalled: downloading');
  await downloadFile(url, zipPath);
  await extractZip(zipPath, BUN_INSTALL_ROOT);

  // Find the bun binary (extracted into bun-<os>-<arch>/bun)
  const extractedDir = join(BUN_INSTALL_ROOT, subdir);
  const extractedBinary = join(extractedDir, 'bun');
  if (!(await pathExists(extractedBinary))) {
    // Maybe it extracted directly without subdir
    const entries = await readdir(BUN_INSTALL_ROOT);
    logger.warn({ entries, expected: extractedBinary }, 'ensureBunInstalled: bun binary not at expected path');
    throw new Error(`Bun binary not found after extraction. Expected: ${extractedBinary}`);
  }

  await chmod(extractedBinary, 0o755);
  await unlink(zipPath).catch(() => {});

  _cachedBunPath = extractedBinary;
  logger.info({ bunPath: extractedBinary }, 'ensureBunInstalled: installed');
  return { bunPath: extractedBinary, installed: true };
}

/**
 * Detect if a bun binary is already on PATH (user pre-installed).
 * Returns its path or null.
 */
export async function detectSystemBun(): Promise<string | null> {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where bun' : 'which bun';
  try {
    const result = await new Promise<string | null>((resolve) => {
      const proc = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.on('close', () => {
        const trimmed = stdout.trim().split('\n')[0];
        resolve(trimmed || null);
      });
      proc.on('error', () => resolve(null));
    });
    return result;
  } catch {
    return null;
  }
}
