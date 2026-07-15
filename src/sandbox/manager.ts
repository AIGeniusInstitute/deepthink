/**
 * SandboxManager — singleton that orchestrates sandbox container lifecycle.
 *
 * Each sandbox:
 *   - Runs as a detached `docker run -d` (session mode)
 *   - Is uniquely identified by id (sb-<hex>)
 *   - Has per-session exec serialization (only one exec at a time per session)
 *   - Has idle/hard timeouts enforced via setTimeout
 *   - Persists state in `sandbox_sessions` / `sandbox_executions` DB tables
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import { logger } from '../logger.js';
import { getDb } from '../db.js';
import {
  BROWSER_FRAME_INTERVAL_MS,
  CDP_IN_CONTAINER_PORT,
  DEFAULT_LIMITS,
  HARD_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_CONCURRENT_SANDBOXES,
  MAX_PER_USER_SANDBOXES,
  OUTPUT_LIMIT_BYTES,
  SANDBOX_IMAGE,
  type SandboxLanguage,
  type SandboxLimits,
  type SandboxStatus,
} from './config.js';
import type { SandboxExecReq, SandboxExecResult, SandboxSession } from './types.js';
import { buildDockerRunArgs, validateSecurityArgs } from './security.js';
import { BrowserController } from './browser.js';

const SANDBOX_PREFIX = 'sb-';

function newId(): string {
  return `${SANDBOX_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
}

function newExecId(): string {
  return `exe-${crypto.randomBytes(6).toString('hex')}`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function truncate(data: string, limit: number): { text: string; truncated: boolean } {
  if (data.length <= limit) return { text: data, truncated: false };
  return { text: data.slice(0, limit), truncated: true };
}

/** State that lives in memory (DB is source of truth for persistence). */
interface InMemoryState {
  session: SandboxSession;
  execLock: Promise<unknown> | null;
  idleTimer: NodeJS.Timeout | null;
  hardTimer: NodeJS.Timeout | null;
  browser: BrowserController | null;
  terminalProcess: import('child_process').ChildProcess | null;
  onTerminalData?: (data: string) => void;
  onTerminalExit?: (code: number) => void;
  onStatusChange?: (status: SandboxStatus) => void;
  onBrowserFrame?: (dataUrl: string) => void;
}

export class SandboxManager {
  private state = new Map<string, InMemoryState>();
  private userIndex = new Map<string, Set<string>>();

  private db() {
    return getDb();
  }

