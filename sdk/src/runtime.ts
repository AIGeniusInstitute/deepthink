/**
 * SDK 核心运行时 —— Agent / Session（F3 会话 + resume、F4 流式、F8 身份中性）。
 *
 * 会话模型：每回合一次 SDK query()，跨回合 / 跨进程用 `resume: sessionId`
 * 续接（sessionId 持久化在 workspace 内）——覆盖 A3.2 多轮、A3.4 跨进程
 * resume，且消息排队不丢（A3.3）。
 *
 * 身份：systemPrompt = claude_code 预设 + bundle 的 prompts/system.md 原文
 * （NeutralPromptPack：不注入任何平台身份，A8.1）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from './stream-event.types.js';
import { loadBundle, type LoadedBundle, type LoadBundleOptions } from './bundle.js';

export interface AgentCredentials {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface AgentOptions {
  credentials?: AgentCredentials;
  /** 工作区目录（会话持久化 / agent 产物落盘） */
  workspace: string;
  onEvent?: (event: StreamEvent) => void;
  /** 密钥表（envName → value），优先于 process.env */
  secrets?: Record<string, string>;
  /** 会话超时（毫秒），默认 30 分钟 */
  timeoutMs?: number;
  /** 附加 MCP servers（叠加在 bundle 声明之上） */
  extraMcpServers?: Record<string, Record<string, unknown>>;
  /** 自包含工具 MCP server（F7：web_fetch / disk_* / memory_* 等） */
  toolsServer?: Record<string, unknown>;
}

export interface RunResult {
  text: string;
  sessionId: string | null;
  usage?: Record<string, number>;
  error?: string;
}

export interface StartOptions {
  prompt: string;
  images?: Array<{ data: string; mimeType: string }>;
  /** 覆盖 bundle 的 model / maxTurns / temperature */
  model?: string;
  maxTurns?: number;
  temperature?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function sessionStatePath(workspace: string): string {
  return path.join(workspace, '.deepthink-sdk', 'session.json');
}

function readSessionId(workspace: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionStatePath(workspace), 'utf-8'));
    return typeof raw.sessionId === 'string' ? raw.sessionId : null;
  } catch {
    return null;
  }
}

function writeSessionId(workspace: string, sessionId: string): void {
  const file = sessionStatePath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }), 'utf-8');
}

function safeSummary(input: unknown): string | undefined {
  try {
    const s = JSON.stringify(input ?? {});
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return undefined;
  }
}

/** 把 SDK 消息流翻译为 StreamEvent（F4，覆盖 TC-4.1 所需事件集）。 */
function emitFromSdkMessage(
  msg: Record<string, unknown>,
  onEvent: ((e: StreamEvent) => void) | undefined,
  sessionId: string | null,
): void {
  if (!onEvent) return;
  const emit = (e: StreamEvent) => onEvent({ sessionId: sessionId ?? undefined, ...e });

  const type = msg.type as string;
  if (type === 'system') {
    emit({ eventType: 'init', agentScope: 'system', rawType: String(msg.subtype ?? 'system') });
    return;
  }
  if (type === 'stream_event') {
    const ev = msg.event as Record<string, unknown> | undefined;
    if (!ev) return;
    const evType = ev.type as string;
    if (evType === 'content_block_delta') {
      const delta = ev.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        emit({ eventType: 'text_delta', agentScope: 'main', text: delta.text });
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        emit({ eventType: 'thinking_delta', agentScope: 'main', text: delta.thinking });
      }
    } else if (evType === 'content_block_start') {
      const block = ev.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use') {
        emit({
          eventType: 'tool_use_start',
          agentScope: 'main',
          toolName: String(block.name ?? 'tool'),
          toolUseId: String(block.id ?? ''),
          toolInputSummary: safeSummary(block.input),
        });
      }
    }
    return;
  }
  if (type === 'assistant') {
    const message = msg.message as { content?: unknown[] } | undefined;
    for (const block of message?.content ?? []) {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use') {
        emit({
          eventType: 'tool_use_end',
          agentScope: 'main',
          toolName: String(b.name ?? 'tool'),
          toolUseId: String(b.id ?? ''),
          toolInputSummary: safeSummary(b.input),
        });
      }
    }
    return;
  }
  if (type === 'result') {
    const usage = msg.usage as Record<string, number> | undefined;
    emit({
      eventType: 'status',
      agentScope: 'system',
      summary: String(msg.subtype ?? 'result'),
      usage,
    } as StreamEvent);
  }
}

