/**
 * Reminder mechanism host-side config builder.
 *
 * Resolves the per-run ReminderConfig that the host injects into
 * ContainerInput, which agent-runner's ReminderEngine reads to decide
 * whether/when to re-inject the task goal.
 *
 * - enabled:  per-user `users.reminder_enabled` (default true) — the user
 *             toggle is the authoritative on/off (PRD F5). Falls back to the
 *             global default when the user can't be resolved.
 * - intervalSteps: global `config/reminder.json` (default 8) — admin-tunable
 *             cadence, not per-user (PRD keeps only the on/off toggle
 *             user-facing, per Simplicity First).
 * - goalSnippet: truncated original prompt (≤500 chars), re-stated in every
 *             reminder to anchor the objective.
 */

import { getUserById } from './db.js';
import { getReminderConfig } from './runtime-config.js';

export interface ReminderRunConfig {
  enabled: boolean;
  intervalSteps: number;
  goalSnippet: string;
}

const GOAL_SNIPPET_MAX = 500;

export function buildReminderConfig(
  ownerUserId: string | undefined,
  prompt: string,
): ReminderRunConfig {
  const global = getReminderConfig();
  let enabled = global.enabled;
  if (ownerUserId) {
    const owner = getUserById(ownerUserId);
    if (owner) {
      enabled = !!owner.reminder_enabled;
    }
  }
  return {
    enabled,
    intervalSteps: global.intervalSteps,
    goalSnippet: (prompt ?? '').slice(0, GOAL_SNIPPET_MAX),
  };
}
