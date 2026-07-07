import { describe, expect, test } from 'vitest';

import { extractLastTaskId } from '../src/task-routing.js';

// Minimal shape that matches the ReadonlyArray<{ task_id?: string | null }>
// signature exported from src/index.ts. The production caller passes full
// NewMessage rows, but the helper only reads `task_id`.
type Row = { task_id?: string | null };

describe('extractLastTaskId', () => {
  test('returns undefined for empty array', () => {
    expect(extractLastTaskId([])).toBeUndefined();
  });

  test('returns undefined when no row carries task_id', () => {
    const rows: Row[] = [
      { task_id: null },
      { task_id: undefined },
      {},
    ];
    expect(extractLastTaskId(rows)).toBeUndefined();
  });

  test('returns the last non-null task_id (reverse scan semantics)', () => {
    // Mirrors the description's canonical fixture:
    // [{task_id: null}, {task_id: 't2'}, {task_id: null}] → 't2'
    const rows: Row[] = [
      { task_id: null },
      { task_id: 't2' },
      { task_id: null },
    ];
    expect(extractLastTaskId(rows)).toBe('t2');
  });

  test('later task prompt wins when multiple are present', () => {
    // If an agent turn contains multiple task prompts, the most recent one
    // determines attribution.
    const rows: Row[] = [
      { task_id: 't-early' },
      { task_id: null },
      { task_id: 't-late' },
      { task_id: null },
    ];
    expect(extractLastTaskId(rows)).toBe('t-late');
  });

  test('single row with task_id returns that id', () => {
    expect(extractLastTaskId([{ task_id: 'only-one' }])).toBe('only-one');
  });

  test('empty-string task_id is treated as absent (falsy)', () => {
    // The impl uses truthy check (`if (candidate)`), so '' should not match.
    const rows: Row[] = [{ task_id: '' }, { task_id: null }];
    expect(extractLastTaskId(rows)).toBeUndefined();
  });

  test('mixed-batch "later wins": user msg + trailing task prompt → task id', () => {
    // Load-bearing contract (locked per Codex remediation C2):
    // when getMessagesSince returns a batch that mixes regular user messages
    // and a scheduled_task_prompt row, the entire batch is collapsed into
    // one agent turn and attributed to the most recent task_id in the batch.
    // We accept the conservative misattribution (user's send may route
    // through the task's IM broadcast path) to preserve task attribution,
    // which is otherwise unrecoverable once the prompts are merged.
    const rows: Row[] = [
      { task_id: null }, // normal user message
      { task_id: 't_later' }, // task prompt arriving in the same batch
    ];
    expect(extractLastTaskId(rows)).toBe('t_later');
  });

  test('mixed-batch "later wins": task prompt followed by user msg → still the task id', () => {
    // Complements the previous case: when the task prompt comes first and is
    // followed by user messages, the scan still returns the most recent
    // non-null task_id because user rows have task_id=null. Collapsed batch
    // is still attributed to the task. Same rationale: we cannot split the
    // batch back apart once agent-runner receives it as a single prompt.
    const rows: Row[] = [
      { task_id: 't_early' },
      { task_id: null },
      { task_id: null },
    ];
    expect(extractLastTaskId(rows)).toBe('t_early');
  });
});
