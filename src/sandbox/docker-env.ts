/**
 * Resolves the environment to pass to `docker` child processes.
 *
 * Docker Desktop's daemon may require a newer API version than the `docker`
 * CLI on $PATH (e.g. client 1.42 vs daemon min 1.44). Without an override,
 * every `docker` invocation fails with "client version X is too old", which
 * surfaces to the user as a 400 on POST /api/sandbox/sessions because the
 * sandbox container never starts.
 *
 * We probe once: if `docker ps` works as-is, no override is needed;
 * otherwise we parse the daemon's "Minimum supported API version" from the
 * error and pin DOCKER_API_VERSION for all subsequent spawns. Cached for the
 * process lifetime so every docker spawn site (SandboxManager + BrowserController)
 * shares one probe.
 */

import { spawn } from 'child_process';
import { logger } from '../logger.js';

let cache: NodeJS.ProcessEnv | undefined = undefined;

function rawSpawn(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', (err) => resolve({ ok: false, stdout, stderr: stderr + err.message }));
    proc.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

/**
 * Returns the env to pass to `docker` spawns. Probes the daemon on first call.
 * `docker version` is unreliable on a client/daemon mismatch (it returns an
 * empty "Error response from daemon:" rather than the negotiation message),
 * so we probe with `docker ps`, which surfaces the full message:
 *   "client version X is too old. Minimum supported API version is Y"
 */
export async function resolveDockerEnv(): Promise<NodeJS.ProcessEnv> {
  if (cache !== undefined) return cache;
  const probe = await rawSpawn(['ps', '--format', '{{.Names}}']);
  if (probe.ok) {
    cache = process.env;
    return cache;
  }
  const msg = `${probe.stderr}\n${probe.stdout}`;
  const m = msg.match(/Minimum supported API version is (\d+\.\d+)/);
  if (m) {
    logger.warn(
      { pinned: m[1] },
      'Docker client API version too old for daemon; pinning DOCKER_API_VERSION',
    );
    cache = { ...process.env, DOCKER_API_VERSION: m[1] };
  } else {
    // Unknown failure — don't override; let the real error surface upstream.
    cache = process.env;
  }
  return cache;
}

/**
 * Synchronous accessor for the resolved env. Used by spawn sites that can't
 * await (e.g. BrowserController.spawnInContainer inside a Promise executor).
 * The cache is populated by the first create()/spawnDocker() call, which
 * always runs before any browser or terminal command on that session. Falls
 * back to process.env if not yet probed.
 */
export function dockerEnvSync(): NodeJS.ProcessEnv {
  return cache ?? process.env;
}
