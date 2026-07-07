import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir — same pattern as task-meta.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-backfill-grace-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const {
  initDatabase,
  createTask,
  getTaskById,
  getDueTasks,
  advanceSkippedTask,
  updateTaskAfterRun,
} = await import('../src/db.js');

const { shouldSkipBackfill } = await import('../src/task-scheduler.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  createTask({
    id,
    group_folder: 'home-test',
    chat_jid: 'web:home-test',
    prompt: 'noop',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    script_command: null,
    execution_mode: 'container',
    next_run: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24h overdue
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: null,
    workspace_jid: null,
    workspace_folder: null,
    ...overrides,
  });
  return id;
}

describe('task backfill grace — db helpers', () => {
  test('getDueTasks returns all tasks with next_run <= now (regardless of how overdue)', () => {
    const id1 = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(), // 1 min overdue
    });
    const id2 = makeTask({
      next_run: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days overdue
    });
    const due = getDueTasks();
    const ids = due.map((t) => t.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  test('advanceSkippedTask updates next_run and does NOT touch last_run', () => {
    const id = makeTask({
      next_run: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    });
    const before = getTaskById(id)!;
    expect(before.last_run).toBeFalsy(); // never ran

    const newNext = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    advanceSkippedTask(id, newNext);

    const after = getTaskById(id)!;
    expect(after.next_run).toBe(newNext);
    expect(after.last_run).toBeFalsy(); // still not set — skipping is not running
    expect(after.status).toBe('active');
  });

  test('advanceSkippedTask with null nextRun marks once-task as completed', () => {
    const id = makeTask({
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    advanceSkippedTask(id, null);
    const after = getTaskById(id)!;
    expect(after.next_run).toBeNull();
    expect(after.status).toBe('completed');
  });

  test('updateTaskAfterRun continues to set last_run (sanity check the helpers stay distinct)', () => {
    const id = makeTask();
    updateTaskAfterRun(id, new Date(Date.now() + 60_000).toISOString(), 'ran ok');
    const after = getTaskById(id)!;
    expect(after.last_run).toBeTruthy(); // contrast with advanceSkippedTask
    expect(after.last_result).toBe('ran ok');
  });
});

describe('task backfill grace — decision predicate', () => {
  // Imported directly from production code so a future inline-only change
  // breaks the test rather than silently drifting from a local mirror.

  test('graceMs=0 disables skipping (legacy behavior preserved)', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldSkipBackfill(tenDaysAgo, Date.now(), 0)).toBe(false);
  });

  test('within grace window: do not skip', () => {
    const now = Date.now();
    const oneMinuteAgo = new Date(now - 60_000).toISOString();
    // grace = 5 min; 1 min overdue is within window
    expect(shouldSkipBackfill(oneMinuteAgo, now, 300_000)).toBe(false);
  });

  test('beyond grace window: skip', () => {
    const now = Date.now();
    const tenMinutesAgo = new Date(now - 10 * 60_000).toISOString();
    // grace = 5 min; 10 min overdue exceeds window
    expect(shouldSkipBackfill(tenMinutesAgo, now, 300_000)).toBe(true);
  });

  test('null next_run never triggers skip', () => {
    expect(shouldSkipBackfill(null, Date.now(), 300_000)).toBe(false);
  });

  test('exactly at boundary: do not skip (overdue must be strictly greater)', () => {
    const now = Date.now();
    const exactlyFiveMinutesAgo = new Date(now - 300_000).toISOString();
    expect(shouldSkipBackfill(exactlyFiveMinutesAgo, now, 300_000)).toBe(false);
  });
});
