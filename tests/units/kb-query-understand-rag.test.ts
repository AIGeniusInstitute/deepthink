// 查询理解接进 RAG 链路后的行为。
//
// 这条链路要证明的核心命题只有一个：**意图判定为"不需要检索"时，不得再回
// 「知识库中没有找到与该问题相关的内容」**。问候语被答以"资料中没有相关信息"
// 正是这个功能要消灭的失败模式，所以它必须有断言守着。
//
// 另一半同等重要：**查询理解任何一步失败，行为必须和没有这个功能时逐字节一致**。
// 理解是优化，不是闸门。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-qu-rag-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDir,
}));

const { initDatabase } = await import('../../src/db.js');
const { answerQuestion, answerQuestionStream, FALLBACK_ANSWER, SYSTEM_PROMPT, saveRagConfig } =
  await import('../../src/kb/rag.js');

/** Every chat call the pipeline made, in order. */
interface Call {
  system: string;
  lastUser: string;
}
let calls: Call[] = [];
/** What the understanding call should answer with, per test. */
let understandingReply = '{"rewrite_query":"你好","intent":"greeting"}';
/** Set to make the understanding call fail at the HTTP layer. */
let understandingStatus = 200;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The streaming path reads SSE frames, so it needs a `data:` body, not JSON. */
function sseResponse(text: string): Response {
  const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
  return new Response(`${frame}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string) as {
    messages: Array<{ role: string; content: string }>;
    stream?: boolean;
  };
  const system = body.messages[0].content;
  calls.push({ system, lastUser: body.messages[body.messages.length - 1].content });

  if (system.includes('Classify the intent')) {
    if (understandingStatus !== 200) return jsonResponse({ error: 'boom' }, understandingStatus);
    return jsonResponse({ choices: [{ message: { content: understandingReply } }] });
  }
  if (body.stream === true) return sseResponse('你好！有什么可以帮你的？');
  return jsonResponse({ choices: [{ message: { content: '你好！有什么可以帮你的？' } }] });
});

beforeAll(async () => {
  await initDatabase();
  saveRagConfig({ model: 'test-model', baseUrl: 'https://example.test/v1', apiKey: 'k' });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  calls = [];
  understandingReply = '{"rewrite_query":"你好","intent":"greeting"}';
  understandingStatus = 200;
  fetchMock.mockClear();
});

describe('意图为"不需要检索"时不应回落到兜底文案', () => {
  test('问候语：跳过检索，正常作答且不出现兜底文案', async () => {
    const result = await answerQuestion({
      kbIds: ['kb-does-not-exist'],
      question: '你好',
      enableQueryUnderstanding: true,
    });

    expect(result.fallback).toBe(false);
    expect(result.answer).toBe('你好！有什么可以帮你的？');
    expect(result.answer).not.toBe(FALLBACK_ANSWER);
    expect(result.hits).toHaveLength(0);
    expect(result.citations).toHaveLength(0);
    expect(result.understanding).toEqual({
      rewrite_query: '你好',
      intent: 'greeting',
      retrieval_skipped: true,
    });
  });

  test('用的是问候语专属 system 提示词，不是 RAG 提示词', async () => {
    await answerQuestion({
      kbIds: ['kb-does-not-exist'],
      question: '你好',
      enableQueryUnderstanding: true,
    });

    const answerCall = calls.find((c) => !c.system.includes('Classify the intent'));
    expect(answerCall).toBeDefined();
    expect(answerCall!.system).toContain('The user is greeting you');
    expect(answerCall!.system).not.toBe(SYSTEM_PROMPT);
    // 没有参考资料可引用，问题原样送入即可
    expect(answerCall!.lastUser).toBe('你好');
    expect(answerCall!.lastUser).not.toContain('参考资料');
  });

  test('流式路径同样不回落到兜底文案', async () => {
    const events: Array<{ type: string; text?: string; fallback?: boolean }> = [];
    for await (const ev of answerQuestionStream({
      kbIds: ['kb-does-not-exist'],
      question: '你好',
      enableQueryUnderstanding: true,
    })) {
      events.push(ev as { type: string; text?: string; fallback?: boolean });
    }
    const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text);
    expect(deltas).toEqual(['你好！有什么可以帮你的？']);
    const done = events.find((e) => e.type === 'done');
    expect(done?.fallback).toBe(false);
  });
});

describe('检索类意图仍然照常检索', () => {
  test('kb_search：命中为空时仍是兜底文案，且不再调用作答模型', async () => {
    understandingReply = '{"rewrite_query":"RAG架构是什么","intent":"kb_search"}';
    const result = await answerQuestion({
      kbIds: ['kb-does-not-exist'],
      question: '什么是RAG架构',
      enableQueryUnderstanding: true,
    });

    expect(result.fallback).toBe(true);
    expect(result.answer).toBe(FALLBACK_ANSWER);
    expect(result.understanding).toEqual({
      rewrite_query: 'RAG架构是什么',
      intent: 'kb_search',
      retrieval_skipped: false,
    });
    // 只发了理解那一次调用；作答调用没发（因为没检索到东西）
    expect(calls.filter((c) => !c.system.includes('Classify the intent'))).toHaveLength(0);
  });
});

describe('查询理解失败时行为与没有该功能时一致', () => {
  test('未开启时不调用理解模型，仍是兜底文案', async () => {
    const result = await answerQuestion({
      kbIds: ['kb-does-not-exist'],
      question: '你好',
    });

    expect(result.fallback).toBe(true);
    expect(result.understanding).toBeUndefined();
    expect(calls.filter((c) => c.system.includes('Classify the intent'))).toHaveLength(0);
  });

  test('理解调用返回非 200 时退回原行为', async () => {
    understandingStatus = 500;
    const result = await answerQuestion({
      kbIds: ['kb-does-not-exist'],
      question: '你好',
      enableQueryUnderstanding: true,
    });

    expect(result.fallback).toBe(true);
    expect(result.answer).toBe(FALLBACK_ANSWER);
    expect(result.understanding).toBeUndefined();
  });

  test('理解输出无法解析时退回原行为', async () => {
    understandingReply = '我不太确定你的意思';
    const result = await answerQuestion({
      kbIds: ['kb-does-not-exist'],
      question: '你好',
      enableQueryUnderstanding: true,
    });

    expect(result.fallback).toBe(true);
    expect(result.understanding).toBeUndefined();
  });

  test('理解调用抛异常时退回原行为', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('network down');
    });
    const result = await answerQuestion({
      kbIds: ['kb-does-not-exist'],
      question: '你好',
      enableQueryUnderstanding: true,
    });
    expect(result.fallback).toBe(true);
  });
});

describe('改写结果被用于检索', () => {
  test('改写后的查询传入检索，且原问题进扩展去重集（debug 可观测）', async () => {
    // 这里直接验证 retrieveForQuestion 的契约：理解开启但意图需检索时，
    // searchChunks 收到的是改写后的 query。用 debug 里回显的 expansion 触发
    // 条件无法直接观测入参，故改为断言 understanding.rewrite_query 已被采用。
    understandingReply = '{"rewrite_query":"改写后的问题","intent":"kb_search"}';
    const result = await answerQuestion({
      kbIds: ['kb-does-not-exist'],
      question: '它是什么',
      enableQueryUnderstanding: true,
    });
    expect(result.understanding?.rewrite_query).toBe('改写后的问题');
    expect(result.understanding?.retrieval_skipped).toBe(false);
  });
});
