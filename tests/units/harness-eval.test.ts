import { describe, expect, test } from 'vitest';

import {
  parseCaseYaml,
  scoreAssertion,
  scoreCase,
  type EvalCase,
} from '../../src/harness-eval.js';

describe('harness-eval: parseCaseYaml', () => {
  test('parses a well-formed case', () => {
    const raw = `
case_id: code-gen
name: Code Generation
prompt: |
  write a function
assertions:
  - { kind: contains, value: "def add" }
  - { kind: regex, value: "return\\\\s+a" }
  - { kind: not_contains, value: "I cannot" }
rubric:
  weights: { default: 1.0 }
  pass_threshold: 1.0
`;
    const c = parseCaseYaml(raw);
    expect(c).not.toBeNull();
    expect(c!.case_id).toBe('code-gen');
    expect(c!.name).toBe('Code Generation');
    expect(c!.assertions).toHaveLength(3);
    expect(c!.assertions[0]).toEqual({ kind: 'contains', value: 'def add' });
    expect(c!.rubric.pass_threshold).toBe(1.0);
  });

  test('returns null for missing required fields', () => {
    expect(parseCaseYaml('')).toBeNull();
    expect(parseCaseYaml('case_id: x\nassertions: []')).toBeNull();
    expect(parseCaseYaml('case_id: x\nprompt: hi\nassertions: "not-array"')).toBeNull();
  });

  test('filters out assertions with unknown kind', () => {
    const raw = `
case_id: t
prompt: hi
assertions:
  - { kind: contains, value: "ok" }
  - { kind: bogus, value: "x" }
rubric:
  pass_threshold: 1.0
`;
    const c = parseCaseYaml(raw);
    expect(c!.assertions).toHaveLength(1);
    expect(c!.assertions[0].kind).toBe('contains');
  });

  test('applies default rubric when missing', () => {
    const raw = `
case_id: t
prompt: hi
assertions:
  - { kind: contains, value: "ok" }
`;
    const c = parseCaseYaml(raw);
    expect(c!.rubric.pass_threshold).toBe(1.0);
    expect(c!.rubric.weights).toEqual({ default: 1.0 });
  });
});

describe('harness-eval: scoreAssertion', () => {
  test('contains matches', () => {
    expect(scoreAssertion({ kind: 'contains', value: 'foo' }, 'hello foo bar', false).pass).toBe(true);
    expect(scoreAssertion({ kind: 'contains', value: 'foo' }, 'hello bar', false).pass).toBe(false);
  });

  test('not_contains matches', () => {
    expect(scoreAssertion({ kind: 'not_contains', value: 'err' }, 'ok', false).pass).toBe(true);
    expect(scoreAssertion({ kind: 'not_contains', value: 'err' }, 'error here', false).pass).toBe(false);
  });

  test('regex matches', () => {
    expect(scoreAssertion({ kind: 'regex', value: 'def\\s+\\w+' }, 'def add(a, b)', false).pass).toBe(true);
    expect(scoreAssertion({ kind: 'regex', value: 'def\\s+\\w+' }, 'function add()', false).pass).toBe(false);
  });

  test('regex with invalid pattern fails gracefully', () => {
    expect(scoreAssertion({ kind: 'regex', value: '(' }, 'anything', false).pass).toBe(false);
  });

  test('no_error matches', () => {
    expect(scoreAssertion({ kind: 'no_error', value: '' }, 'response', false).pass).toBe(true);
    expect(scoreAssertion({ kind: 'no_error', value: '' }, 'response', true).pass).toBe(false);
  });
});

describe('harness-eval: scoreCase', () => {
  const evalCase: EvalCase = {
    case_id: 't',
    name: 'T',
    prompt: 'p',
    assertions: [
      { kind: 'contains', value: 'foo' },
      { kind: 'contains', value: 'bar' },
    ],
    rubric: { pass_threshold: 1.0 },
  };

  test('all pass → pass=true, score=1.0', () => {
    const r = scoreCase(evalCase, 'foo bar', false);
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1.0);
    expect(r.details).toHaveLength(2);
  });

  test('one fail → pass=false, score=0.5', () => {
    const r = scoreCase(evalCase, 'foo only', false);
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0.5);
  });

  test('threshold < 1.0 allows partial pass', () => {
    const c: EvalCase = { ...evalCase, rubric: { pass_threshold: 0.5 } };
    const r = scoreCase(c, 'foo only', false);
    expect(r.pass).toBe(true);
    expect(r.score).toBe(0.5);
  });

  test('zero assertions → score=0, pass=false', () => {
    const c: EvalCase = { ...evalCase, assertions: [] };
    const r = scoreCase(c, 'anything', false);
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });
});
