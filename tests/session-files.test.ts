import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepthink-session-'));

vi.mock('../src/config.js', () => ({
  DATA_DIR: tmpRoot,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER the mocks are registered so session-files picks up the mocked
// DATA_DIR at evaluation time.
const { clearSessionFiles } = await import('../src/session-files.ts');

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'sessions'), { recursive: true, force: true });
});

afterEach(() => {
  // no-op; tmpRoot kept for whole suite, subdirs scrubbed per-test
});

function touch(filePath: string, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('clearSessionFiles', () => {
  test('removes everything under .claude/ except settings.json', () => {
    const folder = 'main';
    const claudeDir = path.join(tmpRoot, 'sessions', folder, '.claude');
    touch(path.join(claudeDir, 'settings.json'), '{"keep":true}');
    touch(path.join(claudeDir, 'projects', 'foo', '1.jsonl'), 'line');
    touch(path.join(claudeDir, 'debug', 'sdk.txt'), 'debug');
    touch(path.join(claudeDir, 'CLAUDE.md'), '# runtime');

    clearSessionFiles(folder);

    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'debug'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(false);
  });

  test('agent-scoped clear only affects the given agent subdir', () => {
    const folder = 'main';
    const agentId = 'agent-xyz';
    const mainDir = path.join(tmpRoot, 'sessions', folder, '.claude');
    const agentDir = path.join(
      tmpRoot,
      'sessions',
      folder,
      'agents',
      agentId,
      '.claude',
    );
    touch(path.join(mainDir, 'projects', 'p.jsonl'));
    touch(path.join(agentDir, 'projects', 'a.jsonl'));
    touch(path.join(agentDir, 'settings.json'), '{}');

    clearSessionFiles(folder, agentId);

    expect(fs.existsSync(path.join(mainDir, 'projects', 'p.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, 'settings.json'))).toBe(true);
  });

  test('no-op when .claude dir does not exist', () => {
    expect(() => clearSessionFiles('never-created')).not.toThrow();
  });

  test('survives a broken symlink inside .claude/', () => {
    const folder = 'main';
    const claudeDir = path.join(tmpRoot, 'sessions', folder, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    touch(path.join(claudeDir, 'settings.json'));
    fs.symlinkSync(
      '/nonexistent/path/to/nowhere',
      path.join(claudeDir, 'stale-link'),
    );

    // Core guarantee: the per-entry try/catch means a problematic symlink
    // does NOT abort the whole reset — settings.json must survive regardless
    // of whether the symlink itself is cleanable on the current platform.
    expect(() => clearSessionFiles(folder)).not.toThrow();
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
  });
});
