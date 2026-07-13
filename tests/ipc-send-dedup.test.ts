import { describe, expect, test, vi } from 'vitest';

import { createIpcSendDeduplicator } from '../src/ipc-send-dedup.js';

function makeDedup(opts: {
  retryCounts?: Record<string, number>;
  jidsByFolder?: Record<string, string[]>;
  now?: () => number;
}) {
  const getRetryCount = vi.fn((jid: string) => opts.retryCounts?.[jid] ?? 0);
  const getJidsByFolder = vi.fn(
    (folder: string) => opts.jidsByFolder?.[folder] ?? [],
  );
  const dedup = createIpcSendDeduplicator({
    getRetryCount,
    getJidsByFolder,
    now: opts.now,
  });
  return { dedup, getRetryCount, getJidsByFolder };
}

describe('IPC send_message retry dedup', () => {
  test('finds retry state for a normal web group whose chatJid differs from web:<folder>', () => {
    const { dedup, getJidsByFolder } = makeDedup({
      retryCounts: { 'web:7b1f0c1e-1234-dead-beef': 2 },
      jidsByFolder: { 'flow-abc123': ['web:7b1f0c1e-1234-dead-beef'] },
    });

    expect(
      dedup.isRetryDuplicate(
        'flow-abc123',
        'web:7b1f0c1e-1234-dead-beef',
        'hello',
      ),
    ).toBe(false);
    expect(
      dedup.isRetryDuplicate(
        'flow-abc123',
        'web:7b1f0c1e-1234-dead-beef',
        'hello',
      ),
    ).toBe(true);
    expect(getJidsByFolder).toHaveBeenCalledWith('flow-abc123');
  });

  test('admin home still works through the legacy web:<folder> lookup', () => {
    const { dedup, getJidsByFolder } = makeDedup({
      retryCounts: { 'web:main': 1 },
    });

    expect(dedup.isRetryDuplicate('main', 'web:main', 'same')).toBe(false);
    expect(dedup.isRetryDuplicate('main', 'web:main', 'same')).toBe(true);
    expect(getJidsByFolder).not.toHaveBeenCalled();
  });

  test('does not suppress a repeated send when the folder has no active retry', () => {
    const { dedup } = makeDedup({
      jidsByFolder: { 'flow-nonexistent': ['web:idle'] },
    });

    expect(
      dedup.isRetryDuplicate('flow-nonexistent', 'web:idle', 'status'),
    ).toBe(false);
    expect(
      dedup.isRetryDuplicate('flow-nonexistent', 'web:idle', 'status'),
    ).toBe(false);
  });

  test('first attempt with retryCount=0 is never treated as in-retry', () => {
    const { dedup } = makeDedup({
      retryCounts: { 'web:uuid-first-try': 0 },
      jidsByFolder: { 'flow-def456': ['web:uuid-first-try'] },
    });

    expect(
      dedup.isRetryDuplicate('flow-def456', 'web:uuid-first-try', 'first'),
    ).toBe(false);
    expect(
      dedup.isRetryDuplicate('flow-def456', 'web:uuid-first-try', 'first'),
    ).toBe(false);
  });

  test('treats any sibling jid in the same folder as in-retry, including IM jids', () => {
    const { dedup, getRetryCount } = makeDedup({
      retryCounts: {
        'web:sibling-1': 0,
        'feishu:oc_retrying': 3,
      },
      jidsByFolder: {
        'shared-folder': ['web:sibling-1', 'feishu:oc_retrying'],
      },
    });

    expect(
      dedup.isRetryDuplicate('shared-folder', 'feishu:oc_retrying', 'report'),
    ).toBe(false);
    expect(
      dedup.isRetryDuplicate('shared-folder', 'feishu:oc_retrying', 'report'),
    ).toBe(true);
    expect(getRetryCount).toHaveBeenCalledWith('feishu:oc_retrying');
  });
});
