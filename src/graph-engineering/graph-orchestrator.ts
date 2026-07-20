/**
 * Graph Orchestrator — top-level execution loop + control API.
 *
 * executeGraph(): mark run running → loop { derive ready batch (scheduler) →
 * run nodes in parallel (runner) → merge state patches, record branch
 * decisions → persist state checkpoint → check pause/cancel } until all nodes
 * completed or run fails/cancelled.
 *
 * Resume: reconstructs the completed-set and branch decisions from
 * graph_node_runs + state_json, then re-enters the loop — skipping already-
 * completed nodes (AC3.4).
 *
 * Control API: pauseGraphRun / resumeGraphRun / cancelGraphRun / rerunGraphNode.
 *
 * See SOLUTION.md §4/§6.
 */

import crypto from 'node:crypto';

import {
  createGraphRun,
  getCompletedGraphNodeIds,
  getGraphDefinition,
  getGraphRun,
  listGraphNodeRuns,
  resetGraphNodeAndDownstream,
  updateGraphRunStatus,
} from '../db.js';
import { logger } from '../logger.js';
import {
  allCompleted,
  branchEdgeCoverage,
  computeReadyNodes,
  downstreamNodeIds,
  nextReadyBatch,
} from './graph-scheduler.js';
import {
  deserializeDefinition,
  loadLatestDefinition,
} from './graph-registry.js';
import { runGraphNode, type GraphDeps, type GraphRunContext } from './graph-runner.js';
import type { GraphDefinition, GraphNode, GraphState, NodeRunOutcome } from './graph-types.js';

const BRANCH_STATE_PREFIX = '__branch_';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 5000;
const POLL_INTERVAL_MS = 1000;

/** Build a GraphRunContext from a persisted graph_run row + its locked definition. */
export async function buildRunContext(
  runId: string,
  deps: GraphDeps,
): Promise<{ ctx: GraphRunContext; definition: GraphDefinition } | null> {
  const run = getGraphRun(runId);
  if (!run) return null;
  const defRow = getGraphDefinition(run.definition_id, run.definition_version);
  if (!defRow) {
    logger.error({ runId, defId: run.definition_id, ver: run.definition_version },
      'Graph definition version missing — cannot resume');
    return null;
  }
  const definition = deserializeDefinition(defRow);
  const ctx: GraphRunContext = {
    graphRunId: run.id,
    ownerUserId: run.owner_user_id,
    groupFolder: run.group_folder,
    chatJid: run.chat_jid,
    definition,
    state: JSON.parse(run.state_json || '{}') as GraphState,
    maxParallel: run.max_parallel,
  };
  return { ctx, definition };
}

/** Reconstruct branch decisions from persisted state (resume support). */
function reconstructBranchDecisions(state: GraphState): Map<string, string> {
  const decisions = new Map<string, string>();
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith(BRANCH_STATE_PREFIX)) {
      decisions.set(k.slice(BRANCH_STATE_PREFIX.length), String(v));
    }
  }
  return decisions;
}

/** Run a single node with retry policy (maxAttempts + exponential backoff). */
async function runNodeWithRetry(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
  parentNodeRunId: string | null,
): Promise<NodeRunOutcome> {
  const maxAttempts = node.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = node.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastOutcome: NodeRunOutcome = {
    status: 'failed', output: '', inputTokens: 0, outputTokens: 0, costUsd: 0,
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Re-check run status between attempts (pause/cancel).
    const run = getGraphRun(ctx.graphRunId);
    if (run?.status === 'cancelled') return { ...lastOutcome, status: 'skipped' };
    if (run?.status === 'paused') return { ...lastOutcome, status: 'paused' };

    lastOutcome = await runGraphNode(ctx, deps, node, parentNodeRunId);
    if (lastOutcome.status === 'completed') return lastOutcome;
    if (lastOutcome.status === 'paused') return lastOutcome; // human node
    if (lastOutcome.status === 'skipped') return lastOutcome;
    // failed → retry with backoff (unless last attempt)
    if (attempt < maxAttempts - 1) {
      logger.warn({ graphRunId: ctx.graphRunId, nodeId: node.id, attempt },
        'Node failed, retrying after backoff');
      await sleep(backoff * Math.pow(2, attempt));
    }
  }
  return lastOutcome;
}

/** Merge a node's state patch into the shared state. */
function mergeStatePatch(state: GraphState, patch: NodeRunOutcome['statePatch']): void {
  if (!patch) return;
  for (const [k, v] of Object.entries(patch)) state[k] = v;
}

/** Persist the current shared state back to graph_runs.state_json. */
function persistState(runId: string, state: GraphState): void {
  updateGraphRunStatus(runId, 'running', { stateJson: JSON.stringify(state) });
}

/**
 * Execute a graph run to completion (or until paused/cancelled/failed).
 * Idempotent on resume: skips nodes already in 'completed'.
 */
