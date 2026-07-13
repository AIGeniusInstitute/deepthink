import { beforeEach, describe, expect, test, vi } from 'vitest';

import { isClearCommand } from '../src/commands.js';

// Hoisted so mock factories below can reference these before module evaluation.
const {
  deleteSessionMock,
  getJidsByFolderMock,
  storeMessageDirectMock,
  ensureChatExistsMock,
} = vi.hoisted(() => ({
  deleteSessionMock: vi.fn(),
  getJidsByFolderMock: vi.fn(),
  storeMessageDirectMock: vi.fn(),
  ensureChatExistsMock: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  deleteSession: deleteSessionMock,
  getJidsByFolder: getJidsByFolderMock,
  storeMessageDirect: storeMessageDirectMock,
  ensureChatExists: ensureChatExistsMock,
}));

vi.mock('../src/config.js', () => ({
  DATA_DIR: '/tmp/deepthink-test',
}));

describe('isClearCommand', () => {
  test('exact match', () => {
    expect(isClearCommand('/clear')).toBe(true);
  });

  test('case insensitive', () => {
    expect(isClearCommand('/Clear')).toBe(true);
  });

  test('whitespace tolerant', () => {
    expect(isClearCommand('  /clear  ')).toBe(true);
  });

  test('rejects trailing args', () => {
    expect(isClearCommand('/clear hello')).toBe(false);
  });

  test('rejects embedded substring', () => {
    expect(isClearCommand('hi /clear')).toBe(false);
  });

  // Pin behavior: full-width slash is a different codepoint, must not match.
  test('rejects full-width slash', () => {
    expect(isClearCommand('／clear')).toBe(false);
  });
});

describe('executeSessionReset', () => {
  beforeEach(() => {
    deleteSessionMock.mockReset();
    getJidsByFolderMock.mockReset();
    storeMessageDirectMock.mockReset();
    ensureChatExistsMock.mockReset();
    vi.useRealTimers();
  });

  test('resets a bound conversation agent under the real workspace jid', async () => {
    const { executeSessionReset } = await import('../src/commands.js');
    const stopGroup = vi.fn(async () => {});
    const broadcast = vi.fn();
    const setLastAgentTimestamp = vi.fn();
    const sessions = { 'flow-graduation': 'session-1' } as Record<
      string,
      string
    >;

    await executeSessionReset(
      'web:graduation-jid',
      'flow-graduation',
      {
        queue: { stopGroup },
        sessions,
        broadcast,
        setLastAgentTimestamp,
      },
      'agent-1234',
    );

    // Agent path: only the virtual JID is stopped (no sibling fan-out).
    expect(stopGroup).toHaveBeenCalledTimes(1);
    expect(stopGroup).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      { force: true },
    );
    expect(ensureChatExistsMock).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
    );
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      expect.objectContaining({ id: expect.any(String) }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      expect.objectContaining({
        chat_jid: 'web:graduation-jid#agent:agent-1234',
      }),
    );
    // Agent path must NOT delete the main session's cached session ID —
    // sub-agent /clear should not corrupt the parent workspace's session.
    expect(sessions).toHaveProperty('flow-graduation', 'session-1');
  });

  test('resets a main session by stopping all sibling JIDs and clearing the folder cache', async () => {
    const { executeSessionReset } = await import('../src/commands.js');
    const stopGroup = vi.fn(async () => {});
    const broadcast = vi.fn();
    const setLastAgentTimestamp = vi.fn();
    const sessions = {
      'home-u1': 'session-main',
      'other-folder': 'session-other',
    } as Record<string, string>;

    getJidsByFolderMock.mockReturnValue(['web:foo', 'feishu:bar']);

    await executeSessionReset(
      'web:foo',
      'home-u1',
      {
        queue: { stopGroup },
        sessions,
        broadcast,
        setLastAgentTimestamp,
      },
      // agentId omitted (undefined) — main session branch
    );

    // stopGroup called once per sibling JID, all with { force: true }
    expect(stopGroup).toHaveBeenCalledTimes(2);
    expect(stopGroup).toHaveBeenCalledWith('web:foo', { force: true });
    expect(stopGroup).toHaveBeenCalledWith('feishu:bar', { force: true });

    // setLastAgentTimestamp called once per sibling JID
    expect(setLastAgentTimestamp).toHaveBeenCalledTimes(2);
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      'web:foo',
      expect.objectContaining({ id: expect.any(String) }),
    );
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      'feishu:bar',
      expect.objectContaining({ id: expect.any(String) }),
    );

    // sessions[folder] entry removed (in-memory cache)
    expect(sessions).not.toHaveProperty('home-u1');
    // unrelated entries preserved
    expect(sessions).toHaveProperty('other-folder', 'session-other');

    // ensureChatExists / broadcast use the baseChatJid (not a virtual agent JID)
    expect(ensureChatExistsMock).toHaveBeenCalledWith('web:foo');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'web:foo',
      expect.objectContaining({
        chat_jid: 'web:foo',
        content: 'context_reset',
      }),
    );
  });
});
