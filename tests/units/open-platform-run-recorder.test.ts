// 开放平台 AaaS 运行记录器（Agent Runtime Monitor 的写入侧）。
//
// 这是全平台**唯一**新增的写入路径，因此也是唯一可能弄坏付费 AaaS 接口的改动面。
// 用例分两组：
//   1. 正常路径 —— 运行记录、状态、用量、轨迹都写对了没有；
//   2. 旁路保证 —— 监控存储坏掉时，runAgent / streamAgent 的行为必须不受影响。
//
// 第 2 组是这组用例存在的最高理由：监控是旁路，它挂了绝不能变成客户的 500。

import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-recorder-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const { initDatabase, getDb } = await import('../../src/db.js');
const { createRunRecorder } = await import('../../src/open-platform/run-recorder.js');

beforeAll(() => {
  initDatabase();
});

interface RunRow {
  id: string;
  agent_id: string;
  user_id: string;
  key_id: string | null;
  channel: string;
  model: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  num_turns: number;
  error: string | null;
  request_summary: string | null;
  response_summary: string | null;
  trace_id: string;
}

function getRun(runId: string): RunRow | undefined {
  return getDb().prepare('SELECT * FROM open_platform_runs WHERE id = ?').get(runId) as
    | RunRow
    | undefined;
}

function getSteps(traceId: string): Array<Record<string, unknown>> {
  return getDb()
    .prepare('SELECT * FROM trace_steps WHERE trace_id = ? ORDER BY started_at ASC, id ASC')
    .all(traceId) as Array<Record<string, unknown>>;
}

const BASE = {
  agentId: 'agent-1',
  userId: 'u1',
  keyId: 'key-1',
  channel: 'api' as const,
  model: 'claude-x',
  userText: '给我一份周报',
};

describe('起点', () => {
  test('onCreate 落一行 running，带 channel / keyId / 请求摘要', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    const row = getRun(rec.runId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('running');
    expect(row!.agent_id).toBe('agent-1');
    expect(row!.user_id).toBe('u1');
    expect(row!.key_id).toBe('key-1');
    expect(row!.channel).toBe('api');
    expect(row!.model).toBe('claude-x');
    expect(row!.ended_at).toBeNull();
    expect(row!.request_summary).toBe('给我一份周报');
    expect(row!.trace_id).toBe(rec.runId);
  });

  test('keyId 缺省时写 NULL（控制台调试调用没有 API Key）', () => {
    const rec = createRunRecorder({ ...BASE, channel: 'debug', keyId: null });
    rec.onCreate();
    expect(getRun(rec.runId)!.key_id).toBeNull();
  });

  test('trace_id 等于 run_id —— 轨迹查询靠这个关联', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    expect(getRun(rec.runId)!.trace_id).toBe(rec.runId);
    expect(rec.traceId).toBe(rec.runId);
  });

  test('超长请求摘要被截断', () => {
    const rec = createRunRecorder({ ...BASE, userText: 'x'.repeat(5000) });
    rec.onCreate();
    const summary = getRun(rec.runId)!.request_summary!;
    expect(summary.length).toBeLessThan(600);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('终态', () => {
  test('成功：状态、结束时间、用量、响应摘要', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    rec.onResult({
      result: '这是周报正文',
      total_cost_usd: 0.12,
      num_turns: 3,
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    rec.finish('completed');

    const row = getRun(rec.runId)!;
    expect(row.status).toBe('completed');
    expect(row.ended_at).not.toBeNull();
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(200);
    expect(row.cost_usd).toBeCloseTo(0.12, 6);
    expect(row.num_turns).toBe(3);
    expect(row.response_summary).toBe('这是周报正文');
    expect(row.error).toBeNull();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('失败：状态为 failed 且带上错误原因', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    rec.finish('failed', new Error('上游 500'));
    const row = getRun(rec.runId)!;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('上游 500');
  });

  test('**finish 幂等** —— SSE 的 finally 兜底会二次调用，不能把终态覆盖回去', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    rec.finish('completed', undefined, '正常结束');
    expect(rec.isFinished()).toBe(true);

    rec.finish('failed', new Error('客户端断开'));
    const row = getRun(rec.runId)!;
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    expect(row.response_summary).toBe('正常结束');
  });

  test('isFinished 在 finish 之前为 false（SSE 靠它判断要不要兜底收尾）', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    expect(rec.isFinished()).toBe(false);
    rec.finish('completed');
    expect(rec.isFinished()).toBe(true);
  });

  test('没有 result 事件就结束（如客户端中途断开）→ 用量归 0，不抛错', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    rec.finish('failed', new Error('stream closed'));
    const row = getRun(rec.runId)!;
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.cost_usd).toBe(0);
  });

  test('非 Error 值也能落成错误文本', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    rec.finish('failed', 'plain string failure');
    expect(getRun(rec.runId)!.error).toBe('plain string failure');
  });
});

