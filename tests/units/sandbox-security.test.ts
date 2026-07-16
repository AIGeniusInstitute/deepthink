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

  it('browser mode publishes CDP forwarder port on 127.0.0.1 only', () => {
    const args = buildDockerRunArgs('test-sb', DEFAULT_LIMITS, true, 'deepthink-sandbox:latest');
    expect(args).not.toContain('--network=none');
    expect(args).toEqual(expect.arrayContaining(['-p', '127.0.0.1::9223']));
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
    expect(args.some((a) => a === 'nofile=1024:1024')).toBe(true);
    // tmpfs for /workspace and /tmp
    expect(args.some((a) => a.startsWith('/workspace:rw,size='))).toBe(true);
    expect(args.some((a) => a === '/tmp:rw,size=128m,mode=0700,uid=1000,gid=1000')).toBe(true);
    // non-root user
    expect(args).toContain('--user');
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
  });

  it('browser mode skips custom seccomp profile (uses Docker default) but keeps other hardening', () => {
    const args = buildDockerRunArgs('test-sb', DEFAULT_LIMITS, true, 'deepthink-sandbox:latest');
    // Docker default seccomp is applied automatically (no `seccomp=` opt)
    expect(args.some((a, i) => a === '--security-opt' && args[i + 1]?.startsWith('seccomp='))).toBe(false);
    // But hardening flags still present
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('--init');
    expect(args.some((a, i) => a === '--security-opt' && args[i + 1] === 'no-new-privileges')).toBe(true);
    expect(args).toContain('--memory');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('--user');
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
  });

  it('memory-swap equals memory (disables swap)', () => {
    const args = buildDockerRunArgs('test-sb', DEFAULT_LIMITS, false, 'deepthink-sandbox:latest');
    const memIdx = args.indexOf('--memory');
    const swapIdx = args.indexOf('--memory-swap');
    expect(args[memIdx + 1]).toBe(args[swapIdx + 1]);
  });

  it('browser mode with SANDBOX_BROWSER_NETWORK=none includes --network=none AND CDP port', () => {
    const orig = process.env.SANDBOX_BROWSER_NETWORK;
    process.env.SANDBOX_BROWSER_NETWORK = 'none';
    try {
      const args = buildDockerRunArgs('test-sb', DEFAULT_LIMITS, true, 'deepthink-sandbox:latest');
      expect(args).toContain('--network=none');
      expect(args).toEqual(expect.arrayContaining(['-p', '127.0.0.1::9223']));
      const missing = validateSecurityArgs(args);
      expect(missing).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env.SANDBOX_BROWSER_NETWORK;
      else process.env.SANDBOX_BROWSER_NETWORK = orig;
    }
  });

  it('browser mode with SANDBOX_BROWSER_NETWORK=bridge (default) omits --network=none', () => {
    const orig = process.env.SANDBOX_BROWSER_NETWORK;
    delete process.env.SANDBOX_BROWSER_NETWORK;
    try {
      const args = buildDockerRunArgs('test-sb', DEFAULT_LIMITS, true, 'deepthink-sandbox:latest');
      expect(args).not.toContain('--network=none');
      expect(args).toEqual(expect.arrayContaining(['-p', '127.0.0.1::9223']));
    } finally {
      if (orig !== undefined) process.env.SANDBOX_BROWSER_NETWORK = orig;
    }
  });
});
