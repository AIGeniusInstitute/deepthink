/**
 * Agent Group Chat (swarm) — run triggering, seat-output mirroring, and
 * full-capability event forwarding.
 *
 * `triggerSwarmRun` is the single entry point that turns a user message into
 * a graph run; both POST /messages and POST /runs funnel through it.
 *
 * `recordSwarmSeatMessage` mirrors a finished seat node's output back into
 * `group_messages` so it shows up in the group chat. It is driven by the
 * GraphDeps.onNodeSettled hook.
 *
 * `swarmSeatDeltaEvent` translates seat node stream events into group-level
 * events so the frontend can render the full agent experience: streaming
 * thoughts, tool calls, skill invocations, token usage, and execution
 * state changes — not just the final text output.
 */

import { createGroupMessage, getGroupSeat, type GroupMessageRow } from '../db.js';
import type { GraphNode, NodeRunOutcome } from '../graph-engineering/graph-types.js';
import type { GraphRunContext } from '../graph-engineering/graph-runner.js';
import type { StreamEvent } from '../stream-event.types.js';
import type { RegisteredGroup } from '../types.js';
import type { SelectedMounts, WebDeps } from '../web-context.js';
import { ensureSwarmDefinition, seatIdFromNodeId } from './swarm-definition.js';

/** Reply text kept per seat message (matches the previous ad-hoc cap). */
const MAX_SEAT_REPLY_CHARS = 10000;

export interface TriggerSwarmRunOptions {
  group: RegisteredGroup & { jid: string };
  ownerUserId: string;
  goalText: string;
  /** Skills / MCP servers / knowledge bases selected for this message. */
  turnMounts?: SelectedMounts;
  startGraphRun: NonNullable<WebDeps['startGraphRun']>;
}

/**
 * Start a graph run for a swarm group, provisioning its definition first.
 * Returns an explicit error instead of a fake `running` status when nothing
 * could actually be started.
 */
export function triggerSwarmRun(
  opts: TriggerSwarmRunOptions,
): { runId: string } | { error: string } {
  const ensured = ensureSwarmDefinition(opts.group);
  if ('error' in ensured) return ensured;

  const started = opts.startGraphRun({
    definitionId: ensured.definitionId,
    ownerUserId: opts.ownerUserId,
    groupFolder: opts.group.folder,
    chatJid: opts.group.jid,
    goalText: opts.goalText,
    // The seats are chained by edges, so the scheduler already serialises
    // them; a wider parallel budget would only fan out containers.
    maxParallel: 1,
    // `goal` seeds the seats' prompt, `turnMounts` the skills/MCP/KB each seat
    // gets — both are read back by graph-runner's runAgentNode.
    initialState: { goal: opts.goalText, turnMounts: opts.turnMounts },
  });
  if (!started.success || !started.runId) {
    return { error: started.error ?? 'startGraphRun 未返回 runId' };
  }
  return { runId: started.runId };
}

/**
 * Persist a settled seat node's output as an agent message in the group chat.
 * Returns null when the node isn't one of this group's seats (every other
 * graph run in the process passes through here too).
 */
export function recordSwarmSeatMessage(
  ctx: GraphRunContext,
  node: GraphNode,
  outcome: NodeRunOutcome,
): GroupMessageRow | null {
  const seatId = seatIdFromNodeId(node.id);
  if (seatId === null) return null;
  const seat = getGroupSeat(seatId);
  if (!seat || seat.group_id !== ctx.chatJid) return null;

  const ok = outcome.status === 'completed';
  const content =
    outcome.output.trim() ||
    (ok ? '' : `（${seat.agent_definition_id} 执行失败：${outcome.error ?? 'unknown'}）`);
  if (!content) return null;

  return createGroupMessage({
    groupId: ctx.chatJid,
    runId: ctx.graphRunId,
    nodeRunId: `${ctx.graphRunId}:${node.id}`,
    senderType: 'agent',
    senderSeatId: seatId,
    msgType: 'text',
    contentRef: content.slice(0, MAX_SEAT_REPLY_CHARS),
    status: ok ? 'completed' : 'failed',
  });
}

/** Helper: build a seat-attributed group event envelope. */
function groupEvent(
  ctx: GraphRunContext,
  node: GraphNode,
  seatId: number,
  eventType: StreamEvent['eventType'],
  overrides: Partial<StreamEvent> = {},
): StreamEvent {
  const seat = getGroupSeat(seatId);
  const seatName = seat?.role_prompt?.trim() || seat?.agent_definition_id || '';
  return {
    eventType,
    displayLevel: 'primary' as const,
    agentScope: 'system',
    graphEvent: { runId: ctx.graphRunId, nodeId: node.id },
    groupMessage: {
      groupId: ctx.chatJid,
      senderType: 'agent',
      senderSeatId: seatId,
      content: '',
      seatName,
    } as any,
    ...overrides,
  };
}

