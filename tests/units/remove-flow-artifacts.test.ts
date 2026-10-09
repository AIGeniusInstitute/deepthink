/**
 * removeFlowArtifacts —— 工作区删除时必须清干净的 6 个 per-folder 目录 + container-env 配置。
 *
 * 这个测试的由来：`data/extra/{folder}`（容器内 /workspace/extra，含 .npm-global 全局包）
 * 长期不在清理清单里，删除工作区后留下孤儿目录。加目录容易，加漏更容易，所以这里
 * 逐个断言，并额外断言**同级的其它 folder 不受影响**（防止有人把删除写成扫父目录）。
 *
 * 点 DEEPTHINK_DATA_DIR 到临时目录再 import，避免碰到真实数据目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDir = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-flow-artifacts-'));
  process.env.DEEPTHINK_DATA_DIR = dir;
  return dir;
});

import { removeFlowArtifacts } from '../../src/file-manager.js';
import { DATA_DIR, GROUPS_DIR } from '../../src/config.js';

const FOLDER = 'agent-11111111-1111-1111-1111-111111111111';
const SIBLING = 'agent-22222222-2222-2222-2222-222222222222';

/** 该 folder 应该被删掉的 6 个目录（GROUPS_DIR 单独算，它不在 DATA_DIR 下） */
function artifactPaths(folder: string): string[] {
  return [
    path.join(GROUPS_DIR, folder),
    path.join(DATA_DIR, 'sessions', folder),
    path.join(DATA_DIR, 'ipc', folder),
    path.join(DATA_DIR, 'env', folder),
    path.join(DATA_DIR, 'memory', folder),
    path.join(DATA_DIR, 'extra', folder),
  ];
}

function containerEnvPath(folder: string): string {
  return path.join(DATA_DIR, 'config', 'container-env', `${folder}.json`);
}

beforeAll(() => {
  for (const folder of [FOLDER, SIBLING]) {
    for (const p of artifactPaths(folder)) {
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'marker.txt'), folder);
    }
    // extra/ 里放一个像 .npm-global 的嵌套结构，确认递归删除真的到底
    fs.mkdirSync(path.join(DATA_DIR, 'extra', folder, '.npm-global', 'lib', 'node_modules'), {
      recursive: true,
    });
    fs.mkdirSync(path.dirname(containerEnvPath(folder)), { recursive: true });
    fs.writeFileSync(containerEnvPath(folder), '{"A":"1"}');
  }
  // 确认前置条件成立（否则后面的断言可能是"本来就没有"）
  for (const p of artifactPaths(FOLDER)) expect(fs.existsSync(p)).toBe(true);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('removeFlowArtifacts', () => {
  test('删除该 folder 的全部 6 个目录 + container-env 配置', () => {
    removeFlowArtifacts(FOLDER);

    for (const p of artifactPaths(FOLDER)) {
      expect(fs.existsSync(p), `${p} 应被删除`).toBe(false);
    }
    expect(fs.existsSync(containerEnvPath(FOLDER))).toBe(false);
  });

  test('data/extra/{folder} 被递归删到底（含 .npm-global）', () => {
    // 上面已删；重建一份再删一次，确保断言针对的是本次行为而不是残留
    const nested = path.join(DATA_DIR, 'extra', FOLDER, '.npm-global', 'lib', 'node_modules', 'x');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'pkg.json'), '{}');
    expect(fs.existsSync(nested)).toBe(true);

    removeFlowArtifacts(FOLDER);

    expect(fs.existsSync(path.join(DATA_DIR, 'extra', FOLDER))).toBe(false);
  });

  test('同级的其它 folder 一个都不动', () => {
    removeFlowArtifacts(FOLDER);

    for (const p of artifactPaths(SIBLING)) {
      expect(fs.existsSync(p), `${p} 不该被删`).toBe(true);
    }
    expect(fs.existsSync(containerEnvPath(SIBLING))).toBe(true);
    expect(fs.readFileSync(path.join(DATA_DIR, 'extra', SIBLING, 'marker.txt'), 'utf8')).toBe(SIBLING);
  });

  test('对不存在的 folder 是幂等的（force: true，不抛错）', () => {
    expect(() => removeFlowArtifacts('agent-does-not-exist')).not.toThrow();
    expect(fs.existsSync(path.join(DATA_DIR, 'extra', 'agent-does-not-exist'))).toBe(false);
  });
});
