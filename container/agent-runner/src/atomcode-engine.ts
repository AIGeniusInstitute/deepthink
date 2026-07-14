/**
 * AtomCode Engine Adapter
 *
 * Drives atomcode's HTTP/SSE /chat endpoint (invoked as `atomcode daemon --port`)
 * as an alternative to the Claude Agent SDK query() path. Invoked by index.ts
 * main() when ContainerInput.engine === 'atomcode'.
 *
 * Lifecycle:
 *   1. Spawn atomcode daemon on a random loopback port (ATOMCODE_HOME
 *      inherited from env, set by container-runner).
 *   2. Poll /health until ready (30s timeout).
 *   3. POST /chat with initial prompt + session_id (if any).
 *   4. Parse SSE stream, translate to DeepThink StreamEvents, emit via
 *      writeOutput({ status: 'stream', streamEvent }).
 *   5. On 'done' SSE event: emit final writeOutput({ status:'success',
 *      result, newSessionId }).
 *   6. Enter IPC polling loop — on new message: POST /chat again with the
 *      same session_id.
 *   7. On _close sentinel: stop daemon, exit process.
 *
 * Known limitations (documented in PRD §3.1):
 *   - No DeepThink MCP tool bridge (send_message/schedule_task/memory_*).
 *   - No image input (atomcode /chat is text-only).
 *   - No sub-agents / skills / plugins bridging.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

import type { ContainerInput, ContainerOutput, StreamEvent } from './types.js';

// Reuse the stdout protocol markers from index.ts. Duplicate definitions keep
// this module self-contained — index.ts's main() decides which engine runs,
// but both engines must speak the same stdout protocol.
const OUTPUT_START_MARKER = '---DEEPTHINK_OUTPUT_START---';
const OUTPUT_END_MARKER = '---DEEPTHINK_OUTPUT_END---';

const IPC_INPUT_DIR = process.env.DEEPTHINK_WORKSPACE_IPC
  ? path.join(process.env.DEEPTHINK_WORKSPACE_IPC, 'input')
  : '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_FALLBACK_POLL_MS = 5000;

const WORKSPACE_GROUP = process.env.DEEPTHINK_WORKSPACE_GROUP || '/workspace/group';

interface IpcDrainMessage {
  text: string;
  images?: Array<{ data: string; mimeType?: string }>;
  taskId?: string;
  sourceJid?: string;
}

interface IpcDrainResult {
  messages: IpcDrainMessage[];
}

interface AtomcodeSseEvent {
  type: string;
  // text/reasoning
  text?: string;
  content?: string;
  // tool_start
  name?: string;
  arguments?: unknown;
  // tool_result
  output?: string;
  success?: boolean;
  duration_ms?: number;
  // tokens
  prompt?: number;
  completion?: number;
  total?: number;
  // artifact
  artifact_type?: string;
  // done
  session_id?: string;
  tool_calls?: number;
  // error
  message?: string;
}

interface RunOpts {
  containerInput: ContainerInput;
  writeOutput: (out: ContainerOutput) => void;
  log: (message: string) => void;
}

function emitStream(
  writeOutput: (out: ContainerOutput) => void,
  streamEvent: StreamEvent,
  sessionId: string | undefined,
  turnId: string | undefined,
): void {
  writeOutput({
    status: 'stream',
    result: null,
    streamEvent,
    sessionId,
    turnId,
  });
}

/** Pick a free TCP port in [basePort, basePort+portRange). */
async function pickFreePort(basePort: number, portRange: number, log: (m: string) => void): Promise<number> {
  const tried = new Set<number>();
  for (let attempt = 0; attempt < portRange; attempt++) {
    const offset = Math.floor(Math.random() * portRange);
    if (tried.has(offset)) continue;
    tried.add(offset);
    const port = basePort + offset;
    const free = await isPortFree(port);
    if (free) return port;
  }
  log(`pickFreePort: no free port in [${basePort}, ${basePort + portRange})`);
  return 0;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      try { server.close(); } catch { /* ignore */ }
      resolve(false);
    });
    server.once('listening', () => {
      try { server.close(); } catch { /* ignore */ }
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/** Start atomcode daemon on a random loopback port, wait for /health. */
async function startDaemon(opts: {
  binaryPath: string;
  basePort: number;
  portRange: number;
  host: string;
  log: (m: string) => void;
  logFile?: string;
}): Promise<{ baseUrl: string; process: ChildProcess; port: number }> {
  const { binaryPath, basePort, portRange, host, log, logFile } = opts;
  if (!binaryPath) {
    throw new Error('ATOMCODE_BINARY_PATH is empty');
  }
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`atomcode binary not found at ${binaryPath}`);
  }
  const port = await pickFreePort(basePort, portRange, log);
  if (!port) {
    throw new Error(`No free port available in [${basePort}, ${basePort + portRange})`);
  }

  // atomcode CLI: `atomcode daemon --port <port>` (always binds to 127.0.0.1)
  const args = ['daemon', '--port', String(port)];
  log(`Spawning atomcode daemon: ${binaryPath} ${args.join(' ')}`);

  let stderrStream: fs.WriteStream | undefined;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      stderrStream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch { /* ignore */ }
  }

  const proc = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (stderrStream) {
    proc.stderr?.pipe(stderrStream);
  } else {
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trimEnd();
      if (line) log(`[daemon stderr] ${line}`);
    });
  }
  proc.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trimEnd();
    if (line) log(`[daemon stdout] ${line}`);
  });
  proc.on('exit', (code, sig) => {
    log(`atomcode daemon exited (code=${code}, sig=${sig})`);
  });
  proc.on('error', (err) => {
    log(`atomcode daemon error: ${err.message}`);
  });

  const baseUrl = `http://${(host || '127.0.0.1') === '0.0.0.0' ? '127.0.0.1' : host || '127.0.0.1'}:${port}`;
  // Poll /health
  const deadline = Date.now() + 30_000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = (await res.json()) as { status?: string; version?: string };
        if (body.status === 'ok') {
          log(`atomcode daemon ready at ${baseUrl} (version=${body.version ?? 'unknown'})`);
          return { baseUrl, process: proc, port };
        }
        lastErr = `status=${body.status}`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  throw new Error(`atomcode daemon failed to become healthy at ${baseUrl}: ${lastErr}`);
}

