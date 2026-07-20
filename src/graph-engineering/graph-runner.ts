/**
 * Graph Runner — executes a single graph node.
 *
 * Dispatches by node type:
 *  - agent: calls runHostAgent/runContainerAgent (mirrors loop-orchestrator
 *           runOneIteration, but the prompt comes from the node, not a loop hint)
 *  - gate:  calls the reviewer (lightweightSdkQuery + parseReviewResult) — pass
 *           = completed, fail = failed
 *  - branch: evaluates the node's branchKey against the shared state to decide
 *           which outgoing conditional edge to activate
 *  - join:   pass-through (the scheduler only activates a join once all
 *           predecessors are completed; the node itself is a no-op marker)
 *  - human:  P0 placeholder — pauses the run (full HITL + IM approval in P1)
 *
 * Each node run creates a graph_node_runs checkpoint row BEFORE execution
 * (status=running) and updates it after (status=completed/failed/paused), so a
 * crash never leaves the run in an un-resumable state. See SOLUTION.md §3/§6.
 */

import type { ChildProcess } from 'child_process';

import {
  addGraphRunUsage,
  acquireNodeLock,
  createGraphNodeRun,
  releaseNodeLock,
  updateGraphNodeRun,
} from '../db.js';
import { logger } from '../logger.js';
import { sdkQuery as lightweightSdkQuery } from '../sdk-query.js';
import {
  runContainerAgent,
  runHostAgent,
  type ContainerInput,
  type ContainerOutput,
} from '../container-runner.js';
import { parseReviewResult } from '../loop-orchestrator.js';
import type { ExecutionMode, RegisteredGroup } from '../types.js';
import type { StreamEvent } from '../stream-event.types.js';
import type {
  GraphDefinition,
  GraphNode,
  GraphState,
  NodeRunOutcome,
  StatePatch,
} from './graph-types.js';

const GATE_REVIEW_TIMEOUT_MS = 120_000;

/** Context for a single graph run (mirrors LoopRunContext shape). */
export interface GraphRunContext {
  graphRunId: string;
  ownerUserId: string;
  groupFolder: string;
  chatJid: string;
  definition: GraphDefinition;
  state: GraphState;
  maxParallel: number;
  userLanguage?: string;
}

