import { describe, expect, test } from 'vitest';
import { ReminderEngine, type ReminderConfig, type ReminderEngineDeps } from '../container/agent-runner/src/reminder-engine.js';
import type { ContainerOutput } from '../container/agent-runner/src/types.js';

function makeEngine(cfg: Partial<ReminderConfig> = {}, turnCount = 3) {
  const pushed: string[] = [];
  const emitted: ContainerOutput[] = [];
  const deps: ReminderEngineDeps = {
    emit: (out) => emitted.push(out),
    push: (text) => pushed.push(text),
    getTurnCount: () => turnCount,
  };
  const fullCfg: ReminderConfig = {
    enabled: true,
    intervalSteps: 8,
    goalSnippet: '实现 Reminder 机制并合并到 main',
    ...cfg,
  };
  const engine = new ReminderEngine(fullCfg, deps);
  return { engine, pushed, emitted, deps };
}

describe('ReminderEngine', () => {
  test('TC-09: periodic trigger fires once every intervalSteps tool_results and resets', () => {
    const { engine, pushed, emitted } = makeEngine({ intervalSteps: 8 });
    for (let i = 0; i < 7; i++) engine.onToolResult();
    expect(pushed.length).toBe(0);
    expect(emitted.length).toBe(0);
    // 8th step crosses the interval → inject
    engine.onToolResult();
    expect(pushed.length).toBe(1);
    expect(emitted.length).toBe(1);
    const evt = emitted[0]!.streamEvent!;
    expect(evt.eventType).toBe('reminder_injected');
    expect(evt.reminder?.reason).toBe('periodic');
    expect(evt.reminder?.turnIndex).toBe(3);
    expect(evt.reminder?.stepsSinceLast).toBe(8);
    expect(evt.reminder?.goalSnippet).toContain('Reminder 机制');
    // counter reset → next 7 steps no inject
    for (let i = 0; i < 7; i++) engine.onToolResult();
    expect(pushed.length).toBe(1);
    engine.onToolResult();
    expect(pushed.length).toBe(2);
  });

  test('TC-10: disabled engine never injects', () => {
    const { engine, pushed, emitted } = makeEngine({ enabled: false, intervalSteps: 8 });
    for (let i = 0; i < 50; i++) engine.onToolResult();
    engine.onCompact();
    expect(pushed.length).toBe(0);
    expect(emitted.length).toBe(0);
  });

  test('TC-11: compact event-driven trigger injects with reason=compact and does not reset periodic counter', () => {
    const { engine, pushed, emitted } = makeEngine({ intervalSteps: 8 });
    // accumulate 5 steps (below interval)
    for (let i = 0; i < 5; i++) engine.onToolResult();
    expect(pushed.length).toBe(0);
    engine.onCompact();
    expect(pushed.length).toBe(1);
    const evt = emitted[0]!.streamEvent!;
    expect(evt.eventType).toBe('reminder_injected');
    expect(evt.reminder?.reason).toBe('compact');
    // compact should not reset periodic counter — 2 more steps (total 7) still below 8
    for (let i = 0; i < 2; i++) engine.onToolResult();
    expect(pushed.length).toBe(1);
    // one more step (total 8) crosses the interval → periodic inject
    engine.onToolResult();
    expect(pushed.length).toBe(2);
    expect(emitted[1]!.streamEvent!.reminder?.reason).toBe('periodic');
  });

  test('TC-12: reminder_injected event carries all five reminder fields', () => {
    const { engine, emitted } = makeEngine({ intervalSteps: 1 });
    engine.onToolResult();
    const r = emitted[0]!.streamEvent!.reminder!;
    expect(r).toBeDefined();
    expect(typeof r.reason).toBe('string');
    expect(typeof r.turnIndex).toBe('number');
    expect(typeof r.stepsSinceLast).toBe('number');
    expect(typeof r.goalSnippet).toBe('string');
    expect(typeof r.summary).toBe('string');
    expect(r.goalSnippet.length).toBeLessThanOrEqual(500);
    expect(r.summary.length).toBeLessThanOrEqual(200);
  });

  test('inject failure path emits a reminder_injected error summary without throwing', () => {
    const emitted: ContainerOutput[] = [];
    const engine = new ReminderEngine(
      { enabled: true, intervalSteps: 1, goalSnippet: 'g' },
      {
        emit: (out) => emitted.push(out),
        push: () => { throw new Error('boom'); },
        getTurnCount: () => 1,
      },
    );
    expect(() => engine.onToolResult()).not.toThrow();
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.streamEvent!.reminder?.summary).toContain('inject failed');
  });
});