export async function executeGraph(ctx: GraphRunContext, deps: GraphDeps): Promise<void> {
  const def = ctx.definition;
  const coverageErrors = branchEdgeCoverage(def);
  if (coverageErrors.length) {
    logger.warn({ errors: coverageErrors }, 'Graph branch edge coverage warnings');
  }

  updateGraphRunStatus(ctx.graphRunId, 'running');
  logger.info({ graphRunId: ctx.graphRunId, defId: def.id }, 'Graph run started');

  // Resume: rebuild completed-set + branch decisions from persisted state.
  const completed = getCompletedGraphNodeIds(ctx.graphRunId);
  const branchDecisions = reconstructBranchDecisions(ctx.state);

  try {
    while (true) {
      const run = getGraphRun(ctx.graphRunId);
      if (run?.status === 'cancelled') {
        logger.info({ graphRunId: ctx.graphRunId }, 'Graph cancelled by user');
        return;
      }
      if (run?.status === 'paused') {
        logger.info({ graphRunId: ctx.graphRunId }, 'Graph paused — awaiting resume');
        return;
      }

      if (allCompleted(def, completed)) {
        updateGraphRunStatus(ctx.graphRunId, 'completed', { endedAt: new Date().toISOString() });
        logger.info({ graphRunId: ctx.graphRunId }, 'Graph run completed');
        return;
      }

      const ready = computeReadyNodes(def, completed, branchDecisions);
      if (ready.length === 0) {
        // No ready nodes but not all completed → deadlock or waiting on paused.
        const anyRunning = listGraphNodeRuns(ctx.graphRunId).some(
          (n) => n.status === 'running',
        );
        if (!anyRunning) {
          updateGraphRunStatus(ctx.graphRunId, 'failed', {
            endedAt: new Date().toISOString(),
            cancelReason: 'deadlock: no ready nodes and none running',
          });
          logger.error({ graphRunId: ctx.graphRunId }, 'Graph deadlocked');
          return;
        }
        // Something still running — wait for it to settle.
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // P0: self-limit to maxParallel. The true global ceiling
      // (MAX_CONCURRENT_CONTAINERS / HOST_PROCESSES) is enforced downstream by
      // runHostAgent/runContainerAgent + GroupQueue.
      const batch = nextReadyBatch(ready, ctx.maxParallel, ctx.maxParallel);
      updateGraphRunStatus(ctx.graphRunId, 'running', {
        currentNodeId: batch[0]?.id ?? null,
      });

      // Fan-out: run the batch concurrently.
      const results = await Promise.all(
        batch.map((node) => runNodeWithRetry(ctx, deps, node, null)),
      );

      for (let i = 0; i < batch.length; i++) {
        const node = batch[i];
        const outcome = results[i];
        if (outcome.status === 'completed') {
          completed.add(node.id);
          mergeStatePatch(ctx.state, outcome.statePatch);
          // Branch: record the chosen condition so computeReadyNodes activates
          // only the matching outgoing conditional edge.
          if (node.type === 'branch' && outcome.branchResult) {
            ctx.state[`${BRANCH_STATE_PREFIX}${node.id}`] = outcome.branchResult;
            branchDecisions.set(node.id, outcome.branchResult);
          }
        } else if (outcome.status === 'paused') {
          // human node — pause the whole run (P0).
          updateGraphRunStatus(ctx.graphRunId, 'paused', {
            currentNodeId: node.id,
            endedAt: new Date().toISOString(),
          });
          persistState(ctx.graphRunId, ctx.state);
          logger.info({ graphRunId: ctx.graphRunId, nodeId: node.id }, 'Graph paused at human node');
          return;
        } else {
          // failed (skipped from cancel also lands here)
          updateGraphRunStatus(ctx.graphRunId, 'failed', {
            endedAt: new Date().toISOString(),
            cancelReason: `node ${node.id} failed: ${outcome.error ?? 'unknown'}`,
          });
          persistState(ctx.graphRunId, ctx.state);
          logger.error({ graphRunId: ctx.graphRunId, nodeId: node.id, err: outcome.error },
            'Graph run failed at node');
          return;
        }
      }
      persistState(ctx.graphRunId, ctx.state);
    }
  } catch (err) {
    const errMsg = (err as Error).message?.slice(0, 500) || 'Unknown error';
    logger.error({ err: errMsg, graphRunId: ctx.graphRunId }, 'Graph orchestrator crashed');
    updateGraphRunStatus(ctx.graphRunId, 'failed', {
      endedAt: new Date().toISOString(),
      cancelReason: `orchestrator crash: ${errMsg}`,
    });
    persistState(ctx.graphRunId, ctx.state);
  }
}

/** Pause a running graph (takes effect at the next node boundary). */
export function pauseGraphRun(runId: string): void {
  updateGraphRunStatus(runId, 'paused');
}

/** Cancel a running graph (takes effect at the next node boundary). */
export function cancelGraphRun(runId: string, reason: string): void {
  updateGraphRunStatus(runId, 'cancelled', {
    endedAt: new Date().toISOString(),
    cancelReason: reason,
  });
}

/** Reset a node (and downstream) to pending so the scheduler re-runs them. */
export function rerunGraphNode(runId: string, nodeId: string): number {
  return resetGraphNodeAndDownstream(runId, nodeId);
}

/** Start a graph run from a registered definition. Returns the new run id. */
export function startGraphRun(opts: {
  definitionId: string;
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
  goalText?: string;
  maxParallel?: number;
  initialState?: GraphState;
}): { runId: string; definition: GraphDefinition } | { error: string } {
  const def = loadLatestDefinition(opts.definitionId);
  if (!def) return { error: `definition not found: ${opts.definitionId}` };
  const runId = `graph-${crypto.randomUUID()}`;
  createGraphRun({
    id: runId,
    definition_id: def.id,
    definition_version: def.version,
    owner_user_id: opts.ownerUserId,
    group_folder: opts.groupFolder,
    chat_jid: opts.chatJid,
    goal_text: opts.goalText ?? null,
    max_parallel: opts.maxParallel ?? 4,
    state_json: JSON.stringify(opts.initialState ?? {}),
    started_at: new Date().toISOString(),
  });
  return { runId, definition: def };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
