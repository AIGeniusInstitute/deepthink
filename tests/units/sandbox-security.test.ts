import { describe, it, expect } from 'vitest';
import { buildDockerRunArgs, validateSecurityArgs } from '../../src/sandbox/security.js';
import { DEFAULT_LIMITS } from '../../src/sandbox/config.js';

describe('sandbox security args', () => {
  it('non-browser mode disables network', () => {
    const args = buildDockerRunArgs('test-sb', DEFAULT_LIMITS, false, 'deepthink-sandbox:latest');
    expect(args).toContain('--network=none');
    expect(args).not.toContain('-p');
    const missing = validateSecurityArgs(args);
    expect(missing).toEqual([]);
  });

  it('browser mode publishes CDP port on 127.0.0.1 only', () => {
    const args = buildDockerRunArgs('test-sb', DEFAULT_LIMITS, true, 'deepthink-sandbox:latest');
    expect(args).not.toContain('--network=none');
    expect(args).toEqual(expect.arrayContaining(['-p', '127.0.0.1::9222']));
    const missing = validateSecurityArgs(args);
    expect(missing).toEqual([]);
  });

  it('includes all hardening flags from the research doc', () => {
    const args = buildDockerRunArgs('test-sb', DEFAULT_LIMITS, false, 'deepthink-sandbox:latest');
    // Core hardening
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('--init');
    expect(args.some((a, i) => a === '--security-opt' && args[i + 1] === 'no-new-privileges')).toBe(true);
    expect(args.some((a, i) => a === '--security-opt' && args[i + 1]?.startsWith('seccomp='))).toBe(true);
    // Resource limits
    expect(args).toContain('--memory');
    expect(args).toContain('--memory-swap');
    expect(args).toContain('--cpus');
    expect(args).toContain('--pids-limit');
    // ulimits
    expect(args.some((a) => a === 'nofile=128:128')).toBe(true);
    expect(args.some((a) => a === 'nproc=64:64')).toBe(true);
    expect(args.some((a) => a.startsWith('fsize='))).toBe(true);
    // tmpfs for /workspace and /tmp
    expect(args.some((a) => a.startsWith('/workspace:rw,size='))).toBe(true);
    expect(args.some((a) => a === '/tmp:rw,size=64m,mode=0700')).toBe(true);
    // non-root user
    expect(args).toContain('--user');
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
  });

  it('memory-swap equals memory (disables swap)', () => {
    const args = buildDockerRunArgs('test-sb', DEFAULT_LIMITS, false, 'deepthink-sandbox:latest');
    const memIdx = args.indexOf('--memory');
    const swapIdx = args.indexOf('--memory-swap');
    expect(args[memIdx + 1]).toBe(args[swapIdx + 1]);
  });
});
