#!/usr/bin/env node
// 拉取跨平台 Node.js 二进制，落到 dev-resources/node/ 供 electron-builder extraResources 打包。
// 平台由 process.env.TARGET_PLATFORM / .ARCH 控制；默认当前主机平台。
//
// 用法：
//   node scripts/fetch-node-binary.js                  # 当前平台
//   TARGET_PLATFORM=win ARCH=x64 node scripts/fetch-node-binary.js
//   TARGET_PLATFORM=darwin ARCH=arm64 node scripts/fetch-node-binary.js
//   TARGET_PLATFORM=linux ARCH=x64 node scripts/fetch-node-binary.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Best-effort require('tar') — common transitive dep, but not in our deps list.
let tar = null;
try {
  tar = require('tar');
} catch {
  tar = null;
}

const NODE_VERSION = process.env.NODE_VERSION || 'v22.11.0';
const TARGET_PLATFORM = process.env.TARGET_PLATFORM || process.platform;
const ARCH = process.env.ARCH || process.arch;

const archMap = {
  arm64: 'arm64',
  x64: 'x64',
  ia32: 'x86',
};
const platformMap = {
  darwin: 'darwin',
  win32: 'win',
  linux: 'linux',
};

const nodeArch = archMap[ARCH] || ARCH;
const nodePlatform = platformMap[TARGET_PLATFORM] || TARGET_PLATFORM;

if (!nodeArch || !nodePlatform) {
  console.error(`Unsupported platform/arch: ${TARGET_PLATFORM}/${ARCH}`);
  process.exit(1);
}

const ext = nodePlatform === 'win' ? 'zip' : 'tar.gz';
const archiveName = `node-${NODE_VERSION}-${nodePlatform}-${nodeArch}.${ext}`;
const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}`;

const outRoot = path.resolve(process.cwd(), 'dev-resources');
const outNodeDir = path.join(outRoot, 'node');
fs.mkdirSync(outNodeDir, { recursive: true });

const finalBinaryName = nodePlatform === 'win' ? 'node.exe' : 'node';
const finalBinaryPath = path.join(outNodeDir, finalBinaryName);

if (fs.existsSync(finalBinaryPath)) {
  console.log(`[fetch-node] already exists: ${finalBinaryPath}`);
  process.exit(0);
}

console.log(`[fetch-node] downloading ${url}`);
downloadAndExtract(url, outNodeDir);

function downloadAndExtract(url, destDir) {
  const tmpArchive = path.join(os.tmpdir(), archiveName);
  const file = fs.createWriteStream(tmpArchive);
  https
    .get(url, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        https.get(res.headers.location, (r2) => pipeToFile(r2, file, tmpArchive, destDir));
      } else if (res.statusCode !== 200) {
        console.error(`[fetch-node] download failed: HTTP ${res.statusCode}`);
        process.exit(1);
      } else {
        pipeToFile(res, file, tmpArchive, destDir);
      }
    })
    .on('error', (err) => {
      console.error(`[fetch-node] download error: ${err.message}`);
      process.exit(1);
    });
}

function pipeToFile(res, file, archive, destDir) {
  res.pipe(file);
  file.on('finish', () => {
    file.close(() => extract(archive, destDir));
  });
}

function extract(archive, destDir) {
  const tmpExtract = path.join(os.tmpdir(), `node-extract-${Date.now()}`);
  fs.mkdirSync(tmpExtract, { recursive: true });

  if (ext === 'tar.gz') {
    if (tar) {
      tar.x({ file: archive, cwd: tmpExtract, sync: true });
    } else {
      execFileSync('tar', ['-xzf', archive, '-C', tmpExtract]);
    }
    // Find extracted dir (e.g., node-v22.11.0-darwin-arm64/)
    const extracted = fs.readdirSync(tmpExtract).find((d) => d.startsWith('node-'));
    if (!extracted) {
      console.error('[fetch-node] extracted dir not found');
      process.exit(1);
    }
    const binPath = path.join(tmpExtract, extracted, 'bin', 'node');
    fs.copyFileSync(binPath, path.join(destDir, 'node'));
    fs.chmodSync(path.join(destDir, 'node'), 0o755);
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    console.log(`[fetch-node] OK: ${path.join(destDir, 'node')}`);
  } else {
    // Windows zip: use system unzip / powershell
    try {
      execFileSync('unzip', ['-o', archive, '-d', tmpExtract]);
    } catch {
      // PowerShell fallback
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${archive}' -DestinationPath '${tmpExtract}' -Force`,
      ]);
    }
    const extracted = fs.readdirSync(tmpExtract).find((d) => d.startsWith('node-'));
    if (!extracted) {
      console.error('[fetch-node] extracted dir not found');
      process.exit(1);
    }
    const binPath = path.join(tmpExtract, extracted, 'node.exe');
    fs.copyFileSync(binPath, path.join(destDir, 'node.exe'));
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    console.log(`[fetch-node] OK: ${path.join(destDir, 'node.exe')}`);
  }
}