/** Dependencies injected from the host process (mirrors LoopDeps). */
export interface GraphDeps {
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

/** Resolve execution mode for the owner's home group (mirrors loop-orchestrator). */
function resolveExecutionMode(ctx: GraphRunContext, deps: GraphDeps): ExecutionMode {
  const groups = deps.registeredGroups();
  const homeGroup = Object.values(groups).find((g) => g.folder === ctx.groupFolder);
  if (homeGroup?.executionMode) return homeGroup.executionMode;
  return ctx.groupFolder === 'main' ? 'host' : 'container';
}

/** Build a synthetic RegisteredGroup for the owner folder (mirrors runOneIteration). */
function buildOwnerGroup(ctx: GraphRunContext, executionMode: ExecutionMode): RegisteredGroup {
  return {
    folder: ctx.groupFolder,
    chat_jid: ctx.chatJid,
    owner_user_id: ctx.ownerUserId,
    execution_mode: executionMode,
  } as unknown as RegisteredGroup;
}

/** Build the reviewer prompt for a gate node. */
function buildGatePrompt(node: GraphNode, agentOutput: string): string {
  const criteria = node.successCriteria ?? '由你根据节点目标判断是否达成';
  return [
    '你是一个严格的评审 Agent。请基于以下信息判定图节点是否达成目标。',
    '',
    '【节点目标】',
    node.title,
    '',
    '【成功标准】',
    criteria,
    '',
    '【节点产出】',
    agentOutput.slice(0, 8000),
    '',
    '请输出严格的 JSON（不要 markdown 代码块），格式：',
    '{"result":"pass"|"fail"|"needs_improvement","reason":"具体原因","suggestion":"改进方向"}',
  ].join('\n');
}

/**
 * Execute one node. Creates the checkpoint row, dispatches by type, persists
 * the outcome. Returns NodeRunOutcome for the scheduler to merge state patch
 * and advance the ready queue.
 */
export async function runGraphNode(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
  parentNodeRunId: string | null,
): Promise<NodeRunOutcome> {
  const nodeRunId = `${ctx.graphRunId}:${node.id}:${Date.now()}`;
  const startedAt = new Date().toISOString();

  // Persist BEFORE execution (crash safety). Attempt counter incremented by
  // the scheduler on retry; here we just create the row at running.
  createGraphNodeRun({
    id: nodeRunId,
    graph_run_id: ctx.graphRunId,
    node_id: node.id,
    node_type: node.type,
    parent_node_run_id: parentNodeRunId,
    is_idempotent: !!node.isIdempotent,
    input_summary: JSON.stringify({ state: ctx.state }).slice(0, 2000),
  });

  // AC2.7: acquire a workspace lock for audit/observability. P0 runs nodes in
  // the owner group folder; parallel nodes are expected to write DISJOINT
  // artifacts (graph authors declare node outputs). File-level isolation is P1.
  const lockId = acquireNodeLock({
    graph_run_id: ctx.graphRunId,
    node_id: node.id,
    workspace_folder: ctx.groupFolder,
  });

  try {
    const outcome = await dispatchByType(ctx, deps, node);

    updateGraphNodeRun(nodeRunId, {
      status: outcome.status,
      output_summary: outcome.output.slice(0, 5000),
      state_patch_json: outcome.statePatch ? JSON.stringify(outcome.statePatch) : null,
      ended_at: new Date().toISOString(),
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      cost_usd: outcome.costUsd,
      error: outcome.error ?? null,
    });
    addGraphRunUsage(ctx.graphRunId, outcome.inputTokens, outcome.outputTokens, outcome.costUsd);
    return outcome;
  } catch (err) {
    const errMsg = (err as Error).message?.slice(0, 500) || 'Unknown error';
    logger.error({ err: errMsg, graphRunId: ctx.graphRunId, nodeId: node.id }, 'Graph node failed');
    updateGraphNodeRun(nodeRunId, {
      status: 'failed',
      ended_at: new Date().toISOString(),
      error: errMsg,
    });
    return {
      status: 'failed',
      output: '',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: errMsg,
    };
  } finally {
    releaseNodeLock(lockId);
  }
}

/** Type-specific dispatch. */
async function dispatchByType(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
): Promise<NodeRunOutcome> {
  switch (node.type) {
    case 'agent':
      return runAgentNode(ctx, deps, node);
    case 'gate':
      return runGateNode(node);
    case 'branch':
      return runBranchNode(node, ctx.state);
    case 'join':
      return { status: 'completed', output: '', inputTokens: 0, outputTokens: 0, costUsd: 0 };
    case 'human':
      // P0 placeholder: pause the run. Full HITL + IM approval in P1.
      return {
        status: 'paused',
        output: 'human-in-the-loop node pending (P0 placeholder)',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
    default:
      return {
        status: 'failed',
        output: '',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        error: `unknown node type: ${(node as GraphNode).type}`,
      };
  }
}

/** Run an 'agent' node — calls runHostAgent/runContainerAgent (mirrors runOneIteration). */
async function runAgentNode(
  ctx: GraphRunContext,
  deps: GraphDeps,
  node: GraphNode,
): Promise<NodeRunOutcome> {
  const executionMode = resolveExecutionMode(ctx, deps);
  const runAgent = executionMode === 'host' ? runHostAgent : runContainerAgent;
  const group = buildOwnerGroup(ctx, executionMode);
  const turnId = `${ctx.graphRunId}-${node.id}`;

  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const input: ContainerInput = {
    prompt: node.prompt ?? node.title,
    groupFolder: ctx.groupFolder,
    chatJid: ctx.chatJid,
    isMain: ctx.groupFolder === 'main',
    isHome: true,
    isAdminHome: ctx.groupFolder === 'main',
    turnId,
    userLanguage: ctx.userLanguage ?? 'zh-CN',
  };

  await runAgent(
    group,
    input,
    (proc, identifier, selectedProviderId) =>
      deps.onProcess(
        ctx.chatJid,
        proc,
        executionMode === 'container' ? identifier : null,
        ctx.groupFolder,
        `graph-${ctx.graphRunId}-${node.id}`,
        turnId,
        selectedProviderId,
      ),
    async (streamed: ContainerOutput) => {
      if (streamed.status === 'stream' && streamed.streamEvent) {
        deps.broadcastStreamEvent?.(ctx.chatJid, streamed.streamEvent);
        const u = (streamed.streamEvent as { usage?: { inputTokens: number; outputTokens: number; costUSD: number } }).usage;
        if (u) {
          inputTokens += u.inputTokens;
          outputTokens += u.outputTokens;
          costUsd += u.costUSD;
        }
      }
      if (streamed.result) output = streamed.result;
    },
  );

  // Heuristic state patch: expose the agent output so downstream nodes can read it.
  const statePatch: StatePatch = { [`node_${node.id}_output`]: output.slice(0, 4000) };

  return {
    status: 'completed',
    output,
    statePatch,
    inputTokens,
    outputTokens,
    costUsd,
  };
}

/** Run a 'gate' node — reviewer decides pass/fail. */
async function runGateNode(node: GraphNode): Promise<NodeRunOutcome> {
  const prompt = buildGatePrompt(node, node.prompt ?? '');
  const raw = await lightweightSdkQuery(prompt, { timeout: GATE_REVIEW_TIMEOUT_MS });
  const parsed = parseReviewResult(raw);
  const status = parsed.result === 'pass' ? 'completed' : 'failed';
  return {
    status,
    output: parsed.reason,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    error: status === 'failed' ? parsed.reason : undefined,
  };
}

/** Run a 'branch' node — evaluate branchKey against state, return the chosen value. */
function runBranchNode(node: GraphNode, state: GraphState): NodeRunOutcome {
  const key = node.branchKey ?? '';
  const value = state[key];
  const branchResult = value === undefined || value === null ? 'default' : String(value);
  return {
    status: 'completed',
    output: `branch → ${branchResult}`,
    branchResult,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}
