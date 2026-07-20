import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir so the supervisor DB functions have a real schema.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const {
  initDatabase,
  cleanupStaleSupervisorChecks,
  getSupervisorSession,
  listSupervisorSessions,
  listSupervisorDecisions,
  deleteSupervisorSession,
  createSupervisorDecision,
  updateSupervisorSession,
} = await import('../../src/db.js');

const {
  createSupervisorSessionFromInput,
  parseSupervisorDecision,
  runSupervisionCheck,
  runSupervisorTick,
  bootRecoverSupervisor,
  clampPeriodMs,
  clampMaxChecks,
  updateSupervisorSessionFromInput,
  deleteSupervisorSessionById,
} = await import('../../src/supervisor-agent.js');

import type { SupervisorCheckDeps } from '../../src/supervisor-agent.js';

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe all supervisor rows between tests for isolation.
  const all = listSupervisorSessions(null, { limit: 1000 });
  for (const s of all) deleteSupervisorSession(s.id);
});

const CHAT = 'web:test-sup';

function makeDeps(overrides: Partial<SupervisorCheckDeps> = {}): SupervisorCheckDeps {
  return {
    getRecentMessages: async () => [],
    getBoundLoopSummary: async () => null,
    sdkQuery: async () => '{"action":"continue","conclusion":"ok","evidence":[],"confidence":0.8}',
    storePromptMessage: async () => {},
    enqueueMessageCheck: async () => {},
    notifyUser: async () => {},
    ...overrides,
  };
}

describe('supervisor-agent: parseSupervisorDecision', () => {
  test('parses continue', () => {
    const d = parseSupervisorDecision('{"action":"continue","conclusion":"ok","evidence":[],"confidence":0.7}');
    expect(d?.action).toBe('continue');
    expect(d?.confidence).toBe(0.7);
  });
  test('parses redirect with hint', () => {
    const d = parseSupervisorDecision('{"action":"redirect","conclusion":"x","next_action_hint":"do Y","confidence":0.6}');
    expect(d?.action).toBe('redirect');
    expect(d?.next_action_hint).toBe('do Y');
  });
  test('redirect without hint returns null', () => {
    expect(parseSupervisorDecision('{"action":"redirect","conclusion":"x"}')).toBeNull();
  });
  test('strips markdown fences', () => {
    const d = parseSupervisorDecision('```json\n{"action":"complete","conclusion":"done"}\n```');
    expect(d?.action).toBe('complete');
  });
  test('filters invalid evidence types', () => {
    const d = parseSupervisorDecision('{"action":"continue","evidence":[{"type":"bogus","ref":"x"},{"type":"message","ref":"m1"}]}');
    expect(d?.evidence.length).toBe(1);
    expect(d?.evidence[0].type).toBe('message');
  });
  test('clamps confidence to [0,1]', () => {
    const d = parseSupervisorDecision('{"action":"continue","confidence":5}');
    expect(d?.confidence).toBe(1);
    const d2 = parseSupervisorDecision('{"action":"continue","confidence":-3}');
    expect(d2?.confidence).toBe(0);
  });
  test('returns null for invalid/unknown', () => {
    expect(parseSupervisorDecision('not json')).toBeNull();
    expect(parseSupervisorDecision('{"action":"maybe"}')).toBeNull();
    expect(parseSupervisorDecision('')).toBeNull();
  });
});

describe('supervisor-agent: clamp helpers', () => {
  test('clampPeriodMs floors 60s, caps 1h', () => {
    expect(clampPeriodMs(1000)).toBe(60_000);
    expect(clampPeriodMs(5 * 60_000)).toBe(5 * 60_000);
    expect(clampPeriodMs(10 * 3_600_000)).toBe(3_600_000);
    expect(clampPeriodMs(undefined)).toBe(300_000);
  });
  test('clampMaxChecks clamps [1,500]', () => {
    expect(clampMaxChecks(0)).toBe(1);
    expect(clampMaxChecks(100)).toBe(100);
    expect(clampMaxChecks(99999)).toBe(500);
  });
});

describe('supervisor-agent: lifecycle', () => {
  test('creates an active session with next_check_at', () => {
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: '完成 PRD',
      success_criteria: 'prd 文档存在',
    });
    expect(s.status).toBe('active');
    expect(s.next_check_at).not.toBeNull();
    expect(s.period_ms).toBe(300_000);
  });

  test('refuses second active session for same chat (409)', () => {
    createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
    });
    expect(() =>
      createSupervisorSessionFromInput({
        group_folder: 'g1',
        chat_jid: CHAT,
        goal_text: 'g2',
        success_criteria: 's2',
      }),
    ).toThrow(/已有活跃/);
  });

  test('toggle enabled false→paused, true→active', () => {
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
    });
    const paused = updateSupervisorSessionFromInput(s.id, { enabled: false });
    expect(paused.status).toBe('paused');
    const active = updateSupervisorSessionFromInput(s.id, { enabled: true });
    expect(active.status).toBe('active');
    expect(active.next_check_at).not.toBeNull();
  });

  test('delete refuses active without force, allows with force', () => {
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
    });
    expect(() => deleteSupervisorSessionById(s.id)).toThrow(/暂停|force/);
    expect(() => deleteSupervisorSessionById(s.id, { force: true })).not.toThrow();
    expect(getSupervisorSession(s.id)).toBeUndefined();
  });
});

