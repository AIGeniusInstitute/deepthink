import { describe, expect, test } from 'vitest';
import { parseDecision } from '../../src/supervisor.js';

/**
 * P1: Supervisor auto-routing delegate_team. parseDecision is the pure half
 * of runSupervisorPreDispatch (no LLM call). Verifies the new action is
 * accepted + instruction (goalText for Team Builder) is carried through.
 */
describe('super-agent-team P1: supervisor delegate_team routing (TC20-TC21)', () => {
  test('TC20 — delegate_team action parses + instruction carried through', () => {
    const raw = JSON.stringify({
      action: 'delegate_team',
      instruction: '调研并实现一个支持多租户的计费仪表盘',
    });
    const decision = parseDecision(raw);
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe('delegate_team');
    expect(decision!.instruction).toContain('计费仪表盘');
  });

  test('TC20b — delegate_team tolerates markdown fences', () => {
    const raw = '```json\n{"action":"delegate_team","instruction":"build it"}\n```';
    const decision = parseDecision(raw);
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe('delegate_team');
    expect(decision!.instruction).toBe('build it');
  });

  test('TC21 — unknown action still rejected', () => {
    const decision = parseDecision('{"action":"escalate","instruction":"x"}');
    expect(decision).toBeNull();
  });

  test('TC21b — clarify/auto/delegate still parse (no regression)', () => {
    expect(parseDecision('{"action":"clarify","question":"q?"}')?.action).toBe('clarify');
    expect(parseDecision('{"action":"auto","instruction":"x"}')?.action).toBe('auto');
    expect(parseDecision('{"action":"delegate","instruction":"x"}')?.action).toBe('delegate');
  });
});