/**
 * Translate a seat node's stream event into group-level events so the
 * frontend GroupChatArea can render the full agent experience: streaming
 * thoughts, tool calls, and status — not just text_delta.
 *
 * Event mapping:
 *   text_delta       → group_message_delta
 *   thinking_delta   → group_thinking_delta
 *   tool_use_start   → group_tool_call
 *   tool_result      → group_tool_result
 *   status           → group_seat_status
 *   graph_node_start → group_seat_status (running)
 *   graph_node_end   → group_seat_status (completed/failed)
 */
export function swarmSeatDeltaEvent(
  ctx: GraphRunContext,
  node: GraphNode,
  event: StreamEvent,
): StreamEvent | null {
  const seatId = seatIdFromNodeId(node.id);
  if (seatId === null) return null;
  const seat = getGroupSeat(seatId);
  if (!seat || seat.group_id !== ctx.chatJid) return null;

  // ── text_delta: the seat is writing its reply ─────────────────
  if (event.eventType === 'text_delta' && event.text && !event.parentToolUseId) {
    return groupEvent(ctx, node, seatId, 'group_message_delta', {
      text: event.text,
      groupMessage: {
        groupId: ctx.chatJid,
        senderType: 'agent',
        senderSeatId: seatId,
        content: event.text,
      } as any,
    });
  }

  // ── thinking_delta: the seat's internal reasoning stream ──────
  if (event.eventType === 'thinking_delta' && event.text) {
    return groupEvent(ctx, node, seatId, 'group_thinking_delta', {
      text: event.text,
      groupMessage: {
        groupId: ctx.chatJid,
        senderType: 'agent',
        senderSeatId: seatId,
        content: event.text,
      } as any,
    });
  }

  // ── tool_use_start: the seat invoked a tool ───────────────────
  if (event.eventType === 'tool_use_start' && event.toolName) {
    return groupEvent(ctx, node, seatId, 'group_tool_call', {
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      toolInputSummary: event.toolInputSummary,
      toolInput: event.toolInput,
      groupMessage: {
        groupId: ctx.chatJid,
        senderType: 'agent',
        senderSeatId: seatId,
        content: event.toolName,
        toolCall: {
          id: event.toolUseId ?? '',
          name: event.toolName,
          input: event.toolInput ?? {},
        },
      } as any,
    });
  }

  // ── tool_result: tool returned ────────────────────────────────
  if (event.eventType === 'tool_result') {
    return groupEvent(ctx, node, seatId, 'group_tool_result', {
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      toolResult: event.toolResult,
      groupMessage: {
        groupId: ctx.chatJid,
        senderType: 'agent',
        senderSeatId: seatId,
        content: event.toolResult ?? '',
        toolCall: {
          id: event.toolUseId ?? '',
          name: event.toolName ?? '',
          output: event.toolResult,
        },
      } as any,
    });
  }

  // ── status: execution state change ────────────────────────────
  if (event.eventType === 'status') {
    return groupEvent(ctx, node, seatId, 'group_seat_status', {
      statusText: event.statusText,
      groupMessage: {
        groupId: ctx.chatJid,
        senderType: 'agent',
        senderSeatId: seatId,
        content: event.statusText ?? '',
        status: event.statusText ?? 'running',
      } as any,
    });
  }

  // ── token usage from the 'usage' event ────────────────────────
  if (event.eventType === 'usage' && event.usage) {
    return groupEvent(ctx, node, seatId, 'group_token_usage', {
      usage: event.usage,
      groupMessage: {
        groupId: ctx.chatJid,
        senderType: 'agent',
        senderSeatId: seatId,
        content: '',
        tokenIn: event.usage.inputTokens,
        tokenOut: event.usage.outputTokens,
      } as any,
    });
  }

  return null;
}

/** Stream event announcing a new group_messages row to the swarm page. */
export function groupMessageCreatedEvent(
  runId: string,
  nodeId: string,
  m: GroupMessageRow,
): StreamEvent {
  return {
    eventType: 'group_message_created',
    displayLevel: 'primary',
    agentScope: 'system',
    graphEvent: { runId, nodeId },
    groupMessage: {
      id: m.id,
      groupId: m.group_id,
      runId: m.run_id,
      nodeRunId: m.node_run_id,
      senderType: m.sender_type as 'user' | 'agent' | 'system',
      senderSeatId: m.sender_seat_id,
      msgType: m.msg_type,
      content: m.content_ref ?? '',
      status: m.status,
      createdAt: m.created_at,
    },
  };
}