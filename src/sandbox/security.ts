/**
 * Sandbox Docker security argument builder.
 * Aligns with docs/prd/sandbox/sandbox-technical-solution.md §3.4 — every
 * hardening flag from the research doc is present here.
 */

import { SECCOMP_PROFILE_PATH, type SandboxLimits } from './config.js';

export function buildDockerRunArgs(
  containerName: string,
  limits: SandboxLimits,
  browserEnabled: boolean,
  image: string,
): string[] {
  const args: string[] = [
    'docker',
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
    '/tmp:rw,size=64m,mode=0700',
    '--security-opt',
    'no-new-privileges',
    '--security-opt',
    `seccomp=${SECCOMP_PROFILE_PATH}`,
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
    'nofile=128:128',
    '--ulimit',
    'nproc=64:64',
    '--ulimit',
    `fsize=${limits.disk_mb * 1024}:${limits.disk_mb * 1024}`,
    '--workdir',
    '/workspace',
    '-e',
    'ENTRY_MODE=session',
    '--init',
    '--stop-signal',
    'TERM',
    '--stop-timeout',
    '2',
  ];

  if (browserEnabled) {
    // Browser mode: publish CDP port on 127.0.0.1 (loopback only) for host
    // to connect. We trade --network=none for browser capability, but
    // CDP binding stays on 127.0.0.1 and the container is still subject to
    // seccomp + cap-drop + memory/cpu/pids limits.
    args.push('-p', '127.0.0.1::9222');
  } else {
    // Non-browser mode: fully disable network (strongest isolation).
    args.push('--network=none');
  }

  args.push(image);
  return args;
}

/**
 * Returns true if all required hardening flags are present in the given arg list.
 * Used by tests as a correctness guardrail.
 */
export function validateSecurityArgs(args: string[]): string[] {
  const missing: string[] = [];
  const checks: Array<[string, boolean]> = [
    ['--user 1000:1000', args.includes('--user') && args[args.indexOf('--user') + 1] === '1000:1000'],
    ['--read-only', args.includes('--read-only')],
    ['--security-opt no-new-privileges', args.some((a, i) => a === '--security-opt' && args[i + 1] === 'no-new-privileges')],
    ['--security-opt seccomp=...', args.some((a, i) => a === '--security-opt' && args[i + 1]?.startsWith('seccomp='))],
    ['--cap-drop ALL', args.includes('--cap-drop') && args[args.indexOf('--cap-drop') + 1] === 'ALL'],
    ['--memory', args.includes('--memory')],
    ['--memory-swap', args.includes('--memory-swap')],
    ['--cpus', args.includes('--cpus')],
    ['--pids-limit', args.includes('--pids-limit')],
    ['--ulimit nofile', args.some((a) => a === 'nofile=128:128')],
    ['--ulimit nproc', args.some((a) => a === 'nproc=64:64')],
    ['--ulimit fsize', args.some((a) => a.startsWith('fsize='))],
    ['--init', args.includes('--init')],
  ];
  for (const [name, ok] of checks) {
    if (!ok) missing.push(name);
  }
  // Either --network=none OR -p 127.0.0.1::9222 (browser mode)
  const hasNetworkNone = args.includes('--network=none');
  const hasBrowserPort = args.some((a) => a === '127.0.0.1::9222');
  if (!hasNetworkNone && !hasBrowserPort) {
    missing.push('--network=none OR -p 127.0.0.1::9222');
  }
  return missing;
}
