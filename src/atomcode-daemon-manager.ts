/**
 * AtomCode daemon lifecycle manager.
 *
 * AtomCode ships an HTTP/SSE daemon (invoked as `atomcode daemon --port <port>`)
 * that exposes `/chat` (streaming) and `/providers` (REST). DeepThink's
 * agent-runner starts one daemon per agent-runner process on a random
 * loopback port, drives a chat session through it, then shuts it down on exit.
 *
 * The manager here is also used by the main process's config routes to
 * spin up a temporary daemon for provider management operations.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

import { logger } from './logger.js';

export interface AtomcodeDaemonInstance {
  baseUrl: string;
  process: ChildProcess;
  port: number;
  binaryPath: string;
}

export interface AtomcodeDaemonOpts {
  binaryPath: string;
  port?: number;            // if undefined, auto-pick a free port in [basePort, basePort+portRange)
  basePort?: number;       // default 14000
  portRange?: number;      // default 100
  host?: string;           // default '127.0.0.1'
  atomcodeHome?: string;   // ATOMCODE_HOME; empty = use default ~/.atomcode
  logFile?: string;        // stderr log file
  extraEnv?: Record<string, string>;
  timeoutMs?: number;      // health-check timeout, default 30000
}

/** Pick a free TCP port in [basePort, basePort+portRange). Returns 0 if all taken. */
function pickFreePort(basePort: number, portRange: number): number {
  const tried = new Set<number>();
  for (let attempt = 0; attempt < portRange; attempt++) {
    const offset = Math.floor(Math.random() * portRange);
    if (tried.has(offset)) continue;
    tried.add(offset);
    const port = basePort + offset;
    // Best-effort sync probe: try to listen and immediately close.
    // EADDRINUSE fires async but a successful listen emits 'listening' on next tick.
    // We rely on the synchronous side-effect of throw on bind error in some platforms.
    const server = net.createServer();
    try {
      server.listen(port, '127.0.0.1');
      server.close();
      return port;
    } catch {
      continue;
    }
  }
  return 0;
}

/** Health-check an atomcode-daemon. Returns {ok, version?, error?}. */
export async function checkAtomcodeHealth(
  baseUrl: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; version?: string; service?: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      status?: string;
      version?: string;
      service?: string;
    };
    if (body.status !== 'ok') {
      return { ok: false, error: `status=${body.status}` };
    }
    return {
      ok: true,
      version: body.version,
      service: body.service,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Wait until /health responds ok, or timeout. */
async function waitForHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'timeout';
  while (Date.now() < deadline) {
    const res = await checkAtomcodeHealth(baseUrl, 2000);
    if (res.ok) return res;
    lastErr = res.error ?? 'unknown';
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, error: `health-check timeout: ${lastErr}` };
}

/** Spawn an atomcode daemon process and wait for /health. */
export async function startAtomcodeDaemon(
  opts: AtomcodeDaemonOpts,
): Promise<AtomcodeDaemonInstance> {
  const {
    binaryPath,
    basePort = 14000,
    portRange = 100,
    host = '127.0.0.1',
    atomcodeHome,
    logFile,
    extraEnv,
    timeoutMs = 30000,
  } = opts;

  if (!binaryPath) {
    throw new Error('atomcode binaryPath is empty');
  }
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`atomcode binary not found at ${binaryPath}`);
  }

  // Pick a free port
  let port = opts.port ?? 0;
  if (!port) {
    port = pickFreePort(basePort, portRange);
    if (!port) {
      throw new Error(
        `No free port in [${basePort}, ${basePort + portRange}) for atomcode daemon`,
      );
    }
  }

  // atomcode daemon always binds to 127.0.0.1; `--host` flag is not supported.
  const args = ['daemon', '--port', String(port)];
  const env: Record<string, string> = {
    ...process.env,
    ...(extraEnv || {}),
  } as Record<string, string>;
  if (atomcodeHome) {
    env.ATOMCODE_HOME = atomcodeHome;
  }

  let stderrStream: fs.WriteStream | undefined;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      stderrStream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch {
      // ignore
    }
  }

  logger.info(
    { binaryPath, port, atomcodeHome: atomcodeHome || '<default>' },
    'Spawning atomcode daemon',
  );

  const proc = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: false,
  });

  if (stderrStream) {
    proc.stderr?.pipe(stderrStream);
  } else {
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trimEnd();
      if (line) logger.debug({ component: 'atomcode-daemon' }, line);
    });
  }
  proc.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trimEnd();
    if (line) logger.debug({ component: 'atomcode-daemon:stdout' }, line);
  });
  proc.on('exit', (code, sig) => {
    logger.info(
      { code, sig, port },
      'atomcode daemon process exited',
    );
  });
  proc.on('error', (err) => {
    logger.error({ err, port }, 'atomcode daemon process error');
  });

  const baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host || '127.0.0.1'}:${port}`;

  // Wait for health
  const health = await waitForHealth(baseUrl, timeoutMs);
  if (!health.ok) {
    try {
      proc.kill('SIGKILL');
    } catch { /* ignore */ }
    throw new Error(
      `atomcode daemon failed to become healthy at ${baseUrl}: ${health.error}`,
    );
  }

  logger.info({ baseUrl, version: health.version }, 'atomcode daemon ready');

  return {
    baseUrl,
    process: proc,
    port,
    binaryPath,
  };
}

/** Stop an atomcode daemon process gracefully (SIGTERM -> 10s -> SIGKILL). */
export async function stopAtomcodeDaemon(
  inst: AtomcodeDaemonInstance,
  graceMs = 10000,
): Promise<void> {
  const proc = inst.process;
  if (proc.exitCode !== null || proc.killed) return;

  return new Promise<void>((resolve) => {
    const onExit = () => {
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', onExit);
    try {
      proc.kill('SIGTERM');
    } catch { /* ignore */ }
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch { /* ignore */ }
      resolve();
    }, graceMs);
  });
}
