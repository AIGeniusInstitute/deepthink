/**
 * Loop Orchestrator — manages long-running autonomous task loops.
 *
 * State machine:
 *   pending → running → reviewing → ┬→ iterating → running (loop)
 *                                   └→ completed (goal met)
 *                                   └→ failed (max_turns exhausted)
 *                                   └→ cancelled (user cancel)
 *
 * Each iteration:
 *   1. Invoke runHostAgent/runContainerAgent with the goal prompt + review hint
 *   2. Collect agent output + usage
 *   3. Call sdkQuery for review (pass/fail/needs_improvement)
 *   4. Persist iteration + trace nodes
 *   5. If pass → completed; else inject review_reason into next iteration's prompt
 */

import crypto from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import {
  addLoopRunUsage,
  createLoopIteration,
  createLoopRun,
  createLoopTraceNode,
  getLoopRun,
  getUserById,
  getUserHomeGroup,
  listLoopIterations,
  updateLoopIteration,
  updateLoopRunStatus,
  updateLoopTraceNode,
} from './db.js';
import { logger } from './logger.js';
import { sdkQuery as lightweightSdkQuery } from './sdk-query.js';
import {
  runContainerAgent,
  runHostAgent,
  type ContainerInput,
  type ContainerOutput,
} from './container-runner.js';
import type { StreamEvent } from './stream-event.types.js';
import type { ExecutionMode, RegisteredGroup } from './types.js';
import type { ChildProcess } from 'child_process';

export type LoopKind = 'goal' | 'loop' | 'schedule' | 'proactive';
export type LoopStatus =
  | 'pending'
  | 'running'
  | 'reviewing'
  | 'iterating'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ReviewResult = 'pass' | 'fail' | 'needs_improvement' | 'skipped';

export interface LoopRunContext {
  loopRunId: string;
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
  kind: LoopKind;
  goalText: string;
  successCriteria?: string;
  maxTurns: number;
  workflowMode?: 'parallel' | 'sequential';
  rootPrompt?: string;
  userLanguage?: string;
}

export interface LoopDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string | null,
    groupFolder: string,
    displayName?: string,
    taskRunId?: string,
    selectedProviderId?: string | null,
  ) => void;
  broadcastStreamEvent?: (chatJid: string, event: StreamEvent) => void;
  storeResultAndNotify?: (
    chatJid: string,
    text: string,
    options: {
      ownerId?: string;
      notifyChannels?: string[] | null;
      sourceKind?: ContainerOutput['sourceKind'];
      skipStore?: boolean;
      workspaceFolder?: string;
    },
  ) => Promise<void>;
}

const MAX_TURNS_HARD_LIMIT = 10;
const REVIEW_TIMEOUT_MS = 120_000;

/** Hard cap on max_turns to prevent runaway loops. */
export function clampMaxTurns(requested: number): number {
  return Math.max(1, Math.min(requested, MAX_TURNS_HARD_LIMIT));
}

/** Create a loop_run record and return its id. */
export function createLoopRunRecord(ctx: LoopRunContext): string {
  const startedAt = new Date().toISOString();
  createLoopRun({
    id: ctx.loopRunId,
    owner_user_id: ctx.ownerUserId,
    group_folder: ctx.groupFolder,
    chat_jid: ctx.chatJid,
    kind: ctx.kind,
    goal_text: ctx.goalText,
    success_criteria: ctx.successCriteria ?? null,
    max_turns: ctx.maxTurns,
    status: 'pending',
    started_at: startedAt,
    root_prompt: ctx.rootPrompt ?? null,
    workflow_mode: ctx.workflowMode ?? null,
  });
  return ctx.loopRunId;
}

/** Generate a fresh loop run id. */
export function generateLoopRunId(): string {
  return `loop_${crypto.randomUUID()}`;
}

/** Emit a loop_* stream event to the workspace chat. */
function emitLoopEvent(deps: LoopDeps, ctx: LoopRunContext, event: StreamEvent): void {
  deps.broadcastStreamEvent?.(ctx.chatJid, event);
}

/** Build the agent prompt for a given iteration (goal + review hint). */
function buildIterationPrompt(ctx: LoopRunContext, iteration: number, reviewHint?: string): string {
  const parts: string[] = [ctx.goalText];
  if (ctx.successCriteria) {
    parts.push(`\n\n成功标准：${ctx.successCriteria}`);
  }
  parts.push(`\n\n（第 ${iteration + 1}/${ctx.maxTurns} 轮）`);
  if (reviewHint) {
    parts.push(`\n\n上一轮评审反馈：${reviewHint}\n请基于此改进。`);
  }
  return parts.join('');
}

