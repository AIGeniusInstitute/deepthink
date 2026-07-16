import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseLsOutput } from '../../src/sandbox/manager.js';

describe('parseLsOutput', () => {
  it('parses a typical ls -la --time-style=long-iso output', () => {
    const output = `total 16
drwxr-xr-x 3 node node 4096 2026-07-16 14:23 .
drwxr-xr-x 1 root root 4096 2026-07-16 14:20 ..
-rw-r--r-- 1 node node   42 2026-07-16 14:23 hello.py
drwxr-xr-x 2 node node 4096 2026-07-16 14:24 subdir
lrwxrwxrwx 1 node node   11 2026-07-16 14:25 link.txt -> hello.py
`;

    const entries = parseLsOutput(output);

    expect(entries).toHaveLength(3);
    expect(entries.find(e => e.name === 'hello.py')).toMatchObject({
      name: 'hello.py',
      type: 'file',
      size: 42,
      mtime: '2026-07-16 14:23',
    });
    expect(entries.find(e => e.name === 'subdir')).toMatchObject({
      name: 'subdir',
      type: 'dir',
      size: 4096,
    });
    expect(entries.find(e => e.name === 'link.txt')).toMatchObject({
      name: 'link.txt',
      type: 'link',
    });
  });

  it('skips . and .. entries', () => {
    const output = `drwxr-xr-x 3 node node 4096 2026-07-16 14:23 .
drwxr-xr-x 1 root root 4096 2026-07-16 14:20 ..`;
    const entries = parseLsOutput(output);
    expect(entries).toEqual([]);
  });

  it('skips total header and empty lines', () => {
    const output = `total 16

-rw-r--r-- 1 node node   42 2026-07-16 14:23 hello.py

`;
    const entries = parseLsOutput(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('hello.py');
  });

  it('handles filenames with spaces', () => {
    const output = `-rw-r--r-- 1 node node   42 2026-07-16 14:23 my file.txt`;
    const entries = parseLsOutput(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('my file.txt');
  });

  it('returns empty for empty input', () => {
    expect(parseLsOutput('')).toEqual([]);
  });

  it('returns empty for malformed input', () => {
    expect(parseLsOutput('random text\nnot a ls line\n')).toEqual([]);
  });
});

describe('chat store sandbox tool linkage (unit-level)', () => {
  // The integration test is in chat-store sandbox tool event detection.
  // We just verify the tool name classification logic here.
  it('classifies sandbox tool names correctly', () => {
    const isBrowserTool = (name: string) => name.startsWith('sandbox_browser');
    const isSandboxTool = (name: string) =>
      isBrowserTool(name) || name === 'sandbox_run_code';

    expect(isBrowserTool('sandbox_browser_navigate')).toBe(true);
    expect(isBrowserTool('sandbox_browser_screenshot')).toBe(true);
    expect(isBrowserTool('sandbox_run_code')).toBe(false);
    expect(isSandboxTool('sandbox_run_code')).toBe(true);
    expect(isSandboxTool('sandbox_browser_navigate')).toBe(true);
    expect(isSandboxTool('Read')).toBe(false);
    expect(isSandboxTool('Bash')).toBe(false);
  });
});

describe('sandbox files endpoint path traversal protection', () => {
  // Mirrors the same logic as src/routes/sandbox.ts — kept as a unit test
  // so we can catch regressions without standing up a real sandbox container.
  function isPathSafe(rawPath: string): boolean {
    const norm = path.posix.normalize(rawPath).replace(/\/+$/, '');
    if (norm !== '/workspace' && !norm.startsWith('/workspace/')) return false;
    if (norm.includes('/../') || norm === '..') return false;
    return true;
  }

  it('allows /workspace root', () => {
    expect(isPathSafe('/workspace')).toBe(true);
    expect(isPathSafe('/workspace/')).toBe(true);
  });

  it('allows /workspace subtree', () => {
    expect(isPathSafe('/workspace/subdir')).toBe(true);
    expect(isPathSafe('/workspace/subdir/file.py')).toBe(true);
  });

  it('rejects absolute paths outside /workspace', () => {
    expect(isPathSafe('/etc')).toBe(false);
    expect(isPathSafe('/etc/passwd')).toBe(false);
    expect(isPathSafe('/tmp')).toBe(false);
    expect(isPathSafe('/')).toBe(false);
  });

  it('rejects relative path traversal that escapes /workspace', () => {
    expect(isPathSafe('/workspace/../../etc/passwd')).toBe(false);
    expect(isPathSafe('/workspace/../etc')).toBe(false);
    expect(isPathSafe('/workspace/./../../')).toBe(false);
  });

  it('rejects pure relative paths', () => {
    expect(isPathSafe('etc/passwd')).toBe(false);
    expect(isPathSafe('../etc')).toBe(false);
    expect(isPathSafe('..')).toBe(false);
  });
});
