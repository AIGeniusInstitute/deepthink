/**
 * Loop Engineering slash command handlers.
 *
 * Commands:
 *   /goal <text> [max_turns=N]      — start a goal-based loop
 *   /loop <interval> <text>         — start a time-based loop (interval)
 *   /schedule <cron> <text>         — start a time-based loop (cron)
 *   /proactive <cron> <goal> [workflow=parallel] — start a proactive loop
 *   /cancel <loop_id>               — cancel a running loop
 *   /loops                          — list active loops
 */

import crypto from 'node:crypto';
import {
  createLoopRun,
  createTask,
  getLoopRun,
  getUserHomeGroup,
  listLoopRuns,
} from './db.js';
import { logger } from './logger.js';
import {
  cancelLoopRun,
  clampMaxTurns,
  createLoopRunRecord,
  executeGoalLoop,
  executeAdaptiveLoop,
  executeSkillEvolutionLoop,
  generateLoopRunId,
  type LoopDeps,
  type LoopRunContext,
} from './loop-orchestrator.js';

// ─── Types ──────────────────────────────────────────────────────

export interface LoopCommandDeps {
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
  loopDeps: LoopDeps;
}

export interface CommandParseResult {
  ok: boolean;
  error?: string;
  /** Quickly return a text response to the user. */
  reply?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Parse "max_turns=N" from the trailing args of /goal. */
export function parseMaxTurns(args: string): { maxTurns: number; rest: string } {
  const match = args.match(/\s+max_turns=(\d+)\s*$/);
  if (match) {
    return {
      maxTurns: clampMaxTurns(parseInt(match[1], 10)),
      rest: args.slice(0, match.index).trim(),
    };
  }
  return { maxTurns: clampMaxTurns(5), rest: args.trim() };
}

/** Parse an interval string like "5m", "30s", "1h" into milliseconds. */
export function parseInterval(str: string): number | null {
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

/** Validate a cron expression has 5 fields. */
export function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5;
}

/** Parse workflow mode from /proactive args. */
export function parseWorkflow(args: string): { mode: 'parallel' | 'sequential'; rest: string } {
  const match = args.match(/\s+workflow=(parallel|sequential)\s*$/);
  if (match) {
    return {
      mode: match[1] as 'parallel' | 'sequential',
      rest: args.slice(0, match.index).trim(),
    };
  }
  return { mode: 'sequential', rest: args.trim() };
}

// ─── Command Handlers ───────────────────────────────────────────

/** /goal <text> [max_turns=N] */
export async function handleGoalCommand(
  args: string,
  deps: LoopCommandDeps,
): Promise<string> {
  if (!args.trim()) {
    return '用法：/goal <目标描述> [max_turns=N]\n示例：/goal 修复 README 错字 max_turns=5';
  }
  const { maxTurns, rest: goalText } = parseMaxTurns(args);
  if (!goalText) {
    return '❌ 目标描述不能为空';
  }

  const loopRunId = generateLoopRunId();
  const ctx: LoopRunContext = {
    loopRunId,
    ownerUserId: deps.ownerUserId,
    groupFolder: deps.groupFolder,
    chatJid: deps.chatJid,
    kind: 'goal',
    goalText,
    maxTurns,
    rootPrompt: args,
  };
  createLoopRunRecord(ctx);

  // Kick off the loop in the background — don't block the command response
  executeGoalLoop(ctx, deps.loopDeps).catch((err) => {
    logger.error({ err, loopRunId }, 'Goal loop failed in background');
  });

  return `🎯 已启动目标循环\n\n循环 ID: ${loopRunId}\n目标: ${goalText}\n最大轮次: ${maxTurns}\n\n用 /cancel ${loopRunId} 取消\n用 /loops 查看活跃循环`;
}

/** /adaptive <goal> [max_turns=N] — 自适应循环，max_turns 动态调整 */
export async function handleAdaptiveCommand(
  args: string,
  deps: LoopCommandDeps,
): Promise<string> {
  if (!args.trim()) {
    return '用法：/adaptive <目标描述> [max_turns=N]\n示例：/adaptive 探索一个排序算法 max_turns=6';
  }
  const { maxTurns, rest: goalText } = parseMaxTurns(args);
  if (!goalText) {
    return '❌ 目标描述不能为空';
  }

  const loopRunId = generateLoopRunId();
  const ctx: LoopRunContext = {
    loopRunId,
    ownerUserId: deps.ownerUserId,
    groupFolder: deps.groupFolder,
    chatJid: deps.chatJid,
    kind: 'adaptive',
    goalText,
    maxTurns,
    rootPrompt: args,
  };
  createLoopRunRecord(ctx);

  executeAdaptiveLoop(ctx, deps.loopDeps).catch((err) => {
    logger.error({ err, loopRunId }, 'Adaptive loop failed in background');
  });

  return `🧬 已启动自适应循环\n\n循环 ID: ${loopRunId}\n目标: ${goalText}\n初始轮次: ${maxTurns}（可动态扩展，上限 10）\n\n用 /cancel ${loopRunId} 取消\n用 /loops 查看活跃循环`;
}

/** /skill_evolution <skill_path> "<test_cmd>" [max_turns=N] — 技能自进化循环 */
export async function handleSkillEvolutionCommand(
  args: string,
  deps: LoopCommandDeps,
): Promise<string> {
  const trimmed = args.trim();
  if (!trimmed) {
    return '用法：/skill_evolution <skill 路径> "<测试命令>" [max_turns=N]\n示例：/skill_evolution tests/skills/demo.test.js "node tests/skills/demo.test.js" max_turns=5';
  }
  // Parse: <skill_path> "<test_cmd>" [max_turns=N]
  const quotedMatch = trimmed.match(/^(\S+)\s+"([^"]+)"(.*)$/);
  if (!quotedMatch) {
    return '❌ 参数格式错误。需要：<skill 路径> "<测试命令>" [max_turns=N]';
  }
  const skillPath = quotedMatch[1];
  const testCmd = quotedMatch[2];
  const tail = quotedMatch[3] ?? '';
  const { maxTurns } = parseMaxTurns(`max_turns=5 ${tail}`.trim());
  const maxTurnsFinal = tail.includes('max_turns=') ? maxTurns : 5;

