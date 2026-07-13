import { describe, expect, test } from 'vitest';

import {
  buildSendMessageData,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

function baseCtx(overrides: Partial<McpContext> = {}): McpContext {
  return {
    chatJid: 'web:ws-x',
    groupFolder: 'ws-x',
    isHome: false,
    isAdminHome: false,
    isScheduledTask: false,
    currentTaskId: null,
    workspaceIpc: '/tmp/ipc',
    workspaceGroup: '/tmp/group',
    workspaceGlobal: '/tmp/global',
    ...overrides,
  } as McpContext;
}

describe('buildSendMessageData — task attribution stamping', () => {
  test('currentTaskId set → data includes taskId', () => {
    const ctx = baseCtx({ currentTaskId: 'task-42' });
    const data = buildSendMessageData(ctx, { type: 'message', text: 'hi' });
    expect(data.taskId).toBe('task-42');
    // Caller-provided fields flow through
    expect(data.type).toBe('message');
    expect(data.text).toBe('hi');
    // chatJid + groupFolder stamped
    expect(data.chatJid).toBe('web:ws-x');
    expect(data.groupFolder).toBe('ws-x');
  });

  test('currentTaskId null → data has NO taskId key (not undefined value)', () => {
    const ctx = baseCtx({ currentTaskId: null });
    const data = buildSendMessageData(ctx, { type: 'message', text: 'hi' });
    // Critical: must be absent, not {taskId: undefined}. The IPC consumer
    // side uses `typeof data.taskId === 'string' && data.taskId` so absence
    // vs undefined are equivalent here, but absence is the contract.
    expect('taskId' in data).toBe(false);
  });

  test('currentTaskId undefined → data has NO taskId key', () => {
    const ctx = baseCtx({ currentTaskId: undefined });
    const data = buildSendMessageData(ctx, { type: 'message', text: 'hi' });
    expect('taskId' in data).toBe(false);
  });

  test('currentTaskId empty string → data has NO taskId key (falsy gate)', () => {
    const ctx = baseCtx({ currentTaskId: '' });
    const data = buildSendMessageData(ctx, { type: 'message', text: 'hi' });
    expect('taskId' in data).toBe(false);
  });

  test('isScheduledTask true → data has isScheduledTask: true', () => {
    const ctx = baseCtx({ isScheduledTask: true });
    const data = buildSendMessageData(ctx, { type: 'message', text: 'x' });
    expect(data.isScheduledTask).toBe(true);
  });

  test('isScheduledTask false → data has NO isScheduledTask key', () => {
    const ctx = baseCtx({ isScheduledTask: false });
    const data = buildSendMessageData(ctx, { type: 'message', text: 'x' });
    expect('isScheduledTask' in data).toBe(false);
  });

  test('both flags → data carries both taskId and isScheduledTask', () => {
    const ctx = baseCtx({ isScheduledTask: true, currentTaskId: 'task-7' });
    const data = buildSendMessageData(ctx, { type: 'message', text: 'x' });
    expect(data.isScheduledTask).toBe(true);
    expect(data.taskId).toBe('task-7');
  });

  test('extras do not override chatJid/groupFolder (data starts with ctx values, extras spread after but do not collide)', () => {
    // The impl spreads extras AFTER chatJid/groupFolder, so extras *could*
    // technically override them. We pin the current behavior so any future
    // change is reviewed.
    const ctx = baseCtx({ chatJid: 'web:a', groupFolder: 'a' });
    const data = buildSendMessageData(ctx, {
      type: 'message',
      text: 'hi',
      // Intentionally include a timestamp override to exercise spread order.
      timestamp: 'custom-ts',
    });
    expect(data.type).toBe('message');
    expect(data.text).toBe('hi');
    expect(data.timestamp).toBe('custom-ts');
    expect(data.chatJid).toBe('web:a');
    expect(data.groupFolder).toBe('a');
  });

  test('timestamp is stamped when extras do not override it', () => {
    const ctx = baseCtx();
    const data = buildSendMessageData(ctx, { type: 'message', text: 'x' });
    expect(typeof data.timestamp).toBe('string');
    expect((data.timestamp as string).length).toBeGreaterThan(0);
  });

  test('image payload: currentTaskId propagates through extras carrying imageBase64', () => {
    // Exercises the send_image code path — same helper, different extras shape.
    const ctx = baseCtx({ currentTaskId: 'task-42', isScheduledTask: true });
    const data = buildSendMessageData(ctx, {
      type: 'image',
      imageBase64: 'AAA=',
      mimeType: 'image/png',
    });
    expect(data.type).toBe('image');
    expect(data.imageBase64).toBe('AAA=');
    expect(data.mimeType).toBe('image/png');
    expect(data.taskId).toBe('task-42');
    expect(data.isScheduledTask).toBe(true);
  });
});
