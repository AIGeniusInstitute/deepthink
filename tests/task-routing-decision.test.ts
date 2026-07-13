import { describe, expect, test, vi } from 'vitest';

import {
  resolveBroadcastFolder,
  resolveTaskRoutingDecision,
  type IpcMessageInputs,
  type ResolveTaskRoutingDeps,
  type TaskRecordForRouting,
} from '../src/task-routing.js';

/**
 * Regression tests covering the decision branch at src/index.ts:4170-4222
 * (message) and src/index.ts:4337-4377 (image). Helper-level unit tests in
 * tests/extractLastTaskId / broadcastToOwnerIMChannels cover the inputs, but
 * without resolveTaskRoutingDecision extracted, someone reverting the
 * dual-gate (`||` → single-flag) or swapping ipcTaskId precedence would not
 * trip any test. These tests lock the gate and precedence.
 *
 * Mutation checks (run by QA): flipping `||` to `&&` or to isScheduledTask-
 * only should turn at least one of these tests red.
 */

function makeDeps(
  taskRecords: Record<string, TaskRecordForRouting | null>,
  imJids: ReadonlySet<string>,
): ResolveTaskRoutingDeps {
  return {
    getTaskById: vi.fn((id: string) => taskRecords[id] ?? null),
    getChannelType: vi.fn((jid: string) => (imJids.has(jid) ? 'feishu' : null)),
  };
}

describe('resolveTaskRoutingDecision — dual-gate (isScheduledTask || taskId)', () => {
  test('isScheduledTask=true alone → enters task routing', () => {
    // Legacy isolated-run flag path (pre-B/C/D/E, still supported).
    const data: IpcMessageInputs = { isScheduledTask: true };
    const deps = makeDeps({}, new Set());
    const decision = resolveTaskRoutingDecision(data, null, true, deps);
    expect(decision.mode).toBe('broadcast');
  });

  test('taskId alone (group-mode output) → enters task routing', () => {
    // The load-bearing case for fix B/C/D/E. If someone reverts the `||`
    // back to single-gate `isScheduledTask`, this test must fail.
    const data: IpcMessageInputs = { taskId: 't-abc' };
    const deps = makeDeps(
      { 't-abc': { notify_channels: null, chat_jid: null } },
      new Set(),
    );
    const decision = resolveTaskRoutingDecision(data, null, true, deps);
    expect(decision.mode).toBe('broadcast');
    if (decision.mode === 'broadcast') {
      expect(decision.effectiveTaskId).toBe('t-abc');
    }
  });

  test('neither flag set → mode none (falls through to regular routing)', () => {
    const data: IpcMessageInputs = {};
    const deps = makeDeps({}, new Set());
    expect(
      resolveTaskRoutingDecision(data, null, true, deps).mode,
    ).toBe('none');
  });

  test('taskId set but hasCreatedBy false → mode none', () => {
    // Owner attribution is required; without it the broadcast lookup can't
    // resolve notify channels, so we must not enter the task branch even
    // though the gate flag is present.
    const data: IpcMessageInputs = { taskId: 't-abc' };
    const deps = makeDeps({}, new Set());
    expect(
      resolveTaskRoutingDecision(data, null, false, deps).mode,
    ).toBe('none');
  });
});

describe('resolveTaskRoutingDecision — effectiveTaskId precedence', () => {
  test('data.taskId wins over ipcTaskId', () => {
    // Per-message taskId (emitted by group-mode turn) supersedes the IPC
    // directory-derived ipcTaskId (legacy isolated-run namespace). Reverting
    // the precedence would cause group-mode outputs to look up the wrong
    // task record.
    const data: IpcMessageInputs = { taskId: 'msg-task', isScheduledTask: true };
    const deps = makeDeps(
      {
        'msg-task': { notify_channels: ['feishu'], chat_jid: null },
        'ipc-task': { notify_channels: ['telegram'], chat_jid: null },
      },
      new Set(),
    );
    const decision = resolveTaskRoutingDecision(data, 'ipc-task', true, deps);
    expect(decision.mode).toBe('broadcast');
    if (decision.mode === 'broadcast') {
      expect(decision.effectiveTaskId).toBe('msg-task');
      expect(decision.notifyChannels).toEqual(['feishu']);
    }
  });

  test('falls back to ipcTaskId when data.taskId is empty string', () => {
    // Empty-string taskId is treated as absent (matches extractLastTaskId
    // truthy semantics — see container-input-taskid.test.ts).
    const data: IpcMessageInputs = { taskId: '', isScheduledTask: true };
    const deps = makeDeps(
      { 'ipc-task': { notify_channels: ['telegram'], chat_jid: null } },
      new Set(),
    );
    const decision = resolveTaskRoutingDecision(data, 'ipc-task', true, deps);
    expect(decision.mode).toBe('broadcast');
    if (decision.mode === 'broadcast') {
      expect(decision.effectiveTaskId).toBe('ipc-task');
      expect(decision.notifyChannels).toEqual(['telegram']);
    }
  });

  test('effectiveTaskId is undefined when neither data.taskId nor ipcTaskId is set', () => {
    // Legacy isolated-run flag without a resolvable task record: still
    // broadcast, but notifyChannels is undefined (fan out to everything).
    const data: IpcMessageInputs = { isScheduledTask: true };
    const deps = makeDeps({}, new Set());
    const decision = resolveTaskRoutingDecision(data, null, true, deps);
    expect(decision.mode).toBe('broadcast');
    if (decision.mode === 'broadcast') {
      expect(decision.effectiveTaskId).toBeUndefined();
      expect(decision.notifyChannels).toBeUndefined();
    }
  });
});

