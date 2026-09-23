// Agent Group Chat (swarm) — seat → graph definition.
//
// A swarm group's execution model IS a graph definition: one agent node per
// speaking seat, chained by seat_order. These tests pin the shape the runner
// and the seat-output hook depend on (`seat-<id>` node ids, linear edges).

import { describe, expect, test } from 'vitest';
import {
  SEAT_NODE_PREFIX,
  buildSwarmDefinition,
  seatIdFromNodeId,
  speakingSeats,
  swarmDefinitionId,
} from '../../src/agent-group/swarm-definition.js';
import { validateDefinition } from '../../src/graph-engineering/graph-registry.js';
import type { GroupSeatRow } from '../../src/db.js';

const seat = (over: Partial<GroupSeatRow> = {}): GroupSeatRow => ({
  id: 1,
  group_id: 'web:swarm:abc',
  agent_definition_id: '唯心主义者',
  agent_version: 'latest',
  role_prompt: '你坚持意识第一性。',
  speak_policy: 'auto',
  mounts: '{}',
  max_turns: 10,
  token_budget: 100000,
  time_budget_ms: 600000,
  max_parallel: 1,
  seat_order: 0,
  created_at: '2026-09-23T00:00:00.000Z',
  ...over,
});

const group = { jid: 'web:swarm:abc', name: '唯心唯物辩论', folder: 'swarm-0beb99c4' };

describe('swarm-definition', () => {
  test('definition id is derived from the (unique) group folder', () => {
    expect(swarmDefinitionId('swarm-0beb99c4')).toBe('swarm-swarm-0beb99c4');
  });

  test('seatIdFromNodeId round-trips seat node ids and rejects others', () => {
    expect(seatIdFromNodeId('seat-7')).toBe(7);
    expect(seatIdFromNodeId('agent-1')).toBeNull();
    expect(seatIdFromNodeId('seat-')).toBeNull();
    expect(seatIdFromNodeId('seat-abc')).toBeNull();
  });

  test('speakingSeats drops silent seats only', () => {
    const seats = [
      seat({ id: 1, speak_policy: 'auto' }),
      seat({ id: 2, speak_policy: 'silent' }),
      seat({ id: 3, speak_policy: 'mention_only' }),
    ];
    expect(speakingSeats(seats).map(s => s.id)).toEqual([1, 3]);
  });

  test('one agent node per speaking seat, ids carry the seat id, edge per hop', () => {
    const def = buildSwarmDefinition(
      group,
      [seat({ id: 11 }), seat({ id: 22, role_prompt: '你坚持物质第一性。' }), seat({ id: 33, speak_policy: 'silent' })],
      () => false,
    );
    expect(def.id).toBe('swarm-swarm-0beb99c4');
    expect(def.name).toBe('swarm: 唯心唯物辩论');
    expect(def.nodes.map(n => n.id)).toEqual(['seat-11', 'seat-22']);
    expect(def.nodes.every(n => n.type === 'agent')).toBe(true);
    expect(def.edges).toEqual([
      { id: 'seat-11->seat-22', from: 'seat-11', to: 'seat-22', type: 'data' },
    ]);
    expect(validateDefinition(def).ok).toBe(true);
  });

  test('seat persona is carried in the node prompt (agent_definitions lookup is unreliable)', () => {
    const [node] = buildSwarmDefinition(group, [seat({ id: 11 })], () => false).nodes;
    expect(node.prompt).toContain('唯心唯物辩论');
    expect(node.prompt).toContain('你坚持意识第一性。');
    expect(node.agentDefId).toBeUndefined();
  });

  test('agentDefId is bound only when it resolves to a real agent definition', () => {
    const [resolved] = buildSwarmDefinition(group, [seat({ id: 11 })], () => true).nodes;
    expect(resolved.agentDefId).toBe('唯心主义者');
    expect(resolved.agentMember).toBe('你坚持意识第一性。');

    const [unresolved] = buildSwarmDefinition(group, [seat({ id: 11 })], () => false).nodes;
    expect(unresolved.agentDefId).toBeUndefined();
  });

  test('node title falls back to the agent id when role_prompt is empty', () => {
    const [node] = buildSwarmDefinition(group, [seat({ id: 11, role_prompt: '' })], () => false).nodes;
    expect(node.title).toBe('唯心主义者');
    expect(node.prompt).not.toContain('【角色设定】');
  });

  test('a single speaking seat produces a valid edgeless definition', () => {
    const def = buildSwarmDefinition(group, [seat({ id: 11 })], () => false);
    expect(def.edges).toEqual([]);
    expect(validateDefinition(def).ok).toBe(true);
  });

  test('node id prefix is the one the output hook parses', () => {
    const def = buildSwarmDefinition(group, [seat({ id: 11 })], () => false);
    expect(def.nodes[0].id.startsWith(SEAT_NODE_PREFIX)).toBe(true);
  });
});
