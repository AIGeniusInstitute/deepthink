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
export const DEFAULT_MEMORY_MB = 512;
export const DEFAULT_CPUS = 1.0;
export const DEFAULT_PIDS = 64;
export const DEFAULT_DISK_MB = 256;

/** CDP screenshot frame interval. 500ms → 2 fps. */
export const BROWSER_FRAME_INTERVAL_MS = 500;
/** CDP port inside the container (mapped to a random host port when browserEnabled). */
export const CDP_IN_CONTAINER_PORT = 9222;

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