/** Stop daemon gracefully: SIGTERM -> 10s -> SIGKILL. */
async function stopDaemon(proc: ChildProcess, log: (m: string) => void): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  return new Promise<void>((resolve) => {
    const onExit = () => {
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', onExit);
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 10_000);
  });
}

/**
 * Drain pending IPC input files. Mirrors the logic in index.ts so the
 * AtomCode engine sees the same follow-up messages that the Claude path
 * would have absorbed into its initial prompt.
 */
function drainIpcInput(): IpcDrainResult {
  const result: IpcDrainResult = { messages: [] };
  try {
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          result.messages.push({
            text: data.text,
            images: data.images,
            taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
            sourceJid: typeof data.sourceJid === 'string' ? data.sourceJid : undefined,
          });
        }
      } catch {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  } catch {
    // IPC dir may not exist yet
  }
  return result;
}

/**
 * Parse an SSE response stream into discrete events.
 * AtomCode daemon emits `data: <json>\n\n` blocks.
 */
async function* parseSseStream(
  response: Response,
): AsyncGenerator<AtomcodeSseEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        try {
          yield JSON.parse(jsonStr) as AtomcodeSseEvent;
        } catch {
          // skip malformed event
        }
      }
    }
  }
  // flush any trailing event
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) continue;
      try {
        yield JSON.parse(jsonStr) as AtomcodeSseEvent;
      } catch {
        // skip
      }
    }
  }
}

/**
 * Send a chat message to atomcode-daemon and stream the response.
 * Returns the final session_id (from the 'done' event) and the accumulated
 * full text.
 */
