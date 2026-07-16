/**
 * Sandbox module constants and configuration.
 */

import path from 'path';

export const SANDBOX_IMAGE =
  process.env.SANDBOX_IMAGE || 'deepthink-sandbox:latest';

export const SECCOMP_PROFILE_PATH =
  process.env.SANDBOX_SECCOMP_PROFILE ||
  path.join(process.cwd(), 'container', 'sandbox', 'seccomp-profile.json');

export const MAX_CONCURRENT_SANDBOXES = parseInt(
  process.env.MAX_CONCURRENT_SANDBOXES || '10',
  10,
);
export const MAX_PER_USER_SANDBOXES = parseInt(
  process.env.MAX_PER_USER_SANDBOXES || '3',
  10,
);

/** Idle timeout: 10 minutes with no exec/terminal I/O → destroy. */
export const IDLE_TIMEOUT_MS = parseInt(
  process.env.SANDBOX_IDLE_TIMEOUT_MS || String(10 * 60 * 1000),
  10,
);
/** Hard timeout: 30 minutes max lifetime regardless of activity. */
export const HARD_TIMEOUT_MS = parseInt(
  process.env.SANDBOX_HARD_TIMEOUT_MS || String(30 * 60 * 1000),
  10,
);

export const OUTPUT_LIMIT_BYTES = 1024 * 1024; // 1 MB per stream

export const DEFAULT_WALL_TIMEOUT_MS = 30_000;
export const DEFAULT_MEMORY_MB = 2048;
export const DEFAULT_CPUS = 2.0;
export const DEFAULT_PIDS = 256;
export const DEFAULT_DISK_MB = 256;

/**
 * CDP screenshot frame interval. 250ms → 4 fps. Lower than 250ms overloads
 * chromium's screenshot pipeline and causes frame drops on heavy pages. */
export const BROWSER_FRAME_INTERVAL_MS = 250;
/**
 * Forwarder port inside the container (mapped to a random host port when
 * browserEnabled). Chromium 150 ignores `--remote-debugging-address` and
 * always binds 127.0.0.1:9222, so cdp-forwarder.js bridges 0.0.0.0:9223 →
 * 127.0.0.1:9222 to make it reachable from the host via Docker port mapping.
 */
export const CDP_IN_CONTAINER_PORT = 9223;
/** Chromium's internal loopback DevTools port (only reachable via forwarder). */
export const CHROMIUM_DEVTOOLS_PORT = 9222;

/**
 * Browser sandbox network mode.
 *  - 'bridge' (default): full network access, browser can reach any URL
 *  - 'none':              --network=none + CDP port mapped on 127.0.0.1
 *                         (browser can only load about:blank or local HTML)
 *  - 'restricted':        P2 — not yet implemented (requires Linux + iptables
 *                         egress whitelist on a custom Docker network).
 *                         Falls back to 'bridge'.
 */
export type BrowserNetworkMode = 'bridge' | 'none' | 'restricted';

/** Resolve browser network mode from env at call time (test-friendly). */
export function getBrowserNetworkMode(): BrowserNetworkMode {
  const v = process.env.SANDBOX_BROWSER_NETWORK as BrowserNetworkMode | undefined;
  if (v === 'none' || v === 'bridge' || v === 'restricted') return v;
  return 'bridge';
}

export type SandboxStatus =
  | 'created'
  | 'running'
  | 'idle'
  | 'stopped'
  | 'error';

export type SandboxLanguage = 'python' | 'node' | 'sh';

export interface SandboxLimits {
  wall_timeout_ms: number;
  memory_mb: number;
  cpus: number;
  disk_mb: number;
  pids_max: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  wall_timeout_ms: DEFAULT_WALL_TIMEOUT_MS,
  memory_mb: DEFAULT_MEMORY_MB,
  cpus: DEFAULT_CPUS,
  disk_mb: DEFAULT_DISK_MB,
  pids_max: DEFAULT_PIDS,
};