/** Build the reviewer prompt. */
function buildReviewerPrompt(ctx: LoopRunContext, agentOutput: string): string {
  const criteria = ctx.successCriteria ?? '由你根据目标判断是否达成';
  return [
    '你是一个严格的代码评审 Agent。请基于以下信息判定是否达成目标。',
    '',
    '【目标】',
    ctx.goalText,
    '',
    '【成功标准】',
    criteria,
    '',
    '【Agent 本轮产出】',
    agentOutput.slice(0, 8000),
    '',
    '请输出严格的 JSON（不要 markdown 代码块），格式：',
    '{"result":"pass"|"fail"|"needs_improvement","reason":"具体原因","suggestion":"下一轮改进方向"}',
  ].join('\n');
}

/** Parse the reviewer's JSON response. */
export function parseReviewResult(raw: string | null): {
  result: ReviewResult;
  reason: string;
  suggestion: string;
} {
  if (!raw) {
    return { result: 'needs_improvement', reason: '评审无响应', suggestion: '' };
  }
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
  // Find the first {...} block
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    return { result: 'needs_improvement', reason: raw.slice(0, 500), suggestion: '' };
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const result = parsed.result as ReviewResult;
    if (result !== 'pass' && result !== 'fail' && result !== 'needs_improvement') {
      return { result: 'needs_improvement', reason: `未知 result: ${result}`, suggestion: '' };
    }
    return {
      result,
      reason: String(parsed.reason ?? '').slice(0, 2000),
      suggestion: String(parsed.suggestion ?? '').slice(0, 2000),
    };
  } catch {
    return { result: 'needs_improvement', reason: cleaned.slice(0, 500), suggestion: '' };
  }
}

/** Resolve the execution mode for the loop owner's home group. */
function resolveExecutionMode(ctx: LoopRunContext, deps: LoopDeps): ExecutionMode {
  const groups = deps.registeredGroups();
  const homeGroup = Object.values(groups).find(
    (g) => g.folder === ctx.groupFolder,
  );
  if (homeGroup?.executionMode) {
    return homeGroup.executionMode;
  }
  // admin main → host; otherwise container
  return ctx.groupFolder === 'main' ? 'host' : 'container';
}

/** Resolve the session id for the loop workspace (persisted across iterations). */
function resolveSessionId(ctx: LoopRunContext, deps: LoopDeps, iteration: number): string | undefined {
  if (iteration === 0) return undefined; // first iteration starts fresh
  const sessions = deps.getSessions();
  // Sessions are keyed by `group_folder:agent_id` (or similar) — we look up by folder
  // and reuse the session created in iteration 0 (stored in loop_iterations).
  const prevIterations = listLoopIterations(ctx.loopRunId);
  const last = prevIterations[prevIterations.length - 1];
  return last?.agent_session_id ?? undefined;
}

