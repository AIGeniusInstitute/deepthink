import { spawn, ChildProcess, execFileSync } from 'child_process';
import fs from 'fs';
import { backendEntry, nodeBinary, dataDir, logDir, backendLogPath, agentRunnerDir, webDistDir } from './paths.js';
import { findFreePort } from './port-resolver.js';

const READY_TIMEOUT_MS = 60_000;
const READY_PROBE_INTERVAL_MS = 200;

export interface StartResult {
  port: number;
  proc: ChildProcess;
}

export class BackendSupervisor {
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private logStream: fs.WriteStream | null = null;
  private restartCount = 0;
  private stopped = false;
  private readyResolve: ((port: number) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  async start(): Promise<StartResult> {
    const port = await findFreePort(49281, 49300);
    this.port = port;
    this.openLogStream();
    this.log(`[supervisor] starting backend on port ${port}`);

    const env = this.buildEnv(port);
    this.log(`[supervisor] node binary: ${nodeBinary}`);
    this.log(`[supervisor] backend entry: ${backendEntry}`);
    this.log(`[supervisor] data dir: ${dataDir}`);
    this.log(`[supervisor] agent runner dir: ${agentRunnerDir}`);
    this.log(`[supervisor] web dist dir: ${webDistDir}`);

    const proc = spawn(nodeBinary, [backendEntry], {
      env: { ...process.env, ...env },
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
    proc.on('exit', (code, signal) => this.onExit(code, signal));

    await this.waitForReady(port);
    return { port, proc };
  }

  private buildEnv(port: number): NodeJS.ProcessEnv {
    // When running under Electron's binary (dev mode), force Node-only behavior
    // so the backend process acts as plain Node rather than spawning a window.
    const isElectronBinary = /electron/i.test(nodeBinary);
    return {
      ELECTRON_RUN_AS_NODE: isElectronBinary ? '1' : '',
      DEEPTHINK_DATA_DIR: dataDir,
      DEEPTHINK_AGENT_RUNNER_DIR: agentRunnerDir,
      DEEPTHINK_WEB_DIST_DIR: webDistDir,
      WEB_PORT: String(port),
      ASSISTANT_NAME: 'DeepThink',
      NODE_ENV: 'production',
      FORCE_COLOR: '0',
      // macOS Electron GUI apps don't load shell profiles (.zshrc/.zprofile),
      // so the inherited PATH only contains /usr/bin:/bin:/usr/sbin:/sbin.
      // That misses homebrew (/opt/homebrew/bin or /usr/local/bin), nvm, asdf,
      // volta, ~/.local/bin, etc. — any spawn of npx/node/npm from the backend
      // fails with ENOENT (e.g. installSkillForUser -> npx skills add).
      // Resolve the user's login-shell PATH once at startup and merge with
      // the current PATH so backend subprocesses can find user-installed tools.
      PATH: resolveBackendPath(),
    };
  }

  private openLogStream(): void {
    fs.mkdirSync(logDir, { recursive: true });
    this.logStream = fs.createWriteStream(backendLogPath, { flags: 'a' });
  }

  private log(line: string): void {
    const ts = new Date().toISOString();
    const formatted = `${ts} ${line}\n`;
    this.logStream?.write(formatted);
    // eslint-disable-next-line no-console
    console.log(line);
  }

  private onStdout(chunk: Buffer): void {
    this.logStream?.write(chunk);
    const text = chunk.toString();
    // Detect ready signal: Hono @hono/node-server prints "Server listening on" or
    // we rely on HTTP probe. Both paths handled below.
    if (this.readyResolve && /listening|Server listening|started on/i.test(text)) {
      // Resolve after a tiny tick to let socket settle
      this.readyResolve(this.port!);
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  private onStderr(chunk: Buffer): void {
    this.logStream?.write(Buffer.concat([Buffer.from('[stderr] '), chunk]));
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.log(`[supervisor] backend exited code=${code} signal=${signal}`);
    if (this.readyReject) {
      this.readyReject(new Error(`Backend exited before ready (code=${code} signal=${signal})`));
      this.readyResolve = null;
      this.readyReject = null;
    }
    if (this.stopped) return;
    this.restartCount += 1;
    if (this.restartCount > 3) {
      this.log('[supervisor] max restart attempts exceeded, giving up');
      return;
    }
    const delayMs = 1000 * Math.pow(2, this.restartCount - 1);
    this.log(`[supervisor] scheduling restart #${this.restartCount} in ${delayMs}ms`);
    setTimeout(() => {
      if (this.stopped) return;
      this.start().catch((err) => this.log(`[supervisor] restart failed: ${err.message}`));
    }, delayMs);
  }

  private async waitForReady(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Backend did not become ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);

      this.readyResolve = (p) => {
        clearTimeout(timeout);
        resolve(p);
      };
      this.readyReject = (err) => {
        clearTimeout(timeout);
        reject(err);
      };

      // HTTP probe fallback: poll /api/health until 200
      const probe = async () => {
        if (this.stopped) return;
        try {
          const ok = await httpGetOk(`http://127.0.0.1:${port}/api/health`);
          if (ok && this.readyResolve) {
            this.readyResolve(port);
            return;
          }
        } catch {
          // not ready yet
        }
        setTimeout(probe, READY_PROBE_INTERVAL_MS);
      };
      setTimeout(probe, 300);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const port = this.port;
    if (!this.proc || this.proc.exitCode !== null) {
      // Even without a proc ref, kill anything still listening on the port
      if (port) killPortListeners(port, (l) => this.log(l));
      this.logStream?.end();
      return;
    }
    this.log('[supervisor] sending SIGTERM');
    this.proc.kill('SIGTERM');
    await waitExit(this.proc, 5000).catch(() => {
      this.log('[supervisor] SIGKILL after timeout');
      this.proc?.kill('SIGKILL');
    });
    // Belt-and-suspenders: kill any descendant that escaped the process group
    // and is still holding the port (e.g. spawned Docker/agent subprocesses).
    if (port) killPortListeners(port, (l) => this.log(l));
    this.logStream?.end();
  }

  get currentPort(): number | null {
    return this.port;
  }
}

// Common user-level bin directories appended as a safety net when login-shell
// resolution fails or the user has a non-standard setup.
const FALLBACK_PATH_ENTRIES = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
];

let cachedBackendPath: string | null = null;

// macOS Electron GUI apps don't load shell profiles (.zshrc/.zprofile), so the
// inherited PATH only contains /usr/bin:/bin:/usr/sbin:/sbin and misses
// homebrew, nvm, asdf, volta, ~/.local/bin, etc. Resolve the user's login-shell
// PATH once at startup and merge with the inherited PATH + a small fallback list
// so backend subprocesses (e.g. `npx skills add`) can find user-installed tools.
function resolveBackendPath(): string {
  if (cachedBackendPath !== null) return cachedBackendPath;

  const inherited = (process.env.PATH || '').split(':').filter(Boolean);
  const shell = process.env.SHELL || '/bin/zsh';
  let shellPath: string[] = [];
  try {
    const out = execFileSync(shell, ['-l', '-i', '-c', 'printf %s "$PATH"'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    shellPath = out.split(':').filter(Boolean);
  } catch {
    // Ignore — fall back to inherited + FALLBACK_PATH_ENTRIES below.
  }

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const p of [...shellPath, ...inherited, ...FALLBACK_PATH_ENTRIES]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      merged.push(p);
    }
  }

  cachedBackendPath = merged.join(':');
  return cachedBackendPath;
}

function waitExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function httpGetOk(url: string): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Kill every process listening on `port` (TCP LISTEN state only).
 *
 * Why -sTCP:LISTEN: a bare `lsof -ti:PORT` would also catch processes that
 * merely have a connection to the port (OrbStack/Docker proxies, etc.),
 * which can crash the Docker daemon. Restricting to LISTEN sockets targets
 * only the actual server process — same rule the project's CLAUDE.md
 * mandates for shutting down the dev server.
 */
function killPortListeners(port: number, log: (line: string) => void): void {
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = out
      .trim()
      .split('\n')
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (pids.length === 0) return;
    log(`[supervisor] killing ${pids.length} lingering listener(s) on port ${port}: ${pids.join(', ')}`);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  } catch {
    // lsof returns non-zero when no listener matches — nothing to kill.
  }
}

// Keep ref for hot path
export const supervisorSingleton = new BackendSupervisor();
