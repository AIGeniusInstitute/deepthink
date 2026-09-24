/**
 * Agent Group Chat (swarm) — run triggering and seat-output mirroring.
 *
 * `triggerSwarmRun` is the single entry point that turns a user message into
 * a graph run; both POST /messages and POST /runs funnel through it.
 *
 * `recordSwarmSeatMessage` mirrors a finished seat node's output back into
 * `group_messages` so it shows up in the group chat. It is driven by the
 * GraphDeps.onNodeSettled hook — the broadcast `graph_node_end` event cannot be
 * used for this because graph-events.ts slices its output to 500 chars, and the
 * persisted `output_summary` is capped at 5000; only the in-memory outcome
 * carries the reply verbatim.
 *
 * `swarmSeatDeltaEvent` is the same mirroring for text that is still being
 * written: it turns a seat node's raw `text_delta` into a seat-attributed
 * `group_message_delta`, driven by GraphDeps.onNodeStream.
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

/**
 * Translate a seat node's raw stream event into a seat-attributed
 * `group_message_delta`, so the swarm page can render the reply while it is
 * still being written. Returns null for everything that is not top-level
 * assistant text from one of this group's seats (non-seat nodes, tool traffic,
 * subagent output).
 */
export function swarmSeatDeltaEvent(
  ctx: GraphRunContext,
  node: GraphNode,
  event: StreamEvent,
): StreamEvent | null {
  if (event.eventType !== 'text_delta' || !event.text) return null;
  // parentToolUseId is set on events nested inside a Task/SubAgent — that text
  // belongs to the subagent, not to the seat's own reply.
  if (event.parentToolUseId) return null;
  const seatId = seatIdFromNodeId(node.id);
  if (seatId === null) return null;
  const seat = getGroupSeat(seatId);
  if (!seat || seat.group_id !== ctx.chatJid) return null;

  return {
    eventType: 'group_message_delta',
    displayLevel: 'primary',
    agentScope: 'system',
    graphEvent: { runId: ctx.graphRunId, nodeId: node.id },
    groupMessage: {
      groupId: ctx.chatJid,
      senderType: 'agent',
      senderSeatId: seatId,
      content: event.text,
    },
  };
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
