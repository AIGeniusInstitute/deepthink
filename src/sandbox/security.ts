/**
 * Sandbox Docker security argument builder.
 * Aligns with docs/prd/sandbox/sandbox-technical-solution.md §3.4 — every
 * hardening flag from the research doc is present here for non-browser mode.
 *
 * Browser mode uses Docker's default seccomp profile (instead of our strict
 * custom profile) because Chromium needs ~200+ syscalls that would make
 * a hand-maintained whitelist brittle. Docker's default still blocks
 * namespace-creation syscalls (ptrace / mount / unshare / keyctl / bpf /
 * perf_event_open) that are the actual container-escape vectors, while
 * cap-drop ALL + non-root + read-only + memory/cpu/pids limits handle
 * the rest of the hardening.
 */

import { SECCOMP_PROFILE_PATH, getBrowserNetworkMode, type SandboxLimits } from './config.js';
import { logger } from '../logger.js';

export function buildDockerRunArgs(
  containerName: string,
  limits: SandboxLimits,
  browserEnabled: boolean,
  image: string,
): string[] {
  const args: string[] = [
    'run',
    '-d', // detached — session mode
    '--rm',
    '--name',
    containerName,
    '--user',
    '1000:1000',
    '--read-only',
    '--tmpfs',
    `/workspace:rw,size=${limits.disk_mb}m,mode=0700,uid=1000,gid=1000`,
    '--tmpfs',
    '/tmp:rw,size=128m,mode=0700,uid=1000,gid=1000',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--memory',
    `${limits.memory_mb}m`,
    '--memory-swap',
    `${limits.memory_mb}m`,
    '--cpus',
    String(limits.cpus),
    '--pids-limit',
    String(limits.pids_max),
    '--ulimit',
    'nofile=1024:1024',
    '--workdir',
    '/workspace',
    '-e',
    'ENTRY_MODE=session',
    '-e',
    'HOME=/tmp',
    '--init',
    '--stop-signal',
    'TERM',
    '--stop-timeout',
    '2',
  ];

  if (browserEnabled) {
    // Browser mode: publish CDP forwarder port on 127.0.0.1 (loopback only)
    // for host to connect. Chromium 150 ignores `--remote-debugging-address`
    // and binds 127.0.0.1:9222 — cdp-forwarder.js bridges 0.0.0.0:9223 →
    // 127.0.0.1:9222 so Docker's port mapping can forward host traffic.
    // The container is still subject to cap-drop + memory/cpu/pids limits.
    //
    // NOTE: We intentionally do NOT apply our strict custom seccomp profile
    // here — Chromium needs ~200+ syscalls that would make a hand-maintained
    // whitelist brittle. Docker's default seccomp profile (applied
    // automatically when no `seccomp=` opt is passed) still blocks the
    // namespace-creation / kernel-exploit syscalls that matter for escape
    // prevention.
    const mode = getBrowserNetworkMode();
    switch (mode) {
      case 'none':
        // Docker permits --network=none + -p 127.0.0.1::9223 — the port
        // mapping uses loopback forwarding only, independent of the
        // container's network namespace. Strongest browser isolation.
        args.push('--network=none', '-p', '127.0.0.1::9223');
        break;
      case 'restricted':
        // P2: requires Linux + iptables for egress whitelist. Fall back.
        logger.warn(
          'SANDBOX_BROWSER_NETWORK=restricted not implemented, falling back to bridge',
        );
        args.push('-p', '127.0.0.1::9223');
        break;
      case 'bridge':
      default:
        args.push('-p', '127.0.0.1::9223');
        break;
    }
  } else {
    // Non-browser mode: apply our strict custom seccomp profile (default-deny
    // whitelist) and fully disable network — strongest isolation.
    args.push(
      '--security-opt',
      `seccomp=${SECCOMP_PROFILE_PATH}`,
      '--network=none',
    );
  }

  args.push(image);
  return args;
}

/**
 * Returns the missing hardening flags in the given arg list.
 * Used by tests as a correctness guardrail.
 *
 * `seccomp=` is optional — non-browser mode applies our strict custom
 * profile; browser mode relies on Docker's default seccomp (applied
 * automatically when no `seccomp=` opt is passed), which still blocks
 * namespace-creation / kernel-exploit syscalls.
 */
export function validateSecurityArgs(args: string[]): string[] {
  const missing: string[] = [];
  const checks: Array<[string, boolean]> = [
    ['--user 1000:1000', args.includes('--user') && args[args.indexOf('--user') + 1] === '1000:1000'],
    ['--read-only', args.includes('--read-only')],
    ['--security-opt no-new-privileges', args.some((a, i) => a === '--security-opt' && args[i + 1] === 'no-new-privileges')],
    ['--cap-drop ALL', args.includes('--cap-drop') && args[args.indexOf('--cap-drop') + 1] === 'ALL'],
    ['--memory', args.includes('--memory')],
    ['--memory-swap', args.includes('--memory-swap')],
    ['--cpus', args.includes('--cpus')],
    ['--pids-limit', args.includes('--pids-limit')],
    ['--ulimit nofile', args.some((a) => a === 'nofile=1024:1024')],
    ['--init', args.includes('--init')],
  ];
  for (const [name, ok] of checks) {
    if (!ok) missing.push(name);
  }
  // Either --network=none OR -p 127.0.0.1::9223 (browser mode)
  const hasNetworkNone = args.includes('--network=none');
  const hasBrowserPort = args.some((a) => a === '127.0.0.1::9223');
  if (!hasNetworkNone && !hasBrowserPort) {
    missing.push('--network=none OR -p 127.0.0.1::9223');
  }
  return missing;
}