  async create(
    userId: string,
    opts: {
      language?: SandboxLanguage;
      browserEnabled?: boolean;
      ttlMinutes?: number;
    } = {},
  ): Promise<SandboxSession> {
    // Concurrency guards
    if (this.state.size >= MAX_CONCURRENT_SANDBOXES) {
      throw new Error(
        `达到最大并发沙箱数上限 (${MAX_CONCURRENT_SANDBOXES})，请先关闭其他沙箱`,
      );
    }
    const userSessions = this.userIndex.get(userId) ?? new Set();
    if (userSessions.size >= MAX_PER_USER_SANDBOXES) {
      throw new Error(
        `用户沙箱数已达上限 (${MAX_PER_USER_SANDBOXES})`,
      );
    }

    const id = newId();
    const containerName = `deepthink-sandbox-${id}`;
    const language = opts.language ?? 'python';
    const browserEnabled = opts.browserEnabled ?? false;

    // Build args & validate security invariants
    const args = buildDockerRunArgs(
      containerName,
      DEFAULT_LIMITS,
      browserEnabled,
      SANDBOX_IMAGE,
    );
    const missing = validateSecurityArgs(args);
    if (missing.length > 0) {
      logger.error({ missing }, 'Sandbox security args validation failed');
      throw new Error(`沙箱安全参数缺失: ${missing.join(', ')}`);
    }

    // Spawn docker run -d
    const runResult = await this.spawnDocker(args);
    if (!runResult.ok) {
      throw new Error(`沙箱启动失败: ${runResult.stderr || runResult.stdout}`);
    }

    // For browser mode, query the mapped host port
    let cdpPort: number | null = null;
    if (browserEnabled) {
      cdpPort = await this.queryHostPort(containerName, CDP_IN_CONTAINER_PORT);
      if (cdpPort == null) {
        logger.warn(
          { containerName },
          'Failed to query CDP host port — browser features will fail',
        );
      }
    }

    // Wait for container to be ready (echo ready)
    await this.waitForReady(containerName);

    const now = Date.now();
    const session: SandboxSession = {
      id,
      userId,
      containerName,
      language,
      browserEnabled,
      status: 'running',
      createdAt: now,
      lastActiveAt: now,
      stoppedAt: null,
      stoppedReason: null,
      cdpPort,
    };

    // Persist to DB
    this.db()
      .prepare(
        `INSERT INTO sandbox_sessions
          (id, user_id, container_name, language, browser_enabled, status, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        containerName,
        language,
        browserEnabled ? 1 : 0,
        'running',
        now,
        now,
      );

    // Set up timers
    const state: InMemoryState = {
      session,
      execLock: null,
      idleTimer: setTimeout(() => this.destroy(id, 'idle_timeout'), IDLE_TIMEOUT_MS),
      hardTimer: setTimeout(() => this.destroy(id, 'hard_timeout'), HARD_TIMEOUT_MS),
      browser: null,
      terminalProcess: null,
    };
    this.state.set(id, state);
    if (!this.userIndex.has(userId)) this.userIndex.set(userId, new Set());
    this.userIndex.get(userId)!.add(id);

    logger.info({ sessionId: id, containerName, browserEnabled, cdpPort }, 'Sandbox created');
    return session;
  }

  async executeCode(
    sessionId: string,
    userId: string,
    req: SandboxExecReq,
  ): Promise<SandboxExecResult> {
    const state = this.state.get(sessionId);
    if (!state) throw new Error('沙箱不存在或已销毁');
    if (state.session.userId !== userId) throw new Error('无权访问该沙箱');
    if (state.session.status === 'stopped') throw new Error('沙箱已停止');

    // Serialize exec per session
    const prev = state.execLock ?? Promise.resolve();
    const next = prev.then(() => this._doExecute(state, req));
    state.execLock = next.catch(() => {});
    return next as Promise<SandboxExecResult>;
  }

  private async _doExecute(
    state: InMemoryState,
    req: SandboxExecReq,
  ): Promise<SandboxExecResult> {
    const { session } = state;
    const execId = newExecId();
    const startedAt = Date.now();
    const timeoutMs = Math.min(
      Math.max(req.timeoutMs ?? 30_000, 1000),
      5 * 60 * 1000,
    );

    // Build the docker exec command. We write code via stdin to avoid shell-escaping issues.
    // The container's entry.sh is in session mode (tail -f), so we use `docker exec -i ... sh -c '<runner> /tmp/code'`
    // after piping code into a file via stdin (here-doc).
    const runner = req.language === 'python'
      ? 'python3 -u'
      : req.language === 'node'
        ? 'node'
        : 'sh';

    // We pipe: <code> → cat > /tmp/code.<ext> && timeout <s> <runner> /tmp/code.<ext>
    const ext = req.language === 'python' ? 'py' : req.language === 'node' ? 'js' : 'sh';
    const inner = `cat > /tmp/code.${ext} && timeout --preserve-status --signal=TERM ${Math.floor(timeoutMs / 1000)}s ${runner} /tmp/code.${ext}; echo __EXIT__:$?`;

    const args = ['exec', '-i', session.containerName, 'sh', '-c', inner];

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolve) => {
      const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, timeoutMs + 5000);

      proc.stdout.on('data', (b) => { stdout += b.toString(); });
      proc.stderr.on('data', (b) => { stderr += b.toString(); });
      proc.on('error', (err) => {
        clearTimeout(timer);
        stderr += `\n[spawn error] ${err.message}\n`;
        resolve({ stdout, stderr, exitCode: null });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      });
      try {
        proc.stdin.write(req.code);
        if (req.stdin) proc.stdin.write(req.stdin);
        proc.stdin.end();
      } catch { /* ignore */ }
    });

    const durationMs = Date.now() - startedAt;

    // Parse exit code from __EXIT__:<n> trailer (set -e isn't used; timeout preserves status)
    let exitCode = result.exitCode;
    const trailerMatch = result.stdout.match(/__EXIT__:(-?\d+)\s*$/);
    if (trailerMatch) {
      exitCode = parseInt(trailerMatch[1], 10);
      result.stdout = result.stdout.replace(/__EXIT__:-?\d+\s*$/, '');
    }

    const outT = truncate(result.stdout, OUTPUT_LIMIT_BYTES);
    const errT = truncate(result.stderr, OUTPUT_LIMIT_BYTES);
    const truncated = outT.truncated || errT.truncated;

    // Status classification
    let status: SandboxExecResult['status'];
    if (exitCode === 0) status = 'completed';
    else if (exitCode === 124 || exitCode === 137) status = 'timeout'; // timeout(1) returns 124 on TERM, 137 on KILL
    else if (exitCode === 137 || exitCode === 139) status = 'oom'; // SIGKILL/SIGSEGV often from OOM
    else status = 'error';

    // Touch idle timer
    this.touch(state);

    // Persist execution row
    this.db()
      .prepare(
        `INSERT INTO sandbox_executions
          (id, session_id, user_id, language, code_hash, status, exit_code,
           stdout_bytes, stderr_bytes, truncated, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execId,
        session.id,
        session.userId,
        req.language,
        sha256(req.code),
        status,
        exitCode,
        Buffer.byteLength(outT.text),
        Buffer.byteLength(errT.text),
        truncated ? 1 : 0,
        durationMs,
        Date.now(),
      );

    // Update last_active_at
    this.db()
      .prepare('UPDATE sandbox_sessions SET last_active_at = ? WHERE id = ?')
      .run(Date.now(), session.id);

    return {
      executionId: execId,
      sessionId: session.id,
      status,
      exitCode,
      stdout: outT.text,
      stderr: errT.text,
      truncated,
      durationMs,
    };
  }

  async listForUser(userId: string): Promise<SandboxSession[]> {
    const rows = this.db()
      .prepare(
        `SELECT * FROM sandbox_sessions WHERE user_id = ? AND status IN ('created', 'running', 'idle') ORDER BY created_at DESC`,
      )
      .all(userId) as Array<any>;
    return rows.map(rowToSession);
  }

  get(sessionId: string): SandboxSession | null {
    const state = this.state.get(sessionId);
    if (state) return state.session;
    const row = this.db()
      .prepare('SELECT * FROM sandbox_sessions WHERE id = ?')
      .get(sessionId) as any;
    return row ? rowToSession(row) : null;
  }

  getState(sessionId: string): InMemoryState | undefined {
    return this.state.get(sessionId);
  }

  async startBrowser(
    sessionId: string,
    onFrame: (dataUrl: string) => void,
  ): Promise<void> {
    const state = this.state.get(sessionId);
    if (!state) throw new Error('沙箱不存在');
    if (!state.session.browserEnabled || !state.session.cdpPort) {
      throw new Error('沙箱未启用浏览器能力（创建时需 browserEnabled=true）');
    }
    if (state.browser) return; // already started
    state.browser = new BrowserController(
      state.session.cdpPort,
      state.session.containerName,
    );
    await state.browser.start(onFrame, BROWSER_FRAME_INTERVAL_MS);
  }

  async stopBrowser(sessionId: string): Promise<void> {
    const state = this.state.get(sessionId);
    if (!state?.browser) return;
    await state.browser.stop();
    state.browser = null;
  }

  async getBrowser(sessionId: string): Promise<BrowserController | null> {
    const state = this.state.get(sessionId);
    return state?.browser ?? null;
  }

  async destroy(sessionId: string, reason: string): Promise<void> {
    const state = this.state.get(sessionId);
    if (!state) {
      // Already destroyed or never existed in memory; sync DB if present
      this.db()
        .prepare(
          `UPDATE sandbox_sessions SET status='stopped', stopped_at=?, stopped_reason=? WHERE id=? AND status!='stopped'`,
        )
        .run(Date.now(), reason, sessionId);
      return;
    }
    const { session } = state;

    // Stop browser
    if (state.browser) {
      try { await state.browser.stop(); } catch { /* ignore */ }
      state.browser = null;
    }
    // Kill terminal process
    if (state.terminalProcess) {
      try { state.terminalProcess.kill('SIGKILL'); } catch { /* ignore */ }
      state.terminalProcess = null;
    }
    // Timers
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.hardTimer) clearTimeout(state.hardTimer);

    // docker rm -f
    try {
      await new Promise<void>((resolve) => {
        const p = spawn('docker', ['rm', '-f', session.containerName], { stdio: 'ignore' });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      });
    } catch { /* ignore */ }

    // DB update
    this.db()
      .prepare(
        `UPDATE sandbox_sessions SET status='stopped', stopped_at=?, stopped_reason=? WHERE id=?`,
      )
      .run(Date.now(), reason, session.id);

    this.state.delete(sessionId);
    const userSet = this.userIndex.get(session.userId);
    if (userSet) {
      userSet.delete(sessionId);
      if (userSet.size === 0) this.userIndex.delete(session.userId);
    }

    state.onStatusChange?.('stopped');
    logger.info({ sessionId, reason }, 'Sandbox destroyed');
  }

