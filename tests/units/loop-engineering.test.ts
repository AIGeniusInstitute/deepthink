import { describe, expect, test } from 'vitest';

import {
  parseInterval,
  isValidCron,
  parseMaxTurns,
  parseWorkflow,
} from '../../src/loop-commands.js';
import {
  clampMaxTurns,
  parseReviewResult,
  parseSuggestedExt,
} from '../../src/loop-orchestrator.js';

describe('loop-commands: parseInterval', () => {
  test('parses seconds', () => {
    expect(parseInterval('30s')).toBe(30_000);
  });
  test('parses minutes', () => {
    expect(parseInterval('5m')).toBe(5 * 60 * 1000);
  });
  test('parses hours', () => {
    expect(parseInterval('2h')).toBe(2 * 60 * 60 * 1000);
  });
  test('parses days', () => {
    expect(parseInterval('1d')).toBe(24 * 60 * 60 * 1000);
  });
  test('returns null for invalid format', () => {
    expect(parseInterval('5')).toBeNull();
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('5x')).toBeNull();
  });
  test('returns null for empty string', () => {
    expect(parseInterval('')).toBeNull();
  });
});

describe('loop-commands: isValidCron', () => {
  test('valid 5-field cron', () => {
    expect(isValidCron('0 9 * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 0 1 1 *')).toBe(true);
  });
  test('invalid cron with wrong field count', () => {
    expect(isValidCron('0 9 * *')).toBe(false);
    expect(isValidCron('0 9 * * * *')).toBe(false);
    expect(isValidCron('')).toBe(false);
  });
});

describe('loop-orchestrator: clampMaxTurns', () => {
  test('clamps to [1, 10]', () => {
    expect(clampMaxTurns(0)).toBe(1);
    expect(clampMaxTurns(1)).toBe(1);
    expect(clampMaxTurns(5)).toBe(5);
    expect(clampMaxTurns(10)).toBe(10);
    expect(clampMaxTurns(15)).toBe(10);
    expect(clampMaxTurns(100)).toBe(10);
  });
  test('handles negative', () => {
    expect(clampMaxTurns(-3)).toBe(1);
  });
});

describe('loop-orchestrator: parseReviewResult', () => {
  test('parses valid JSON', () => {
    const raw = '{"result":"pass","reason":"目标已达成","suggestion":""}';
    const r = parseReviewResult(raw);
    expect(r.result).toBe('pass');
    expect(r.reason).toBe('目标已达成');
  });
  test('parses JSON with markdown fences', () => {
    const raw = '```json\n{"result":"fail","reason":"未修复","suggestion":"改 README"}\n```';
    const r = parseReviewResult(raw);
    expect(r.result).toBe('fail');
    expect(r.reason).toBe('未修复');
    expect(r.suggestion).toBe('改 README');
  });
  test('parses needs_improvement', () => {
    const raw = '{"result":"needs_improvement","reason":"部分完成","suggestion":"继续"}';
    const r = parseReviewResult(raw);
    expect(r.result).toBe('needs_improvement');
  });
  test('returns needs_improvement for null input', () => {
    const r = parseReviewResult(null);
    expect(r.result).toBe('needs_improvement');
    expect(r.reason).toBe('评审无响应');
  });
  test('returns needs_improvement for invalid JSON', () => {
    const r = parseReviewResult('not json at all');
    expect(r.result).toBe('needs_improvement');
  });
  test('returns needs_improvement for unknown result value', () => {
    const r = parseReviewResult('{"result":"maybe","reason":"x"}');
    expect(r.result).toBe('needs_improvement');
  });
  test('truncates long reason', () => {
    const longReason = 'x'.repeat(3000);
    const r = parseReviewResult(`{"result":"fail","reason":"${longReason}"}`);
    expect(r.reason.length).toBeLessThanOrEqual(2000);
  });
});

describe('loop-commands: parseMaxTurns', () => {
  test('parses explicit max_turns=N', () => {
    const r = parseMaxTurns('some goal max_turns=7');
    expect(r.maxTurns).toBe(7);
    expect(r.rest).toBe('some goal');
  });
  test('defaults to 5 when absent', () => {
    const r = parseMaxTurns('some goal');
    expect(r.maxTurns).toBe(5);
    expect(r.rest).toBe('some goal');
  });
  test('clamps 0 to 1', () => {
    const r = parseMaxTurns('goal max_turns=0');
    expect(r.maxTurns).toBe(1);
  });
  test('clamps over-limit to 10', () => {
    const r = parseMaxTurns('goal max_turns=99');
    expect(r.maxTurns).toBe(10);
  });
});

describe('loop-commands: parseWorkflow', () => {
  test('parses parallel', () => {
    const r = parseWorkflow('goal workflow=parallel');
    expect(r.mode).toBe('parallel');
    expect(r.rest).toBe('goal');
  });
  test('parses sequential', () => {
    const r = parseWorkflow('goal workflow=sequential');
    expect(r.mode).toBe('sequential');
    expect(r.rest).toBe('goal');
  });
  test('defaults to sequential', () => {
    const r = parseWorkflow('goal');
    expect(r.mode).toBe('sequential');
    expect(r.rest).toBe('goal');
  });
});

describe('loop-orchestrator: parseSuggestedExt', () => {
  test('parses next_turns=3', () => {
    expect(parseSuggestedExt('next_turns=3')).toBe(3);
  });
  test('parses numeric prefix', () => {
    expect(parseSuggestedExt('2 more turns')).toBe(2);
  });
  test('returns 0 for empty', () => {
    expect(parseSuggestedExt('')).toBe(0);
  });
  test('returns 0 for invalid', () => {
    expect(parseSuggestedExt('no number here')).toBe(0);
  });
});