describe('supervisor-agent: runSupervisionCheck', () => {
  test('continue decision advances next_check_at and does not feed back', async () => {
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
      period_ms: 60_000,
    });
    const stored: string[] = [];
    const deps = makeDeps({
      storePromptMessage: async (_jid, _sid, _sn, text) => stored.push(text),
    });
    const outcome = await runSupervisionCheck(s.id, deps, 'manual');
    expect(outcome).not.toBeNull();
    expect(outcome!.decision.action).toBe('continue');
    expect(stored.length).toBe(0); // continue does not feed back
    const fresh = getSupervisorSession(s.id)!;
    expect(fresh.current_checks).toBe(1);
    expect(fresh.consecutive_errors).toBe(0);
    expect(fresh.next_check_at).not.toBeNull();
  });

  test('redirect decision feeds back via storePromptMessage + enqueueMessageCheck', async () => {
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
      period_ms: 60_000,
    });
    let stored = false;
    let enqueued = false;
    const deps = makeDeps({
      sdkQuery: async () =>
        '{"action":"redirect","conclusion":"偏离","next_action_hint":"回到 PRD","confidence":0.7,"evidence":[{"type":"message","ref":"m1"}]}',
      storePromptMessage: async () => { stored = true; },
      enqueueMessageCheck: async () => { enqueued = true; },
    });
    const outcome = await runSupervisionCheck(s.id, deps, 'manual');
    expect(outcome!.decision.action).toBe('redirect');
    expect(stored).toBe(true);
    expect(enqueued).toBe(true);
    expect(outcome!.fedBack).toBe(true);
  });

  test('complete decision terminates the session', async () => {
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
    });
    let notified = '';
    const deps = makeDeps({
      sdkQuery: async () => '{"action":"complete","conclusion":"done","confidence":0.9}',
      notifyUser: async (_j, t) => { notified = t; },
    });
    await runSupervisionCheck(s.id, deps, 'manual');
    const fresh = getSupervisorSession(s.id)!;
    expect(fresh.status).toBe('completed');
    expect(fresh.next_check_at).toBeNull();
    expect(notified).toContain('达成');
  });

  test('parse failure increments consecutive_errors and eventually fails', async () => {
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
      period_ms: 60_000,
    });
    const deps = makeDeps({ sdkQuery: async () => 'not json' });
    // 4 errors: still active
    for (let i = 0; i < 4; i++) await runSupervisionCheck(s.id, deps, 'manual');
    expect(getSupervisorSession(s.id)!.status).toBe('active');
    expect(getSupervisorSession(s.id)!.consecutive_errors).toBe(4);
    // 5th: circuit breaker trips
    await runSupervisionCheck(s.id, deps, 'manual');
    expect(getSupervisorSession(s.id)!.status).toBe('failed');
  }, 30000);
});

describe('supervisor-agent: crash recovery', () => {
  test('cleanupStaleSupervisorChecks flips running → error', () => {
    // Seed a session + a stuck 'running' decision via the core create path,
    // then simulate a crash by NOT finalizing it.
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
    });
    createSupervisorDecision({
      id: 'dec_stuck',
      session_id: s.id,
      turn_index: 1,
      started_at: new Date().toISOString(),
    });
    const flipped = cleanupStaleSupervisorChecks();
    expect(flipped).toBeGreaterThanOrEqual(1);
    const rows = listSupervisorDecisions(s.id);
    const stuck = rows.find((r) => r.id === 'dec_stuck');
    expect(stuck.status).toBe('error');
  });

  test('bootRecoverSupervisor re-arms overdue active sessions', async () => {
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
      strategy: 'on_iteration', // fires immediately
    });
    // Force next_check_at into the past.
    updateSupervisorSession(s.id, { next_check_at: '2020-01-01T00:00:00.000Z' });
    const deps = makeDeps();
    const res = await bootRecoverSupervisor(deps);
    expect(res.reArmed).toBeGreaterThanOrEqual(1);
  });
});

describe('supervisor-agent: tick loop', () => {
  test('runSupervisorTick processes due sessions and advances next_check_at', async () => {
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
      period_ms: 60_000,
      strategy: 'on_iteration',
    });
    const deps = makeDeps();
    const res = await runSupervisorTick(deps);
    expect(res.checked).toBeGreaterThanOrEqual(1);
    // A decision should now exist.
    const decs = listSupervisorDecisions(s.id);
    expect(decs.length).toBeGreaterThanOrEqual(1);
  });

  test('on_iteration skips when bound loop has not advanced', async () => {
    // No bound_loop_run_id → strategy on_iteration with no bound loop: the
    // tick re-arms without running a check (hasBoundLoopAdvanced returns false).
    const s = createSupervisorSessionFromInput({
      group_folder: 'g1',
      chat_jid: CHAT,
      goal_text: 'g',
      success_criteria: 's',
      period_ms: 60_000,
      strategy: 'on_iteration',
      bound_loop_run_id: 'loop_nonexistent',
    });
    const called = vi.fn();
    const deps = makeDeps({ sdkQuery: async () => { called(); return '{"action":"continue","conclusion":"x"}'; } });
    await runSupervisorTick(deps);
    expect(called).not.toHaveBeenCalled();
    // session still active, next_check_at pushed forward
    const fresh = getSupervisorSession(s.id)!;
    expect(fresh.status).toBe('active');
    expect(fresh.current_checks).toBe(0);
  });
});