export class Session {
  readonly workspace: string;
  private readonly agent: Agent;
  private sessionId: string | null;
  private queue: Array<{ opts: StartOptions; resolve: (r: RunResult) => void }> = [];
  private running = false;
  private abort: AbortController | null = null;
  private closed = false;
  /** 最近一次（或进行中）回合的 Promise，wait() 挂在它上面 */
  private lastTurn: Promise<RunResult> = Promise.resolve({ text: '', sessionId: null });

  constructor(agent: Agent, workspace: string, resumeSessionId: string | null) {
    this.agent = agent;
    this.workspace = workspace;
    this.sessionId = resumeSessionId;
  }

  get id(): string | null {
    return this.sessionId;
  }

  /**
   * 发送回合（排队：当前回合结束后自动续跑；A3.3 中断后 send 可继续）。
   * 返回本回合结果。
   */
  send(opts: StartOptions | string): Promise<RunResult> {
    const normalized: StartOptions = typeof opts === 'string' ? { prompt: opts } : opts;
    const turn = new Promise<RunResult>((resolve) => {
      this.queue.push({ opts: normalized, resolve });
    });
    this.lastTurn = turn;
    void this.drain();
    return turn;
  }

  /** 等待最近回合（或 start 发起的首回合）完成。 */
  wait(): Promise<RunResult> {
    return this.lastTurn;
  }

  /** 中断当前回合（A3.3）；排队消息不丢，drain 继续处理。 */
  interrupt(): void {
    this.abort?.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort();
    for (const item of this.queue.splice(0)) {
      item.resolve({ text: '', sessionId: this.sessionId, error: 'session closed' });
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const item = this.queue.shift()!;
        try {
          item.resolve(await this.runTurn(item.opts));
        } catch (err) {
          item.resolve({
            text: '',
            sessionId: this.sessionId,
            error: (err as Error).message || String(err),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runTurn(opts: StartOptions): Promise<RunResult> {
    const abort = new AbortController();
    this.abort = abort;
    const timer = setTimeout(() => abort.abort(), this.agent.timeoutMs);
    timer.unref?.();

    const onEvent = this.agent.onEvent;
    let text = '';
    let sessionId = this.sessionId;
    let usage: Record<string, number> | undefined;
    let resultError: string | undefined;

    try {
      const def = this.agent.bundle.agent;
      const options: Record<string, unknown> = {
        cwd: this.workspace,
        // F8 身份中性：仅 claude_code 预设 + bundle prompt 原文
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: this.agent.bundle.systemPrompt || undefined,
        },
        env: this.agent.buildEnv(),
        includePartialMessages: true,
        abortController: abort,
        settingSources: ['project'] as string[],
        ...(this.sessionId ? { resume: this.sessionId } : {}),
      };
      // F5：bundle 内联 skill 白名单（空 bundle 不带 skills 选项，走 SDK 默认）
      const skillNames = this.agent.skillNames;
      if (skillNames.length > 0) {
        options.skills = skillNames;
      }
      const model = opts.model ?? def.model;
      if (model) options.model = model;
      const maxTurns = opts.maxTurns ?? def.maxTurns;
      if (maxTurns != null) options.maxTurns = maxTurns;
      const temperature = opts.temperature ?? def.temperature;
      if (temperature != null) options.temperature = temperature;

      const mcp = this.agent.buildMcpServers();
      if (Object.keys(mcp).length > 0) options.mcpServers = mcp;

      const prompt = opts.images?.length
        ? {
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: opts.prompt },
                ...opts.images.map((img) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.mimeType as
                      | 'image/png'
                      | 'image/jpeg'
                      | 'image/gif'
                      | 'image/webp',
                    data: img.data,
                  },
                })),
              ],
            },
          }
        : opts.prompt;

      const conversation = query({ prompt: prompt as never, options: options as never });
      for await (const msg of conversation) {
        const m = msg as unknown as Record<string, unknown>;
        const sid = (m as { session_id?: string }).session_id;
        if (sid && sid !== this.sessionId) {
          sessionId = sid;
          this.sessionId = sid;
          writeSessionId(this.workspace, sid);
        }
        if (m.type === 'result') {
          const r = m as unknown as {
            subtype?: string;
            result?: string;
            usage?: Record<string, number>;
          };
          if (r.subtype === 'success') {
            text = r.result ?? '';
            usage = r.usage;
          } else {
            resultError = r.result || `agent result subtype=${r.subtype}`;
          }
        }
        emitFromSdkMessage(m, onEvent, sessionId);
      }
    } finally {
      clearTimeout(timer);
      this.abort = null;
    }

    if (resultError) {
      return { text: '', sessionId, usage, error: resultError };
    }
    return { text, sessionId, usage };
  }
}