async function sendChat(
  opts: {
    baseUrl: string;
    message: string;
    sessionId?: string;
    workingDir?: string;
    provider?: string;
    writeOutput: (out: ContainerOutput) => void;
    turnId?: string;
    currentSessionId: string | undefined;
    log: (m: string) => void;
    signal?: AbortSignal;
  },
): Promise<{ sessionId?: string; fullText: string; toolCalls: number; interrupted: boolean; error?: string }> {
  const { baseUrl, message, sessionId, workingDir, provider, writeOutput, turnId, currentSessionId, log, signal } = opts;
  const body: Record<string, string> = { message };
  if (sessionId) body.session_id = sessionId;
  if (workingDir) body.working_dir = workingDir;
  if (provider) body.provider = provider;

  let fullText = '';
  let newSessionId: string | undefined;
  let toolCalls = 0;
  let interrupted = false;
  let errorMessage: string | undefined;

  try {
    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        fullText: '',
        toolCalls: 0,
        interrupted: false,
        error: `atomcode-daemon /chat returned HTTP ${response.status}: ${text.slice(0, 500)}`,
      };
    }

    for await (const ev of parseSseStream(response)) {
      switch (ev.type) {
        case 'text': {
          const delta = ev.text ?? ev.content ?? '';
          fullText += delta;
          emitStream(writeOutput, {
            eventType: 'text_delta',
            agentScope: 'main',
            text: delta,
          }, currentSessionId, turnId);
          break;
        }
        case 'reasoning': {
          const delta = ev.text ?? ev.content ?? '';
          emitStream(writeOutput, {
            eventType: 'thinking_delta',
            agentScope: 'main',
            text: delta,
          }, currentSessionId, turnId);
          break;
        }
        case 'tool_start': {
          toolCalls += 1;
          emitStream(writeOutput, {
            eventType: 'tool_use_start',
            agentScope: 'main',
            toolName: ev.name ?? 'unknown',
            toolInputSummary: typeof ev.arguments === 'string' ? ev.arguments : JSON.stringify(ev.arguments ?? {}).slice(0, 200),
          }, currentSessionId, turnId);
          break;
        }
        case 'tool_output': {
          emitStream(writeOutput, {
            eventType: 'tool_progress',
            agentScope: 'main',
            toolName: ev.name,
            detail: ev.output ?? '',
          }, currentSessionId, turnId);
          break;
        }
        case 'tool_result': {
          emitStream(writeOutput, {
            eventType: 'tool_use_end',
            agentScope: 'main',
            toolName: ev.name,
            toolResult: (ev.output ?? '').slice(0, 1000),
            elapsedSeconds: ev.duration_ms ? ev.duration_ms / 1000 : undefined,
          }, currentSessionId, turnId);
          break;
        }
        case 'tokens': {
          emitStream(writeOutput, {
            eventType: 'status',
            agentScope: 'main',
            statusText: `Tokens: prompt=${ev.prompt ?? 0}, completion=${ev.completion ?? 0}, total=${ev.total ?? 0}`,
          }, currentSessionId, turnId);
          break;
        }
        case 'artifact_start':
        case 'artifact_content':
        case 'artifact_end': {
          // AtomCode artifacts (code/HTML/SVG blocks). Surface as text so the
          // card renders inline; we don't have a dedicated StreamEvent for
          // artifacts in this first cut.
          if (ev.type === 'artifact_content' && ev.output) {
            fullText += ev.output;
            emitStream(writeOutput, {
              eventType: 'text_delta',
              agentScope: 'main',
              text: ev.output,
            }, currentSessionId, turnId);
          }
          break;
        }
        case 'done': {
          newSessionId = ev.session_id;
          break;
        }
        case 'stopped': {
          interrupted = true;
          break;
        }
        case 'error': {
          errorMessage = ev.message ?? 'unknown error';
          break;
        }
        default:
          // Ignore unknown event types (forward-compat)
          break;
      }
      if (errorMessage) break;
    }
  } catch (err) {
    if (signal?.aborted) {
      interrupted = true;
    } else {
      errorMessage = err instanceof Error ? err.message : String(err);
      log(`sendChat error: ${errorMessage}`);
    }
  }

  return {
    sessionId: newSessionId,
    fullText,
    toolCalls,
    interrupted,
    error: errorMessage,
  };
}

/**
 * Main entry point for the AtomCode engine. Called from index.ts main() when
 * ContainerInput.engine === 'atomcode'.
 */
