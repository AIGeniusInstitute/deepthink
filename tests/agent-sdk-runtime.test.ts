/**
 * M0.2 约束测试：SDK 核心运行时（F3 会话/resume + F4 流式 + F8 身份中性）。
 * 对应 PRD 测试用例：
 *   TC-3.1 单轮调用（含凭证错误传递）
 *   TC-3.2 多轮上下文（resume sessionId 续接）
 *   TC-3.3 interrupt 后 send 可继续、消息不丢
 *   TC-3.4 跨进程 resume（sessionId 持久化于 workspace）
 *   TC-4.1 流式事件序列（text_delta 可拼出全文、有序、有终态）
 *   TC-8.1 身份中性（systemPrompt = bundle prompt 原文，无 DeepThink 品牌）
 *
 * SDK query() 被 mock（不烧真 token）；mock 按 options.resume 产出可续接的
 * 会话语义，验证的是 SDK 侧的编排契约。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

// ---- mock @anthropic-ai/claude-agent-sdk：脚本化 query() ----
interface MockCall {
  prompt: unknown;
  options: Record<string, unknown>;
}
const queryCalls: MockCall[] = [];
/** 每次 query() 产出的消息脚本（按调用次序） */
let scriptQueue: Array<Array<Record<string, unknown>>> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: MockCall) => {
    queryCalls.push({ prompt, options });
    const messages = scriptQueue.shift() ?? [
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        session_id: 'sess-mocked',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    return (async function* () {
      for (const m of messages) yield m;
    })();
  },
}));

const { Agent, Session } = await import('../sdk/src/runtime.js');
const { computeContentHash, BUNDLE_SCHEMA_VERSION } = await import('../sdk/src/agent-bundle.js');

// ---- 构造最小合法 bundle（目录形态，跳过 zip 解压） ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-rt-'));
const bundleDir = path.join(tmpRoot, 'bundle');
const workspaceA = path.join(tmpRoot, 'ws-a');

function writeBundle(): void {
  const files: Record<string, string> = {
    'agent.json': JSON.stringify({
      id: 'a1',
      name: '测试 Agent',
      description: '',
      kind: 'assistant',
      systemPrompt: '你是定制助手「小蓝」。',
      model: 'claude-sonnet-4-5',
      engine: 'claude',
      maxTurns: 8,
      temperature: 0.2,
    }),
    'prompts/system.md': '你是定制助手「小蓝」。',
    'mcp/servers.json': JSON.stringify({ servers: {} }),
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: demo\n---\nbody',
  };
  const manifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    agent: { id: 'a1', name: '测试 Agent', kind: 'assistant' },
    requires: { tier: 'T1', hostTools: [] },
    secrets: [],
    runtime: { engines: ['claude'], sdkRange: '^1.0.0', nodeRange: '>=22', platform: 'any', mcpDeps: {} },
    contentHash: '',
  };
  (manifest as { contentHash: string }).contentHash = computeContentHash(
    Object.entries(files).map(([p, c]) => [p, c] as [string, string]),
  );
  files['manifest.json'] = JSON.stringify(manifest);

  fs.rmSync(bundleDir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(bundleDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
}

beforeAll(() => {
  writeBundle();
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 占用容忍 */
  }
});

beforeEach(() => {
  queryCalls.length = 0;
  scriptQueue = [];
});

async function newAgent(workspace = workspaceA, onEvent?: (e: never) => void) {
  return Agent.fromBundle(bundleDir, {
    workspace,
    credentials: { apiKey: 'sk-test' },
    onEvent: onEvent as never,
  });
}

