import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// Isolated temp DATA_DIR so the suite never touches the real database.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepthink-provider-'));

vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>(
      '../src/config.js',
    );
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: path.join(tmpRoot, 'db'),
    GROUPS_DIR: path.join(tmpRoot, 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = await import('../src/db.ts');

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  db.deleteAllSessionsForFolder('grp');
});

/**
 * Story (PR #549, ACCEPTANCE #2): when a provider switch clears the SDK
 * session, deleteSession() removes the whole sessions row — including the
 * provider_id binding trySelectPoolProvider just wrote. The fix re-binds the
 * freshly-selected provider right after deleteSession so the next turn stays
 * sticky. These tests pin the db-level invariant the runner code now upholds.
 */
describe('provider switch: session clear must not lose the provider_id binding', () => {
  test('bare deleteSession drops the provider_id binding (the bug)', () => {
    db.setSession('grp', 'sess-A', null);
    db.setSessionProviderId('grp', null, 'provider-A');
    expect(db.getSessionProviderId('grp', null)).toBe('provider-A');

    // Reproduce the pre-fix behaviour: clearing the session also wipes the bind.
    db.deleteSession('grp', null);
    expect(db.getSessionProviderId('grp', null)).toBeUndefined();
  });

  test('deleteSession + re-bind keeps the freshly selected provider sticky (the fix)', () => {
    db.setSession('grp', 'sess-A', null);
    db.setSessionProviderId('grp', null, 'provider-A');

    // Runner sequence on a provider switch: clear session, then re-bind the
    // newly selected provider (container-runner.ts).
    db.deleteSession('grp', null);
    db.setSessionProviderId('grp', null, 'provider-B');

    // The SDK session id is cleared: setSessionProviderId upserts a row with an
    // empty session_id, which callers normalise via `getSession(...) || undefined`
    // (index.ts) — so no stale session gets resumed.
    expect(db.getSession('grp', null) || undefined).toBeUndefined();
    // The new binding survives so the next turn routes sticky to provider-B
    // instead of re-balancing.
    expect(db.getSessionProviderId('grp', null)).toBe('provider-B');
  });

  test('re-bind is agent-scoped — does not leak across agent_ids', () => {
    db.setSession('grp', 'sess-main', null);
    db.setSessionProviderId('grp', null, 'provider-A');
    db.setSession('grp', 'sess-agent', 'agent-1');
    db.setSessionProviderId('grp', 'agent-1', 'provider-A');

    // Switch only the agent-1 session.
    db.deleteSession('grp', 'agent-1');
    db.setSessionProviderId('grp', 'agent-1', 'provider-B');

    expect(db.getSessionProviderId('grp', 'agent-1')).toBe('provider-B');
    // Default (main) binding untouched.
    expect(db.getSession('grp', null)).toBe('sess-main');
    expect(db.getSessionProviderId('grp', null)).toBe('provider-A');
  });
});