export async function runAtomcodeEngine(opts: RunOpts): Promise<void> {
  const { containerInput, writeOutput, log } = opts;
  const turnId = containerInput.turnId;

  // ── 1. Read engine env vars (injected by container-runner) ──
  const binaryPath = process.env.ATOMCODE_BINARY_PATH?.trim() ?? '';
  const basePort = parseInt(process.env.ATOMCODE_BASE_PORT ?? '14000', 10);
  const portRange = parseInt(process.env.ATOMCODE_PORT_RANGE ?? '100', 10);
  const host = process.env.ATOMCODE_HOST?.trim() || '127.0.0.1';

  if (!binaryPath) {
    writeOutput({
      status: 'error',
      result: null,
      error:
        'ATOMCODE_BINARY_PATH 未注入。请在 设置 → AtomCode 引擎 中配置二进制路径，并确保群组 engine=atomcode。',
      turnId,
    });
    return;
  }

  // ── 2. Prepare initial prompt (drain IPC, scheduled task prefix) ──
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt =
      '[定时任务 - 以下内容由系统自动发送。]\n\n' +
      '注意：AtomCode 引擎不内置 DeepThink MCP 工具，无法调用 send_message。' +
      '本次运行的最终输出会作为结果保存到对话历史，但不会主动推送消息。\n\n' +
      prompt;
  }
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  const pending = drainIpcInput();
  if (pending.messages.length > 0) {
    log(`Draining ${pending.messages.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.messages.map((m) => m.text).join('\n');
  }

  // ── 3. Spawn daemon ──
  const logFile = path.join(
    process.env.DEEPTHINK_WORKSPACE_GROUP || WORKSPACE_GROUP,
    'logs',
    'atomcode-daemon.log',
  );
  let daemonInst: { baseUrl: string; process: ChildProcess; port: number };
  try {
    daemonInst = await startDaemon({
      binaryPath,
      basePort,
      portRange,
      host,
      log,
      logFile,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeOutput({
      status: 'error',
      result: null,
      error: `AtomCode daemon 启动失败：${msg}`,
      turnId,
    });
    return;
  }

  // ── 4. Emit init event ──
  emitStream(writeOutput, {
    eventType: 'init',
    agentScope: 'main',
    statusText: `AtomCode 引擎已启动 (port=${daemonInst.port})`,
  }, containerInput.sessionId, turnId);

  // ── 5. First chat turn ──
  let sessionId = containerInput.sessionId;
  let abortController: AbortController | null = null;

  const runOneTurn = async (message: string): Promise<void> => {
    abortController = new AbortController();
    const result = await sendChat({
      baseUrl: daemonInst.baseUrl,
      message,
      sessionId,
      workingDir: WORKSPACE_GROUP,
      writeOutput,
      turnId,
      currentSessionId: sessionId,
      log,
      signal: abortController.signal,
    });
    abortController = null;

    if (result.error) {
      writeOutput({
        status: 'error',
        result: result.fullText || null,
        error: `AtomCode /chat 错误：${result.error}`,
        newSessionId: result.sessionId ?? sessionId,
        sessionId,
        turnId,
      });
      return;
    }

    if (result.sessionId) sessionId = result.sessionId;

    writeOutput({
      status: 'success',
      result: result.fullText || '(AtomCode 返回空回复)',
      newSessionId: sessionId,
      sessionId,
      turnId,
      finalizationReason: result.interrupted ? 'interrupted' : 'completed',
    });
  };

  await runOneTurn(prompt);

  // ── 6. IPC polling loop — handle follow-up messages ──
  let closed = false;
  let watcher: fs.FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;

  const checkForNewMessages = async (): Promise<void> => {
    if (closed) return;
    try {
      if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
        log('IPC _close sentinel detected, shutting down');
        closed = true;
        cleanup();
        return;
      }
    } catch { /* ignore */ }

    const drain = drainIpcInput();
    if (drain.messages.length === 0) return;
    for (const msg of drain.messages) {
      if (closed) break;
      log(`IPC follow-up message: ${msg.text.slice(0, 80)}`);
      await runOneTurn(msg.text);
    }
  };

  const cleanup = async (): Promise<void> => {
    closed = true;
    if (watcher) {
      try { watcher.close(); } catch { /* ignore */ }
      watcher = null;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    if (abortController) {
      try { abortController.abort(); } catch { /* ignore */ }
    }
    await stopDaemon(daemonInst.process, log);
    writeOutput({ status: 'closed', result: null, turnId });
  };

  try { fs.mkdirSync(IPC_INPUT_DIR, { recursive: true }); } catch { /* ignore */ }
  try {
    watcher = fs.watch(IPC_INPUT_DIR, () => {
      void checkForNewMessages();
    });
    watcher.on('error', (err) => {
      log(`IPC watcher error: ${err.message}`);
    });
  } catch (err) {
    log(`Failed to create IPC watcher: ${err instanceof Error ? err.message : String(err)}`);
  }
  fallbackTimer = setInterval(() => {
    void checkForNewMessages();
  }, IPC_FALLBACK_POLL_MS);
  fallbackTimer.unref();

  // SIGINT/SIGTERM handler — stop daemon cleanly
  const sigHandler = async (sig: string): Promise<void> => {
    log(`Received ${sig}, stopping atomcode-engine`);
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => void sigHandler('SIGINT'));
  process.on('SIGTERM', () => void sigHandler('SIGTERM'));
}

export { OUTPUT_START_MARKER, OUTPUT_END_MARKER };
