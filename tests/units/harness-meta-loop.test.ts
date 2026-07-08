import { describe, expect, test } from 'vitest';

import { judgeVerdict, type Verdict } from '../../src/harness-meta-loop.js';
import type { EvalAggregate } from '../../src/harness-eval.js';

function agg(passed: number, total: number, errored = 0, failCaseIds: string[] = []): EvalAggregate {
  const results = [] as EvalAggregate['results'];
  for (let i = 0; i < passed; i++) {
    results.push({ case_id: `pass_${i}`, name: `p${i}`, pass: true, score: 1.0, trace_chat_jid: 'x', trace_node_id: i, evidence_summary: '' });
  }
  for (let i = 0; i < total - passed - errored; i++) {
    results.push({ case_id: failCaseIds[i] ?? `fail_${i}`, name: `f${i}`, pass: false, score: 0, trace_chat_jid: 'x', trace_node_id: 0, evidence_summary: '' });
  }
  for (let i = 0; i < errored; i++) {
    results.push({ case_id: `err_${i}`, name: `e${i}`, pass: false, score: 0, trace_chat_jid: 'x', trace_node_id: 0, evidence_summary: '', error: 'boom' });
  }
  return {
    total,
    passed,
    failed: total - passed - errored,
    errored,
    score: total === 0 ? 0 : passed / total,
    results,
  };
}

describe('harness-meta-loop: judgeVerdict', () => {
  test('improved: strictly higher pass-rate, no new failures', () => {
    const base = agg(2, 4, 0, ['c1', 'c2']);
    const prop = agg(3, 4, 0, ['c2']);
    expect(judgeVerdict(base, prop)).toBe<Verdict>('improved');
  });

  test('regressed: proposed fails a case that baseline passed', () => {
    const base = agg(3, 4, 0, ['c4']);
    const prop = agg(2, 4, 0, ['c1', 'c4']); // c1 newly failing
    expect(judgeVerdict(base, prop)).toBe<Verdict>('regressed');
  });

  test('regressed takes priority over improved (pass-rate up but new fail)', () => {
    const base = agg(1, 4, 0, ['c2', 'c3', 'c4']);
    const prop = agg(2, 4, 0, ['c1', 'c3', 'c4']); // c1 newly failing, c2 newly passing
    expect(judgeVerdict(base, prop)).toBe<Verdict>('regressed');
  });

  test('neutral: same pass-rate, same fail set', () => {
    const base = agg(2, 4, 0, ['c3', 'c4']);
    const prop = agg(2, 4, 0, ['c3', 'c4']);
    expect(judgeVerdict(base, prop)).toBe<Verdict>('neutral');
  });

  test('inconclusive: baseline has zero cases', () => {
    expect(judgeVerdict(agg(0, 0), agg(3, 4))).toBe<Verdict>('inconclusive');
  });

  test('inconclusive: proposed has zero cases', () => {
    expect(judgeVerdict(agg(3, 4), agg(0, 0))).toBe<Verdict>('inconclusive');
  });

  test('inconclusive: either side errored', () => {
    expect(judgeVerdict(agg(2, 4, 1), agg(3, 4))).toBe<Verdict>('inconclusive');
    expect(judgeVerdict(agg(3, 4), agg(2, 4, 1))).toBe<Verdict>('inconclusive');
  });

  test('improved even when fail set changes but no new fail ids', () => {
    const base = agg(1, 3, 0, ['c2', 'c3']);
    const prop = agg(2, 3, 0, ['c3']); // c2 now passes, no new fail
    expect(judgeVerdict(base, prop)).toBe<Verdict>('improved');
  });

  test('neutral when pass-rate equal but fail set differs but no new fails', () => {
    // baseline fails c1,c2 ; proposed fails c1,c3 — wait, c3 is new fail → regressed
    const base = agg(1, 3, 0, ['c1', 'c2']);
    const prop = agg(1, 3, 0, ['c1', 'c3']);
    expect(judgeVerdict(base, prop)).toBe<Verdict>('regressed');
  });
});