  /** Touch idle timer (called on exec or terminal I/O). */
  touch(state: InMemoryState) {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(
      () => this.destroy(state.session.id, 'idle_timeout'),
      IDLE_TIMEOUT_MS,
    );
    state.session.lastActiveAt = Date.now();
  }

  /** Start a streaming terminal session. */
  startTerminal(
    sessionId: string,
    onData: (data: string) => void,
    onExit: (code: number) => void,
  ): import('child_process').ChildProcess {
    const state = this.state.get(sessionId);
    if (!state) throw new Error('沙箱不存在');
    if (state.terminalProcess) {
      try { state.terminalProcess.kill('SIGKILL'); } catch { /* ignore */ }
    }
    const proc = spawn(
      'docker',
      ['exec', '-i', state.session.containerName, 'sh'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    proc.stdout.on('data', (b) => {
      this.touch(state);
      onData(b.toString());
    });
    proc.stderr.on('data', (b) => {
      this.touch(state);
      onData(b.toString());
    });
    proc.on('exit', (code) => onExit(code ?? 0));
    state.terminalProcess = proc;
    state.onTerminalData = onData;
    state.onTerminalExit = onExit;
    return proc;
  }

  sendTerminalInput(sessionId: string, data: string): void {
    const state = this.state.get(sessionId);
    if (!state?.terminalProcess?.stdin) return;
    try { state.terminalProcess.stdin.write(data); } catch { /* ignore */ }
    this.touch(state);
  }

  stopTerminal(sessionId: string): void {
    const state = this.state.get(sessionId);
    if (!state?.terminalProcess) return;
    try { state.terminalProcess.kill('SIGKILL'); } catch { /* ignore */ }
    state.terminalProcess = null;
  }

  onStatusChange(sessionId: string, cb: (status: SandboxStatus) => void): void {
    const state = this.state.get(sessionId);
    if (state) state.onStatusChange = cb;
  }

  private async spawnDocker(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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

  private async waitForReady(containerName: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await this.spawnDocker(['exec', containerName, 'echo', 'ready']);
      if (r.ok && r.stdout.trim() === 'ready') return;
      await new Promise((r) => setTimeout(r, 200));
    }
    logger.warn({ containerName }, 'Sandbox readiness probe timed out (continuing)');
  }

  private async queryHostPort(containerName: string, inContainerPort: number): Promise<number | null> {
    const r = await this.spawnDocker([
      'port', containerName, `${inContainerPort}/tcp`,
    ]);
    const out = r.stdout.trim();
    if (!out) return null;
    // Format: 0.0.0.0:32891\n:::32892  OR  127.0.0.1:32891
    const lines = out.split('\n').filter(Boolean);
    for (const line of lines) {
      const m = line.match(/:(\d+)$/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }
}

function rowToSession(row: any): SandboxSession {
  return {
    id: row.id,
    userId: row.user_id,
    containerName: row.container_name,
    language: row.language,
    browserEnabled: !!row.browser_enabled,
    status: row.status,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    stoppedAt: row.stopped_at,
    stoppedReason: row.stopped_reason,
    cdpPort: null,
  };
}

/** Singleton instance. */
let singleton: SandboxManager | null = null;
export function getSandboxManager(): SandboxManager {
  if (!singleton) singleton = new SandboxManager();
  return singleton;
}