/** Run one iteration of the loop. Returns agent output + usage. */
async function runOneIteration(
  ctx: LoopRunContext,
  deps: LoopDeps,
  iterationIndex: number,
  reviewHint?: string,
): Promise<{
  output: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}> {
  const startedAt = new Date().toISOString();
  const iterationId = createLoopIteration(ctx.loopRunId, iterationIndex, startedAt);
  const traceNodeId = createLoopTraceNode({
    loop_run_id: ctx.loopRunId,
    iteration_id: iterationId,
    node_type: 'turn',
    parent_node_id: null,
    title: `Turn ${iterationIndex + 1}`,
    started_at: startedAt,
    status: 'running',
  });

  // Emit loop_iteration_start
  emitLoopEvent(deps, ctx, {
    eventType: 'loop_iteration_start',
    loop: {
      loopRunId: ctx.loopRunId,
      kind: ctx.kind,
      iteration: iterationIndex,
      goalText: ctx.goalText,
      maxTurns: ctx.maxTurns,
      currentTurn: iterationIndex,
      status: 'running',
    },
    traceNode: {
      nodeId: traceNodeId,
      nodeType: 'turn',
      title: `Turn ${iterationIndex + 1}`,
      status: 'running',
    },
  });

  const prompt = buildIterationPrompt(ctx, iterationIndex, reviewHint);
  const executionMode = resolveExecutionMode(ctx, deps);
  const sessionId = resolveSessionId(ctx, deps, iterationIndex);
  const runAgent = executionMode === 'host' ? runHostAgent : runContainerAgent;

  const owner = getUserById(ctx.ownerUserId);
  const isAdminHome = ctx.groupFolder === 'main';
  const isHome = true; // loops always run in owner's home context

  let output = '';
  let newSessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  try {
    const input: ContainerInput = {
      prompt,
      sessionId,
      groupFolder: ctx.groupFolder,
      chatJid: ctx.chatJid,
      isMain: isAdminHome,
      isHome,
      isAdminHome,
      turnId: `${ctx.loopRunId}-t${iterationIndex}`,
      userLanguage: ctx.userLanguage ?? owner?.language ?? 'zh-CN',
    };

    const result = await runAgent(
      // workspaceGroup: a minimal shape — runHostAgent/runContainerAgent only
      // uses .folder, .chat_jid, .owner_user_id from this; we pass ctx values.
      {
        folder: ctx.groupFolder,
        chat_jid: ctx.chatJid,
        owner_user_id: ctx.ownerUserId,
        execution_mode: executionMode,
      } as unknown as RegisteredGroup,
      input,
      (proc, identifier, selectedProviderId) =>
        deps.onProcess(
          ctx.chatJid,
          proc,
          executionMode === 'container' ? identifier : null,
          ctx.groupFolder,
          `loop-${ctx.loopRunId}-t${iterationIndex}`,
          `${ctx.loopRunId}-t${iterationIndex}`,
          selectedProviderId,
        ),
      async (streamed: ContainerOutput) => {
        if (streamed.status === 'stream' && streamed.streamEvent) {
          deps.broadcastStreamEvent?.(ctx.chatJid, streamed.streamEvent);
          // Accumulate usage from stream events
          const u = streamed.streamEvent.usage;
          if (u) {
            inputTokens += u.inputTokens;
            outputTokens += u.outputTokens;
            costUsd += u.costUSD;
          }
        }
        if (streamed.result) {
          output = streamed.result;
          newSessionId = streamed.sessionId ?? newSessionId;
        }
      },
    );

    // Final result (if not already captured via stream)
    if (result && !output) {
      output = result.result ?? '';
    }
    if (result?.newSessionId) {
      newSessionId = result.newSessionId;
    }

    updateLoopIteration(iterationId, {
      status: 'completed',
      agent_session_id: newSessionId,
      ended_at: new Date().toISOString(),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      agent_output: output.slice(0, 10000),
    });
    updateLoopTraceNode(traceNodeId, {
      ended_at: new Date().toISOString(),
      output_summary: output.slice(0, 500),
      tokens: inputTokens + outputTokens,
      status: 'completed',
    });
    addLoopRunUsage(ctx.loopRunId, inputTokens, outputTokens, costUsd);
  } catch (err) {
    const errMsg = (err as Error).message?.slice(0, 500) || 'Unknown error';
    logger.error({ err: errMsg, loopRunId: ctx.loopRunId, iterationIndex }, 'Loop iteration failed');
    updateLoopIteration(iterationId, {
      status: 'failed',
      ended_at: new Date().toISOString(),
      agent_output: errMsg,
    });
    updateLoopTraceNode(traceNodeId, {
      ended_at: new Date().toISOString(),
      status: 'failed',
    });
    throw err;
  }

  return {
    output,
    sessionId: newSessionId,
    inputTokens,
    outputTokens,
    costUsd,
  };
}

/** Run the reviewer on an agent output. Returns review result. */
async function runReviewer(
  ctx: LoopRunContext,
  agentOutput: string,
  deps: LoopDeps,
): Promise<{ result: ReviewResult; reason: string; suggestion: string }> {
  const startedAt = new Date().toISOString();
  const traceNodeId = createLoopTraceNode({
    loop_run_id: ctx.loopRunId,
    iteration_id: null,
    node_type: 'review',
    parent_node_id: null,
    title: 'Review',
    started_at: startedAt,
    status: 'running',
  });

  emitLoopEvent(deps, ctx, {
    eventType: 'loop_goal_check',
    loop: {
      loopRunId: ctx.loopRunId,
      kind: ctx.kind,
      status: 'reviewing',
    },
    traceNode: {
      nodeId: traceNodeId,
      nodeType: 'review',
      title: 'Review',
      status: 'running',
    },
  });

  const reviewerPrompt = buildReviewerPrompt(ctx, agentOutput);
  const raw = await lightweightSdkQuery(reviewerPrompt, { timeout: REVIEW_TIMEOUT_MS });
  const parsed = parseReviewResult(raw);

  updateLoopTraceNode(traceNodeId, {
    ended_at: new Date().toISOString(),
    output_summary: parsed.reason.slice(0, 500),
    status: parsed.result,
  });

  return parsed;
}

