/**
 * 运行时资产复制（scripts/copy-runtime-assets.cjs）与 pty-worker 路径布局约束。
 *
 * 背景：tsc 只 emit .js，非 .js 运行时资产必须显式复制进 dist/，否则生产构建
 * （node dist/index.js）ENOENT——见 docs/issues/2026-09-29-eval-center-schema-asset-missing.md。
 * pty-worker.cjs 曾漏网（terminal-manager 旧路径 `dist/../src/pty-worker.cjs` 在打包部署中
 * miss → PTY 静默降级 pipe），本测试锁住这两个不变式。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'copy-runtime-assets.cjs');

function runCopy(root: string): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [COPY_SCRIPT], {
      env: { ...process.env, RUNTIME_ASSETS_ROOT: root },
      encoding: 'utf-8',
    });
    return { status: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: e.stderr ?? '' };
  }
}

function makeSrcLayout(root: string): void {
  fs.mkdirSync(path.join(root, 'src', 'eval-center'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'pty-worker.cjs'), '// fake pty worker\n');
  fs.writeFileSync(path.join(root, 'src', 'eval-center', 'eval-schema.sql'), '-- fake schema\n');
}

describe('copy-runtime-assets', () => {
  it('把 pty-worker.cjs 与 eval-schema.sql 复制进 dist/（TC-F5-01）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-assets-'));
    try {
      makeSrcLayout(root);
      const { status } = runCopy(root);
      expect(status).toBe(0);
      expect(fs.existsSync(path.join(root, 'dist', 'pty-worker.cjs'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'dist', 'eval-center', 'eval-schema.sql'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('源文件缺失时报错退出非 0（防御行为保持）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-assets-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true }); // 故意不放资产
      const { status, stderr } = runCopy(root);
      expect(status).not.toBe(0);
      expect(stderr).toContain('运行时资产源码缺失');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pty-worker 路径布局（TC-F5-02）', () => {
  it('dev 布局：src/pty-worker.cjs 存在（tsx 直跑 src/ 时 __dirname=src/ 命中）', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'src', 'pty-worker.cjs'))).toBe(true);
  });

  it('prod 布局：复制后 dist/ 与入口同级命中（node dist/ 时 __dirname=dist/）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-assets-'));
    try {
      makeSrcLayout(root);
      runCopy(root);
      // terminal-manager 的 PTY_WORKER_PATH = path.resolve(__dirname, 'pty-worker.cjs')
      const resolvedFromDist = path.resolve(root, 'dist', 'pty-worker.cjs');
      expect(fs.existsSync(resolvedFromDist)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