  const loopRunId = generateLoopRunId();
  const ctx: LoopRunContext = {
    loopRunId,
    ownerUserId: deps.ownerUserId,
    groupFolder: deps.groupFolder,
    chatJid: deps.chatJid,
    kind: 'skill_evolution',
    goalText: skillPath,
    successCriteria: testCmd,
    maxTurns: maxTurnsFinal,
    rootPrompt: args,
  };
  createLoopRunRecord(ctx);

  executeSkillEvolutionLoop(ctx, deps.loopDeps).catch((err) => {
    logger.error({ err, loopRunId }, 'Skill evolution loop failed in background');
  });

  return `🧪 已启动技能自进化循环\n\n循环 ID: ${loopRunId}\nSkill: ${skillPath}\n测试: ${testCmd}\n最大轮次: ${maxTurnsFinal}\n\n用 /cancel ${loopRunId} 取消\n用 /loops 查看活跃循环`;
}

/** /loop <interval> <text> */
export async function handleLoopCommand(
  args: string,
  deps: LoopCommandDeps,
): Promise<string> {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    return '用法：/loop <间隔> <任务描述>\n示例：/loop 5m 检查 CI 失败并修复';
  }
  const intervalStr = parts[0];
  const taskText = parts.slice(1).join(' ');
  const intervalMs = parseInterval(intervalStr);
  if (intervalMs === null) {
    return `❌ 无效的间隔格式: ${intervalStr}\n支持: 30s / 5m / 1h / 2h`;
  }
  if (intervalMs < 60_000) {
    return '❌ 间隔不能小于 1 分钟';
  }

  const taskId = `loop_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  createTask({
    id: taskId,
    group_folder: deps.groupFolder,
    chat_jid: deps.chatJid,
    prompt: taskText,
    schedule_type: 'interval',
    schedule_value: String(intervalMs),
    context_mode: 'group',
    execution_type: 'agent',
    script_command: null,
    next_run: new Date(Date.now() + intervalMs).toISOString(),
    status: 'active',
    created_at: now,
    created_by: deps.ownerUserId,
    loop_kind: 'loop',
    loop_run_id: null,
  });

  return `🔄 已启动时间循环\n\n任务 ID: ${taskId}\n间隔: ${intervalStr} (${intervalMs}ms)\n任务: ${taskText}\n\n用 /cancel ${taskId} 取消`;
}

/** /schedule <cron> <text> */
export async function handleScheduleCommand(
  args: string,
  deps: LoopCommandDeps,
): Promise<string> {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    return '用法：/schedule <cron 表达式> <任务描述>\n示例：/schedule 0 9 * * * 每日早报';
  }
  const cron = parts[0];
  const taskText = parts.slice(1).join(' ');
  if (!isValidCron(cron)) {
    return `❌ 无效的 cron 表达式: ${cron}\n需要 5 字段（分 时 日 月 周）`;
  }

  const taskId = `sched_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  // Compute next_run from cron — let task-scheduler compute it on next poll
  createTask({
    id: taskId,
    group_folder: deps.groupFolder,
    chat_jid: deps.chatJid,
    prompt: taskText,
    schedule_type: 'cron',
    schedule_value: cron,
    context_mode: 'group',
    execution_type: 'agent',
    script_command: null,
    next_run: now,
    status: 'active',
    created_at: now,
    created_by: deps.ownerUserId,
    loop_kind: 'schedule',
    loop_run_id: null,
  });

  return `📅 已启动定时循环\n\n任务 ID: ${taskId}\nCron: ${cron}\n任务: ${taskText}`;
}

