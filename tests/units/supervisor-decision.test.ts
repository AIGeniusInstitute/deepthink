import { describe, expect, test } from 'vitest';

import { parseDecision } from '../../src/supervisor.js';

describe('supervisor: parseDecision', () => {
  test('parses clarify', () => {
    const d = parseDecision('{"action":"clarify","question":"哪个项目?"}');
    expect(d?.action).toBe('clarify');
    expect(d?.question).toBe('哪个项目?');
  });

  test('parses delegate', () => {
    const d = parseDecision('{"action":"delegate","instruction":"跑测试"}');
    expect(d?.action).toBe('delegate');
    expect(d?.instruction).toBe('跑测试');
  });

  test('parses auto', () => {
    const d = parseDecision('{"action":"auto","instruction":"优化后指令"}');
    expect(d?.action).toBe('auto');
    expect(d?.instruction).toBe('优化后指令');
  });

  test('strips markdown fences', () => {
    const d = parseDecision('```json\n{"action":"delegate","instruction":"x"}\n```');
    expect(d?.action).toBe('delegate');
    expect(d?.instruction).toBe('x');
  });

  test('returns null for invalid JSON', () => {
    expect(parseDecision('not json')).toBeNull();
    expect(parseDecision('')).toBeNull();
  });

  test('returns null for unknown action', () => {
    expect(parseDecision('{"action":"maybe"}')).toBeNull();
    expect(parseDecision('{"action":""}')).toBeNull();
  });

  test('returns null when braces missing', () => {
    expect(parseDecision('no braces here')).toBeNull();
  });

  test('truncates long instruction', () => {
    const long = 'x'.repeat(5000);
    const d = parseDecision(`{"action":"delegate","instruction":"${long}"}`);
    expect(d?.instruction?.length).toBeLessThanOrEqual(4000);
  });

  test('truncates long question', () => {
    const long = 'x'.repeat(3000);
    const d = parseDecision(`{"action":"clarify","question":"${long}"}`);
    expect(d?.question?.length).toBeLessThanOrEqual(2000);
  });
});
