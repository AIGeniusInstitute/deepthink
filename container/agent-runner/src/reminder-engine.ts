/**
 * ReminderEngine — re-injects key context (task goal + nudge) into the running
 * SDK query before the LLM "forgets" or drifts in long tasks.
 *
 * Injection vehicle: `MessageStream.push()` — the same channel used by IPC
 * follow-ups and the time-prefix. Pushing a user message makes the SDK open a
 * new turn and re-read system prompt + history + this reminder, which is the
 * only way to refresh context mid-query (system prompt is fixed per query).
 *
 * Triggers:
 *  - periodic: every `intervalSteps` tool_result events (a completed tool call
 *    = one "step"; fires mid tool-loop, not at the final result stop point).
 *  - compact:  fired from the SDK PreCompact hook right after history compaction,
 *    when early context was summarized and the goal is most at risk of loss.
 *
 * Emitted `reminder_injected` stream events flow through the existing
 * broadcastStreamEvent path to the chat UI's Reminder panel.
 *
 * See docs/tech_solution/reminder-mechanism/TECH_SOLUTION.md.
 */

import type { ContainerOutput } from './types.js';

export interface ReminderConfig {
  /** Master switch. When false the engine never injects. Default false (host
   *  must explicitly enable per user preference + global config). */
  enabled: boolean;
  /** Tool steps between periodic injections. Default 8. */
  intervalSteps: number;
  /** Truncated original task objective (first ~500 chars of the prompt),
   *  re-stated in every reminder to anchor the goal. */
  goalSnippet: string;
}

export interface ReminderEngineDeps {
  /** Emit a ContainerOutput to the host (same emit used for stream events). */
  emit: (output: ContainerOutput) => void;
  /** Push a user message into the running SDK query (MessageStream.push). */
  push: (text: string) => void;
  /** Current SDK turn count (resultCount) at injection time, for the log. */
  getTurnCount: () => number;
}

/** Rotating nudges so the model doesn't habitually ignore a fixed phrase. */
const NUDGES: ReadonlyArray<string> = [
  '请核对当前进度是否偏离上述目标；若已完成可输出最终结果，否则继续推进。',
  '提醒：保持对原始约束的遵守，不要遗漏输出格式要求与字段完整性。',
  '若陷入循环或重复调用同一工具，请改变策略或直接输出当前结论。',
  '再次确认：当前行动是否直接服务于上述任务目标？避免在琐碎细节上打转。',
];

const GOAL_SNIPPET_MAX = 500;
const SUMMARY_MAX = 200;
const REMINDER_LOG_MAX = 50;

export class ReminderEngine {
  private stepsSinceLast = 0;
  private injections = 0;

  constructor(
    private readonly cfg: ReminderConfig,
    private readonly deps: ReminderEngineDeps,
  ) {}

  /** Called on each tool_result stream event. Counts a tool step and triggers
   *  a periodic injection when the interval is reached. */
  onToolResult(): void {
    if (!this.cfg.enabled || this.cfg.intervalSteps <= 0) return;
    this.stepsSinceLast++;
    if (this.stepsSinceLast >= this.cfg.intervalSteps) {
      this.inject('periodic');
    }
  }

  /** Called from the PreCompact hook after the SDK compacts history. */
  onCompact(): void {
    if (!this.cfg.enabled) return;
    // Compact does not reset the periodic counter — keep cadence stable.
    this.inject('compact');
  }

  /** Build the reminder text, push it into the query, and emit a
   *  `reminder_injected` stream event for the UI log. */
  private inject(reason: 'periodic' | 'compact'): void {
    const turnIndex = this.deps.getTurnCount();
    const stepsSinceLast = this.stepsSinceLast;
    const nudge = NUDGES[this.injections % NUDGES.length]!;
    const goalSnippet = this.cfg.goalSnippet.slice(0, GOAL_SNIPPET_MAX);
    const text =
      `*** Reminder · 已执行 ${this.stepsSinceLast} 步（turn ${turnIndex}）***\n` +
      `任务目标：${goalSnippet}\n${nudge}`;

    // stream.push after stream.end() is a documented no-op (returns a rejection
    // reason) — it will not throw, so a reminder scheduled right as the query
    // ends is safely dropped.
    try {
      this.deps.push(text);
    } catch (err) {
      // Never let the reminder path crash the agent loop.
      this.deps.emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'reminder_injected',
          reminder: {
            reason,
            turnIndex,
            stepsSinceLast,
            goalSnippet,
            summary: `inject failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, SUMMARY_MAX),
          },
        },
      });
      return;
    }

    if (reason === 'periodic') {
      this.stepsSinceLast = 0;
    }
    this.injections++;

    this.deps.emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'reminder_injected',
        reminder: {
          reason,
          turnIndex,
          stepsSinceLast,
          goalSnippet,
          summary: text.slice(0, SUMMARY_MAX),
        },
      },
    });
  }
}

/** Cap a reminder log array to REMINDER_LOG_MAX entries (oldest first). */
export function pushReminderLog(
  prev: ReadonlyArray<ContainerOutput['streamEvent']> | undefined,
  event: ContainerOutput['streamEvent'],
): ContainerOutput['streamEvent'][] {
  if (!event?.reminder) return prev ? [...prev] : [];
  const next = prev ? [...prev, event] : [event];
  return next.length > REMINDER_LOG_MAX ? next.slice(next.length - REMINDER_LOG_MAX) : next;
}