/** /proactive <cron> <goal> [workflow=parallel] */
export async function handleProactiveCommand(
  args: string,
  deps: LoopCommandDeps,
): Promise<string> {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    return '用法：/proactive <cron> <目标> [workflow=parallel]\n示例：/proactive 0 * * * * 处理反馈频道 workflow=parallel';
  }
  const cron = parts[0];
  const restArgs = parts.slice(1).join(' ');
  if (!isValidCron(cron)) {
    return `❌ 无效的 cron 表达式: ${cron}`;
  }
  const { mode, rest: goalText } = parseWorkflow(restArgs);
  if (!goalText) {
    return '❌ 目标不能为空';
  }

  const loopRunId = generateLoopRunId();
  const ctx: LoopRunContext = {
    loopRunId,
    ownerUserId: deps.ownerUserId,
    groupFolder: deps.groupFolder,
    chatJid: deps.chatJid,
    kind: 'proactive',
    goalText,
    maxTurns: clampMaxTurns(3), // proactive runs are short per trigger
    workflowMode: mode,
    rootPrompt: args,
  };
  createLoopRunRecord(ctx);

  const taskId = `proactive_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  createTask({
    id: taskId,
    group_folder: deps.groupFolder,
    chat_jid: deps.chatJid,
    prompt: goalText,
    schedule_type: 'cron',
    schedule_value: cron,
    context_mode: 'group',
    execution_type: 'agent',
    script_command: null,
    next_run: now,
    status: 'active',
    created_at: now,
    created_by: deps.ownerUserId,
    loop_kind: 'proactive',
    loop_run_id: loopRunId,
  });

  return `🤖 已启动主动循环\n\n循环 ID: ${loopRunId}\n任务 ID: ${taskId}\nCron: ${cron}\n目标: ${goalText}\n工作流: ${mode}`;
}

/** /cancel <loop_id> */
export async function handleCancelCommand(
  args: string,
  deps: LoopCommandDeps,
): Promise<string> {
  const id = args.trim();
  if (!id) {
    return '用法：/cancel <循环 ID 或任务 ID>';
  }

  // Try loop_runs first
  const loopRun = getLoopRun(id);
  if (loopRun) {
    if (loopRun.owner_user_id !== deps.ownerUserId) {
      return '❌ 无权取消他人的循环';
    }
    await cancelLoopRun(id, '用户通过 /cancel 取消');
    return `✅ 已取消循环 ${id}`;
  }

  // Fall back to scheduled_tasks (for /loop, /schedule, /proactive)
  // scheduled_tasks cancel is handled by the existing task pause mechanism
  // — we just return a pointer to the user.
  return `❌ 未找到循环 ${id}。如果是 /loop 或 /schedule 创建的任务，请在 Web 任务页面暂停。`;
}

/** /loops — list active loops for the current user. */
export async function handleListLoopsCommand(
  deps: LoopCommandDeps,
): Promise<string> {
  const runs = listLoopRuns(deps.ownerUserId, { limit: 10 });
  if (runs.length === 0) {
    return '📭 当前没有循环记录。\n\n用 /goal、/loop、/schedule、/proactive 启动循环。';
  }
  const lines: string[] = ['🔄 循环列表（最近 10 条）\n'];
  for (const r of runs) {
    const statusEmoji = r.status === 'completed' ? '✅'
      : r.status === 'failed' ? '❌'
      : r.status === 'cancelled' ? '🚫'
      : r.status === 'running' ? '🏃'
      : '⏸️';
    const kindEmoji = r.kind === 'goal' ? '🎯'
      : r.kind === 'loop' ? '🔄'
      : r.kind === 'schedule' ? '📅'
      : '🤖';
    lines.push(`${statusEmoji}${kindEmoji} ${r.id.slice(0, 12)}… [${r.status}]`);
    lines.push(`   目标: ${r.goal_text.slice(0, 60)}`);
    lines.push(`   轮次: ${r.current_turn}/${r.max_turns}  Token: ${(r.total_input_tokens + r.total_output_tokens).toLocaleString()}  $${r.total_cost_usd.toFixed(4)}`);
    lines.push('');
  }
  return lines.join('\n');
}