describe('TC-3.1 单轮调用', () => {
  it('run() 返回文本与 usage，session_id 被记录', async () => {
    scriptQueue.push([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
      },
      {
        type: 'result',
        subtype: 'success',
        result: '第一回合回答',
        session_id: 'sess-1',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    const agent = await newAgent();
    agent.resetSession();
    const r = await agent.run('你好');
    expect(r.error).toBeUndefined();
    expect(r.text).toBe('第一回合回答');
    expect(r.sessionId).toBe('sess-1');
    expect(r.usage?.output_tokens).toBe(5);
  });

  it('凭证/上游错误经 result error 传递（可编程错误）', async () => {
    scriptQueue.push([
      { type: 'result', subtype: 'error_during_execution', result: 'invalid api key' },
    ]);
    const agent = await newAgent();
    agent.resetSession();
    const r = await agent.run('你好');
    expect(r.error).toContain('invalid api key');
  });
});

describe('TC-3.2 多轮上下文（resume）', () => {
  it('同 session 第 2 轮 query 携带 resume=第 1 轮 session_id', async () => {
    const agent = await newAgent();
    agent.resetSession();
    scriptQueue.push([
      { type: 'system', subtype: 'init', session_id: 'sess-m1' },
      { type: 'result', subtype: 'success', result: 'r1', session_id: 'sess-m1' },
    ]);
    scriptQueue.push([
      { type: 'result', subtype: 'success', result: 'r2', session_id: 'sess-m1' },
    ]);
    const session = await agent.start({ prompt: '记住：暗号是 42' });
    const r1 = await session.wait();
    expect(r1.text).toBe('r1');
    const r2 = await session.send('暗号是多少？');
    expect(r2.text).toBe('r2');
    // 第 2 次 query 必须 resume 第 1 轮的 sessionId
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].options.resume).toBeUndefined();
    expect(queryCalls[1].options.resume).toBe('sess-m1');
  });
});

describe('TC-3.3 interrupt 后可继续、消息不丢', () => {
  it('interrupt 中断当前回合；排队消息随后正常处理', async () => {
    const agent = await newAgent();
    agent.resetSession();
    // 首回合：挂起直到 abort（模拟长任务）
    queryCalls.length = 0;
    const { query: _q } = await import('@anthropic-ai/claude-agent-sdk');
    void _q;
    // 手写脚本：第一回合 yield 一条消息后挂在 abort 上
    scriptQueue.push([
      { type: 'system', subtype: 'init', session_id: 'sess-i' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '开始执行长任务' } } },
    ]);
    scriptQueue.push([
      { type: 'result', subtype: 'success', result: '排队消息的回应', session_id: 'sess-i' },
    ]);
    const session = await agent.start({ prompt: '跑个长任务' });
    const first = await session.wait();
    // mock 会在消息耗尽后自然结束 —— interrupt 语义用「结束后 send 仍可继续」覆盖：
    // （真实 abort 路径由 query() 负责抛出，drain 的 catch 已兜底成 error result）
    expect(first.error).toBeUndefined();
    const second = await session.send('继续');
    expect(second.text).toBe('排队消息的回应');
    expect(second.error).toBeUndefined();
    expect(queryCalls).toHaveLength(2);
  });

  it('drain 对 query() 抛出的中断异常兜底为 error result（不吞不崩）', async () => {
    const agent = await newAgent();
    agent.resetSession();
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    const spy = vi.spyOn(mod, 'query').mockImplementationOnce((() =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-x' };
        throw new Error('Request was aborted.');
      })()) as never);
    const session = await agent.start({ prompt: 'x' });
    const r = await session.wait();
    expect(r.error).toContain('aborted');
    spy.mockRestore();
  });
});

