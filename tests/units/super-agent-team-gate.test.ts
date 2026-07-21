import { describe, expect, test } from 'vitest';

import { evaluateBehavioralEvidence } from '../../src/graph-engineering/graph-runner.js';
import type { GraphAssertion } from '../../src/graph-engineering/graph-types.js';

describe('super-agent-team C2: gate behavioral evidence (TC8-TC11)', () => {
  test('TC8 — contains assertion passes when output includes value', () => {
    const assertions: GraphAssertion[] = [{ kind: 'contains', value: '测试通过' }];
    const r = evaluateBehavioralEvidence(assertions, 'all 测试通过 done', null);
    expect(r.pass).toBe(true);
  });

  test('TC8 — contains assertion fails when output missing value', () => {
    const assertions: GraphAssertion[] = [{ kind: 'contains', value: '测试通过' }];
    const r = evaluateBehavioralEvidence(assertions, 'nothing here', null);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('测试通过');
  });

  test('TC8 — not_contains assertion', () => {
    const assertions: GraphAssertion[] = [{ kind: 'not_contains', value: 'I cannot' }];
    expect(evaluateBehavioralEvidence(assertions, 'all good', null).pass).toBe(true);
    expect(evaluateBehavioralEvidence(assertions, 'I cannot do it', null).pass).toBe(false);
  });

  test('TC8 — regex assertion', () => {
    const assertions: GraphAssertion[] = [{ kind: 'regex', value: 'return\\s+\\d+' }];
    expect(evaluateBehavioralEvidence(assertions, 'def f(): return 1', null).pass).toBe(true);
    expect(evaluateBehavioralEvidence(assertions, 'no return here', null).pass).toBe(false);
  });

  test('TC9 — shellCheck exit 0 passes; non-zero fails', () => {
    const ok = evaluateBehavioralEvidence([], '', { exitCode: 0, stdout: 'ok', stderr: '' });
    expect(ok.pass).toBe(true);
    const fail = evaluateBehavioralEvidence([], '', { exitCode: 1, stdout: '', stderr: 'boom' });
    expect(fail.pass).toBe(false);
    expect(fail.detail).toContain('退出码 1');
  });

  test('TC10 — shellCheck failure short-circuits before assertions (no LLM whitewash)', () => {
    const assertions: GraphAssertion[] = [{ kind: 'contains', value: '测试通过' }];
    const r = evaluateBehavioralEvidence(assertions, 'all 测试通过', {
      exitCode: 2,
      stdout: '',
      stderr: 'make: *** failed',
    });
    // shellCheck failed → evidence fails even though assertion would pass
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('shellCheck');
  });

  test('TC11 — no assertions and no shellCheck → passes (LLM-only backward-compat path)', () => {
    const r = evaluateBehavioralEvidence(undefined, 'some output', null);
    expect(r.pass).toBe(true);
  });

  test('multiple assertions all pass → passes; one fails → fails', () => {
    const assertions: GraphAssertion[] = [
      { kind: 'contains', value: 'report' },
      { kind: 'regex', value: '\\d{4}' },
    ];
    expect(evaluateBehavioralEvidence(assertions, 'report 2026', null).pass).toBe(true);
    expect(evaluateBehavioralEvidence(assertions, 'report noyear', null).pass).toBe(false);
  });
});