describe('resolveTaskRoutingDecision — direct vs broadcast', () => {
  test('task with IM-valid chat_jid → mode direct', () => {
    const data: IpcMessageInputs = { taskId: 't1' };
    const deps = makeDeps(
      { t1: { notify_channels: ['feishu'], chat_jid: 'oc_group_123' } },
      new Set(['oc_group_123']),
    );
    const decision = resolveTaskRoutingDecision(data, null, true, deps);
    expect(decision.mode).toBe('direct');
    if (decision.mode === 'direct') {
      expect(decision.taskChatJid).toBe('oc_group_123');
      expect(decision.effectiveTaskId).toBe('t1');
      expect(decision.notifyChannels).toEqual(['feishu']);
    }
  });

  test('task with non-IM chat_jid (e.g. web:main) → mode broadcast', () => {
    // getChannelType returns null for web-prefixed jids, so the task has no
    // valid IM target and we must fall back to broadcast.
    const data: IpcMessageInputs = { taskId: 't1' };
    const deps = makeDeps(
      { t1: { notify_channels: null, chat_jid: 'web:main' } },
      new Set(), // no IM jids registered
    );
    const decision = resolveTaskRoutingDecision(data, null, true, deps);
    expect(decision.mode).toBe('broadcast');
  });

  test('task with null chat_jid → mode broadcast', () => {
    const data: IpcMessageInputs = { taskId: 't1' };
    const deps = makeDeps(
      { t1: { notify_channels: ['telegram'], chat_jid: null } },
      new Set(),
    );
    const decision = resolveTaskRoutingDecision(data, null, true, deps);
    expect(decision.mode).toBe('broadcast');
  });

  test('missing task record → mode broadcast with undefined notify channels', () => {
    // Task was deleted between prompt injection and output emission. We
    // still attempt to deliver the output (broadcast everywhere) rather
    // than swallowing it.
    const data: IpcMessageInputs = { taskId: 'deleted-task' };
    const deps = makeDeps({ 'deleted-task': null }, new Set());
    const decision = resolveTaskRoutingDecision(data, null, true, deps);
    expect(decision.mode).toBe('broadcast');
    if (decision.mode === 'broadcast') {
      expect(decision.effectiveTaskId).toBe('deleted-task');
      expect(decision.notifyChannels).toBeUndefined();
    }
  });
});

/**
 * Regression tests for fix F: the broadcast folder must be the emitting
 * workspace's own folder (`sourceFolder`), NEVER the owner's home folder.
 *
 * Why this exists: `broadcastToOwnerIMChannels` itself is folder-agnostic —
 * it does whatever matching the caller asks for. The bug was in the caller
 * (src/index.ts processGroupIpc) passing the wrong folder. Before this
 * helper was extracted, a mutation flipping the call site back to owner
 * home would silently pass CI (QA confirmed: 0/99 red). These tests lock
 * the choice inside the helper so such a regression shows up as a
 * functional change to resolveBroadcastFolder, not an innocent-looking
 * one-line edit at the call site.
 */
describe('resolveBroadcastFolder', () => {
  test('returns sourceFolder when ownerHome differs — home MUST NOT win', () => {
    // Scenario: user has a non-home workspace `ws-x` bound to a Feishu group.
    // Before fix F, the code returned ownerHome.folder (='home-u1'), which
    // meant the Feishu group on `ws-x` never received task results.
    expect(resolveBroadcastFolder('ws-x', 'home-u1')).toBe('ws-x');
  });

  test('returns sourceFolder when ownerHome is null', () => {
    // Happens when sourceGroupEntry.created_by is unset (legacy rows).
    expect(resolveBroadcastFolder('ws-x', null)).toBe('ws-x');
  });

  test('returns sourceFolder when ownerHome is undefined', () => {
    // Happens when getUserHomeGroup returns undefined.
    expect(resolveBroadcastFolder('ws-x', undefined)).toBe('ws-x');
  });

  test('returns sourceFolder even when it coincidentally equals ownerHome', () => {
    // For admin on home workspace, both candidates are the same folder.
    // Behaviorally correct either way, but we still commit to sourceFolder.
    expect(resolveBroadcastFolder('main', 'main')).toBe('main');
  });
});