export class Agent {
  readonly bundle: LoadedBundle;
  readonly workspace: string;
  readonly onEvent: ((event: StreamEvent) => void) | undefined;
  readonly timeoutMs: number;
  private readonly options: AgentOptions;

  private constructor(bundle: LoadedBundle, options: AgentOptions) {
    this.bundle = bundle;
    this.options = options;
    this.workspace = path.resolve(options.workspace);
    this.onEvent = options.onEvent;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    fs.mkdirSync(this.workspace, { recursive: true });
  }

  static async fromBundle(
    bundlePath: string,
    options: AgentOptions & LoadBundleOptions,
  ): Promise<Agent> {
    const bundle = await loadBundle(bundlePath, {
      secrets: options.secrets,
      skipHashCheck: options.skipHashCheck,
    });
    const agent = new Agent(bundle, options);
    agent.materializeSkills();
    return agent;
  }

  /**
   * F5：把 bundle 内联 skills 物化到 `{workspace}/.claude/skills/`（SDK 技能
   * 发现路径）。A5.2 白名单收敛由 query options 的 `skills` 数组保证——
   * workspace 里没有 bundle 外的 skill 目录。
   */
  private materializeSkills(): void {
    const skillsRoot = path.join(this.workspace, '.claude', 'skills');
    for (const [skillId, files] of this.bundle.skills) {
      const dir = path.join(skillsRoot, skillId);
      for (const [rel, content] of files) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
      }
    }
  }

  /** bundle 内联 skill 的 id 列表（query options 的 skills 白名单）。 */
  get skillNames(): string[] {
    return [...this.bundle.skills.keys()];
  }

  /**
   * 开启会话并发起首回合。自动 resume 同 workspace 的历史会话（A3.4）。
   * `session.wait()` 取结果。
   */
  async start(opts: StartOptions): Promise<Session> {
    const resumeId = readSessionId(this.workspace);
    const session = new Session(this, this.workspace, resumeId);
    session.send(opts); // 首回合入队；结果由 wait() 取
    return session;
  }

  /** 一次性调用（对应开放平台 AaaS 语义）。 */
  async run(prompt: string, opts: Partial<StartOptions> = {}): Promise<RunResult> {
    const session = await this.start({ prompt, ...opts });
    return session.wait();
  }

  /** 清除会话续接状态（下次 start 开新会话）。 */
  resetSession(): void {
    try {
      fs.rmSync(sessionStatePath(this.workspace), { force: true });
    } catch {
      /* ignore */
    }
  }

  /** 注入给 claude CLI 的环境变量（凭证 + 隔离的会话目录）。 */
  buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    // 会话持久化隔离到 workspace 内（跨进程 resume 的前提）
    env.CLAUDE_CONFIG_DIR = path.join(this.workspace, '.deepthink-sdk', 'claude');
    const creds = this.options.credentials ?? {};
    if (creds.apiKey) env.ANTHROPIC_API_KEY = creds.apiKey;
    if (creds.baseUrl) env.ANTHROPIC_BASE_URL = creds.baseUrl;
    return env;
  }

  /** 合并 bundle MCP 配置 + 自定义叠加 + 工具 server。 */
  buildMcpServers(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    // SDK 只认 command/args/env 或 type/url/headers；去掉 description 等装饰字段
    for (const [name, cfg] of Object.entries(this.bundle.mcpServers)) {
      const entry: Record<string, unknown> = {};
      const c = cfg as Record<string, unknown>;
      if (c.type === 'http' || c.type === 'sse') {
        entry.type = c.type;
        entry.url = c.url;
        if (c.headers) entry.headers = c.headers;
      } else {
        entry.command = c.command;
        if (c.args) entry.args = c.args;
        if (c.env) entry.env = c.env;
      }
      out[name] = entry;
    }
    if (this.options.extraMcpServers) Object.assign(out, this.options.extraMcpServers);
    if (this.options.toolsServer) out['deepthink-tools'] = this.options.toolsServer;
    return out;
  }
}