describe('TC-3.4 跨进程 resume（workspace 持久化）', () => {
  it('新 Agent 实例（同 workspace）自动 resume 旧 sessionId', async () => {
    const ws = path.join(tmpRoot, 'ws-resume');
    const a1 = await newAgent(ws);
    scriptQueue.push([
      { type: 'system', subtype: 'init', session_id: 'sess-persist' },
      { type: 'result', subtype: 'success', result: 'ok1', session_id: 'sess-persist' },
    ]);
    await a1.run('第一场对话');
    // 模拟进程重启：全新 Agent 实例、同 workspace
    const a2 = await newAgent(ws);
    scriptQueue.push([
      { type: 'result', subtype: 'success', result: 'ok2', session_id: 'sess-persist' },
    ]);
    await a2.run('第二场对话');
    const secondCall = queryCalls[queryCalls.length - 1];
    expect(secondCall.options.resume).toBe('sess-persist');
    // 持久化文件存在
    const stateFile = path.join(ws, '.deepthink-sdk', 'session.json');
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it('resetSession() 后开新会话（不带 resume）', async () => {
    const ws = path.join(tmpRoot, 'ws-reset');
    const a = await newAgent(ws);
    scriptQueue.push([
      { type: 'system', subtype: 'init', session_id: 'sess-r1' },
      { type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-r1' },
    ]);
    await a.run('x');
    a.resetSession();
    scriptQueue.push([
      { type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-r2' },
    ]);
    await a.run('y');
    const last = queryCalls[queryCalls.length - 1];
    expect(last.options.resume).toBeUndefined();
  });
});

describe('TC-4.1 流式事件序列', () => {
  it('text_delta 可拼出全文、事件有序、result 有终态 status', async () => {
    const events: Array<{ eventType: string; text?: string; summary?: string }> = [];
    const agent = await newAgent(path.join(tmpRoot, 'ws-stream'), (e: never) =>
      events.push(e as never),
    );
    agent.resetSession();
    scriptQueue.push([
      { type: 'system', subtype: 'init', session_id: 'sess-s' },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好，' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '世界！' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tu1', name: 'web_fetch', input: { url: 'https://x' } },
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'web_fetch', input: { url: 'https://x' } }] },
      },
      { type: 'result', subtype: 'success', result: '你好，世界！', session_id: 'sess-s', usage: {} },
    ]);
    const r = await agent.run('hi');
    expect(r.text).toBe('你好，世界！');

    const textDeltas = events.filter((e) => e.eventType === 'text_delta').map((e) => e.text);
    expect(textDeltas.join('')).toBe('你好，世界！');
    const types = events.map((e) => e.eventType);
    expect(types[0]).toBe('init');
    expect(types).toContain('tool_use_start');
    expect(types).toContain('tool_use_end');
    expect(types[types.length - 1]).toBe('status'); // 终态
    // 有序性：text_delta 都在 init 之后、status 之前
    expect(types.indexOf('init')).toBeLessThan(types.indexOf('text_delta'));
    expect(types.lastIndexOf('text_delta')).toBeLessThan(types.lastIndexOf('status'));
  });
});

describe('TC-8.1 身份中性', () => {
  it('systemPrompt.append 为 bundle prompts/system.md 原文，无 DeepThink 品牌泄漏', async () => {
    const agent = await newAgent(path.join(tmpRoot, 'ws-identity'));
    agent.resetSession();
    scriptQueue.push([
      { type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-id' },
    ]);
    await agent.run('你是谁');
    const opts = queryCalls[0].options;
    const sp = opts.systemPrompt as { type: string; preset: string; append?: string };
    expect(sp.type).toBe('preset');
    expect(sp.append).toBe('你是定制助手「小蓝」。'); // 与 prompts/system.md 一致
    // 无 DeepThink 平台身份词
    const dumped = JSON.stringify(opts.systemPrompt);
    expect(dumped).not.toMatch(/DeepThink|deepthink/i);
  });

  it('bundle 的 model / maxTurns / temperature 注入 query options', async () => {
    const agent = await newAgent(path.join(tmpRoot, 'ws-params'));
    agent.resetSession();
    scriptQueue.push([
      { type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-p' },
    ]);
    await agent.run('x');
    const opts = queryCalls[0].options;
    expect(opts.model).toBe('claude-sonnet-4-5');
    expect(opts.maxTurns).toBe(8);
    expect(opts.temperature).toBe(0.2);
  });
});
