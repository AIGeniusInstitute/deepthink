/**
 * Agent Group Chat (swarm) — seat → graph definition provisioning.
 *
 * A swarm group is not a separate execution engine: it is a graph_definition
 * whose nodes are the group's seats and whose edges are the speaking order.
 * Messages trigger `startGraphRun()`; the graph engine does the rest.
 * See docs/tech_solution/agent-group-chat/TECH_SOLUTION.md §3.3.
 *
 * Seats are stable entities (group_seats.id is the PK), so a seat is encoded
 * directly in its node id as `seat-<id>`: the orchestrator's node field, the
 * Pipeline panel and the output→group_messages hook all recover the seat with
 * one parse, no side table.
 */

import {
  getAgentDefinition,
  getLatestGraphDefinition,
  listGroupSeats,
  setSwarmGroupDefinitionId,
  type GroupSeatRow,
} from '../db.js';
import { computeManifestHash, registerDefinition } from '../graph-engineering/graph-registry.js';
import type { GraphDefinition, GraphEdge, GraphNode } from '../graph-engineering/graph-types.js';
import type { RegisteredGroup } from '../types.js';

/** Node id prefix carrying the seat PK. */
export const SEAT_NODE_PREFIX = 'seat-';

/** Recover the seat id from a swarm node id, or null when it isn't a seat. */
export function seatIdFromNodeId(nodeId: string): number | null {
  const m = /^seat-(\d+)$/.exec(nodeId);
  return m ? Number(m[1]) : null;
}

/** Definition id for a swarm group. `folder` is unique per swarm group. */
export function swarmDefinitionId(groupFolder: string): string {
  return `swarm-${groupFolder}`;
}

/** Seats that take the floor on their own (silent seats never speak). */
export function speakingSeats(seats: GroupSeatRow[]): GroupSeatRow[] {
  return seats.filter((s) => s.speak_policy !== 'silent');
}

/**
 * Build the graph definition for a swarm group: one agent node per speaking
 * seat (already ordered by `listGroupSeats`), chained linearly by seat_order,
 * so the seats speak in turn.
 *
 * Pure — `resolveAgentDef` is injected so this is unit-testable without a DB.
 */
export function buildSwarmDefinition(
  group: { jid: string; name: string; folder: string },
  seats: GroupSeatRow[],
  resolveAgentDef: (agentDefId: string) => boolean,
): GraphDefinition {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let prev: string | null = null;
  const speaking = speakingSeats(seats);
  const totalSeats = speaking.length;

  for (let i = 0; i < speaking.length; i++) {
    const seat = speaking[i];
    const id = `${SEAT_NODE_PREFIX}${seat.id}`;
    const label = seat.role_prompt.trim() || seat.agent_definition_id;

    // Build a prompt that enables debate, critique, and collaboration.
    // Earlier seats see only the user message; later seats also see what
    // previous seats said so they can analyse, challenge, or build on it.
    const promptParts: string[] = [
      `你是多 Agent 讨论组「${group.name}」的成员（席位 ${i + 1}/${totalSeats}）：${label}。`,
    ];

    if (seat.role_prompt.trim()) {
      promptParts.push(`\n【角色设定】\n${seat.role_prompt.trim()}`);
    }

    // Debate & collaboration instructions — the seat behaviour varies by position:
    if (totalSeats >= 2 && i > 0) {
      // Late seats: see earlier seats' output, must analyse / challenge / extend
      promptParts.push(
        '\n【协作要求 — 你必须审阅前序席位的发言】',
        '- 前面的席位已经给出了他们的分析和结论（会附在下方）。',
        '- 仔细阅读前序席位的发言：指出赞同/不赞同的具体点并给出理由。',
        '- 如果有不同观点或遗漏，请明确指出来并提供你的分析。',
        '- 在前序席位的基础上深化讨论，而非简单重复。',
        '- 用你的专业角色视角审视前序结论是否完备。',
        '- 只输出你的发言正文；工具调用和思考过程会自动记录，无需额外说明。',
      );
    } else if (totalSeats >= 2 && i === 0) {
      // First seat: sets the stage, knows others will critique
      promptParts.push(
        '\n【协作要求 — 你是本轮的首位发言者】',
        '- 请给出你完整的初步分析和结论。',
        '- 后续席位会审阅和补充你的观点，所以请尽量全面、结构化地阐述。',
        '- 只输出你的发言正文；工具调用和思考过程会自动记录，无需额外说明。',
      );
    } else {
      promptParts.push(
        '\n【发言要求】',
        '- 紧扣用户消息，用你的角色立场给出观点与论据。',
        '- 只输出发言正文；工具调用和思考过程会自动记录，无需额外说明。',
      );
    }

    const node: GraphNode = {
      id,
      type: 'agent',
      title: label,
      isIdempotent: false,
      prompt: promptParts.join('\n'),
    };

    if (resolveAgentDef(seat.agent_definition_id)) {
      node.agentDefId = seat.agent_definition_id;
      node.agentMember = label;
    }
    nodes.push(node);
    if (prev !== null) {
      edges.push({ id: `${prev}->${id}`, from: prev, to: id, type: 'data' });
    }
    prev = id;
  }

  return {
    id: swarmDefinitionId(group.folder),
    version: 1,
    name: `swarm: ${group.name}`,
    description: `Agent Group Chat pipeline for ${group.jid} (${nodes.length} seats)`,
    nodes,
    edges,
    stateSchema: [{ name: 'goal', description: '本群用户最新一条消息（由 /messages 注入）' }],
  };
}

export type EnsureSwarmDefinitionResult =
  | { definitionId: string }
  | { error: string };

/**
 * Create or refresh the graph definition backing a swarm group, then bind it
 * to the group. Idempotent: the definition is only re-registered when the
 * seats (or their prompts/order) actually changed, detected via the existing
 * manifest hash. Also self-heals groups whose `graph_definition_id` is NULL
 * (created before this wiring existed) on their first message.
 */
export function ensureSwarmDefinition(
  group: RegisteredGroup & { jid: string },
): EnsureSwarmDefinitionResult {
  const seats = listGroupSeats(group.jid);
  if (speakingSeats(seats).length === 0) {
    return { error: '群组没有可发言的席位（speak_policy != silent）' };
  }

  const desired = buildSwarmDefinition(group, seats, (agentDefId) =>
    !!getAgentDefinition(agentDefId, group.created_by ?? ''),
  );

  const latest = getLatestGraphDefinition(desired.id);
  const unchanged =
    !!latest &&
    latest.manifest_hash ===
      computeManifestHash({ ...desired, version: latest.version });

  if (!unchanged) {
    registerDefinition(desired, group.created_by ?? undefined);
    setSwarmGroupDefinitionId(group.jid, desired.id);
  } else if (group.graphDefinitionId !== desired.id) {
    setSwarmGroupDefinitionId(group.jid, desired.id);
  }

  return { definitionId: desired.id };
}