describe('轨迹（trace_steps）', () => {
  test('工具调用被采集成 span，并补一条覆盖整次运行的 turn span', () => {
    const rec = createRunRecorder({ ...BASE, channel: 'sse' });
    rec.onCreate();
    rec.onSdkEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'web_search' } },
    });
    rec.onSdkEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'send_file' } },
    });
    rec.onResult({ result: 'done', usage: { input_tokens: 5, output_tokens: 7 } });
    rec.finish('completed');

    const steps = getSteps(rec.runId);
    const tools = steps.filter((s) => s.node_type === 'tool');
    const turns = steps.filter((s) => s.node_type === 'turn');
    expect(tools.map((t) => t.title)).toEqual(['web_search', 'send_file']);
    expect(turns).toHaveLength(1);
    expect(turns[0].tokens).toBe(12);
    expect(turns[0].input_summary).toBe('给我一份周报');
    expect(turns[0].output_summary).toBe('done');
  });

  test('未收敛的工具 span 在结束时被闭合（不留 running 的孤儿）', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    rec.onSdkEvent({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'slow_tool' } },
    });
    rec.finish('completed');
    const tool = getSteps(rec.runId).find((s) => s.node_type === 'tool')!;
    expect(tool.status).toBe('done');
    expect(tool.ended_at).not.toBeNull();
  });

  test('文本增量累积成响应摘要（SDK 只流式给文本、不给最终串时用得上）', () => {
    const rec = createRunRecorder({ ...BASE, channel: 'sse' });
    rec.onCreate();
    for (const text of ['周报', '正文', '完成']) {
      rec.onSdkEvent({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      });
    }
    rec.finish('completed');
    expect(getRun(rec.runId)!.response_summary).toBe('周报正文完成');
  });

  test('result 的最终文本覆盖流式累积（以权威值为准）', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    rec.onSdkEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '半截' } },
    });
    rec.onResult({ result: '完整答案' });
    rec.finish('completed');
    expect(getRun(rec.runId)!.response_summary).toBe('完整答案');
  });

  test('**不写 chat_jid / graph_run_id** —— 免得污染既有对话轨迹与 FLM 消费方', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    rec.finish('completed', undefined, 'x');
    for (const step of getSteps(rec.runId)) {
      expect(step.chat_jid).toBeNull();
      expect(step.graph_run_id).toBeNull();
    }
  });

  test('每次运行用自己的 trace_id，互不串台', () => {
    const a = createRunRecorder(BASE);
    const b = createRunRecorder(BASE);
    a.onCreate();
    b.onCreate();
    a.finish('completed', undefined, 'A');
    b.finish('completed', undefined, 'B');
    expect(getSteps(a.runId).length).toBeGreaterThan(0);
    expect(getSteps(b.runId).length).toBeGreaterThan(0);
    expect(getSteps(a.runId).every((s) => s.trace_id === a.runId)).toBe(true);
  });

  test('无关的 SDK 事件被忽略，不产生垃圾 span', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    rec.onSdkEvent({ type: 'system', subtype: 'init' });
    rec.onSdkEvent({ type: 'stream_event' });
    rec.onSdkEvent({ type: 'stream_event', event: { type: 'message_start' } });
    rec.onSdkEvent(null);
    rec.onSdkEvent(undefined);
    rec.finish('completed');
    const steps = getSteps(rec.runId);
    expect(steps.filter((s) => s.node_type === 'tool')).toHaveLength(0);
    expect(steps.filter((s) => s.node_type === 'turn')).toHaveLength(1);
  });
});

describe('旁路保证：监控坏了不能影响 AaaS 主链路', () => {
  test('运行记录表不存在时，onCreate/finish 只吞掉错误而不抛出', () => {
    const db = getDb();
    db.exec('ALTER TABLE open_platform_runs RENAME TO open_platform_runs_hidden');
    try {
      const rec = createRunRecorder(BASE);
      expect(() => rec.onCreate()).not.toThrow();
      expect(() => rec.onResult({ result: 'x' })).not.toThrow();
      expect(() => rec.finish('completed')).not.toThrow();
      // 幂等性不能因为写库失败而失效
      expect(rec.isFinished()).toBe(true);
    } finally {
      db.exec('ALTER TABLE open_platform_runs_hidden RENAME TO open_platform_runs');
    }
  });

  test('轨迹表缺失时，运行记录仍然能落终态', () => {
    const db = getDb();
    db.exec('ALTER TABLE trace_steps RENAME TO trace_steps_hidden');
    try {
      const rec = createRunRecorder(BASE);
      rec.onCreate();
      rec.onSdkEvent({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 't' } },
      });
      expect(() => rec.finish('completed', undefined, 'ok')).not.toThrow();
      expect(getRun(rec.runId)!.status).toBe('completed');
    } finally {
      db.exec('ALTER TABLE trace_steps_hidden RENAME TO trace_steps');
    }
  });

  test('onSdkEvent 收到畸形事件也不抛（SDK 版本升级可能改形状）', () => {
    const rec = createRunRecorder(BASE);
    rec.onCreate();
    expect(() => rec.onSdkEvent({ type: 'stream_event', event: { type: 'content_block_start' } })).not.toThrow();
    expect(() => rec.onSdkEvent({ type: 'stream_event', event: 'not-an-object' })).not.toThrow();
    expect(() => rec.onResult({ usage: 'not-an-object' })).not.toThrow();
    rec.finish('completed');
    expect(getRun(rec.runId)!.status).toBe('completed');
  });
});