/** Execute a full goal loop. Resolves when the loop completes or fails. */
export async function executeGoalLoop(ctx: LoopRunContext, deps: LoopDeps): Promise<void> {
  updateLoopRunStatus(ctx.loopRunId, 'running');
  emitLoopEvent(deps, ctx, {
    eventType: 'loop_start',
    loop: {
      loopRunId: ctx.loopRunId,
      kind: ctx.kind,
      goalText: ctx.goalText,
      successCriteria: ctx.successCriteria,
      maxTurns: ctx.maxTurns,
      currentTurn: 0,
      status: 'running',
    },
  });

  let lastReviewHint: string | undefined;
  let finalResult: ReviewResult = 'needs_improvement';
  let finalReason = '';

  try {
    for (let i = 0; i < ctx.maxTurns; i++) {
      // Check for cancellation between iterations
      const current = getLoopRun(ctx.loopRunId);
      if (current?.status === 'cancelled') {
        logger.info({ loopRunId: ctx.loopRunId }, 'Loop cancelled by user');
        return;
      }

      updateLoopRunStatus(ctx.loopRunId, 'running', { currentTurn: i });

      const { output, sessionId } = await runOneIteration(ctx, deps, i, lastReviewHint);

      // Update loop_run status to reviewing
      updateLoopRunStatus(ctx.loopRunId, 'reviewing', { currentTurn: i });

      // Run reviewer
      const review = await runReviewer(ctx, output, deps);
      finalResult = review.result;
      finalReason = review.reason;

      // Persist review result to the latest iteration
      const iterations = listLoopIterations(ctx.loopRunId);
      const latest = iterations[iterations.length - 1];
      if (latest) {
        updateLoopIteration(latest.id, {
          review_result: review.result,
          review_reason: review.reason,
        });
      }

      // Emit review event
      emitLoopEvent(deps, ctx, {
        eventType: 'loop_review_result',
        loop: {
          loopRunId: ctx.loopRunId,
          kind: ctx.kind,
          iteration: i,
          currentTurn: i,
          status: 'reviewing',
          reviewResult: review.result,
          reviewReason: review.reason,
        },
      });

      if (review.result === 'pass') {
        updateLoopRunStatus(ctx.loopRunId, 'completed', {
          endedAt: new Date().toISOString(),
        });
        await deps.storeResultAndNotify?.(ctx.chatJid, output, {
          ownerId: ctx.ownerUserId,
          sourceKind: 'sdk_final',
          workspaceFolder: ctx.groupFolder,
        });
        emitLoopEvent(deps, ctx, {
          eventType: 'loop_end',
          loop: {
            loopRunId: ctx.loopRunId,
            kind: ctx.kind,
            status: 'completed',
            reviewResult: 'pass',
            reviewReason: review.reason,
          },
        });
        return;
      }

      // Not pass — iterate
      lastReviewHint = review.suggestion || review.reason;
      updateLoopRunStatus(ctx.loopRunId, 'iterating', { currentTurn: i + 1 });
    }

    // Exhausted max_turns
    updateLoopRunStatus(ctx.loopRunId, 'failed', {
      endedAt: new Date().toISOString(),
    });
    await deps.storeResultAndNotify?.(
      ctx.chatJid,
      `目标循环未在 ${ctx.maxTurns} 轮内达成。最后评审：${finalReason}\n\n最后一轮产出：\n${await fetchLastOutput(ctx.loopRunId)}`,
      {
        ownerId: ctx.ownerUserId,
        sourceKind: 'sdk_final',
        workspaceFolder: ctx.groupFolder,
      },
    );
    emitLoopEvent(deps, ctx, {
      eventType: 'loop_end',
      loop: {
        loopRunId: ctx.loopRunId,
        kind: ctx.kind,
        status: 'failed',
        reviewResult: finalResult,
        reviewReason: finalReason,
      },
    });
  } catch (err) {
    const errMsg = (err as Error).message?.slice(0, 500) || 'Unknown error';
    logger.error({ err: errMsg, loopRunId: ctx.loopRunId }, 'Goal loop failed');
    updateLoopRunStatus(ctx.loopRunId, 'failed', {
      endedAt: new Date().toISOString(),
      cancelReason: errMsg,
    });
    emitLoopEvent(deps, ctx, {
      eventType: 'loop_end',
      loop: {
        loopRunId: ctx.loopRunId,
        kind: ctx.kind,
        status: 'failed',
        reviewReason: errMsg,
      },
    });
  }
}

/** Fetch the last iteration's agent output for the failure message. */
async function fetchLastOutput(loopRunId: string): Promise<string> {
  const iterations = listLoopIterations(loopRunId);
  const last = iterations[iterations.length - 1];
  return last?.agent_output ?? '(无产出)';
}

/** Cancel a running loop by id. */
export async function cancelLoopRun(loopRunId: string, reason?: string): Promise<void> {
  const run = getLoopRun(loopRunId);
  if (!run) {
    throw new Error(`Loop run not found: ${loopRunId}`);
  }
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return; // already terminal
  }
  updateLoopRunStatus(loopRunId, 'cancelled', {
    endedAt: new Date().toISOString(),
    cancelReason: reason ?? '用户取消',
  });
  logger.info({ loopRunId, reason }, 'Loop cancelled');
}

/** Re-export sdkQuery for callers that need it. */
export { sdkQuery };
