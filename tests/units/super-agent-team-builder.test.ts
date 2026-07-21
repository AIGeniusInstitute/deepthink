import { describe, expect, test } from 'vitest';

import {
  parseTeamPlan,
  validatePlanIntegrity,
  type TeamTaskInput,
} from '../../src/agent-team/team-plan.js';
import { assembleGraphDefinition } from '../../src/agent-team/team-builder.js';

const baseInput: TeamTaskInput = {
  goalText: '调研X并实现Y原型并写测试',
  acceptanceCriteria: '测试通过且报告含X',
  ownerUserId: 'u1',
  groupFolder: 'main',
  chatJid: 'feishu:t1',
};

const validPlanJson = JSON.stringify({
  teamName: 'demo',
  members: [
    {
      name: 'researcher',
      role: '调研员',
      systemPrompt: '你是调研员，负责调研。',
      engine: 'claude',
      model: null,
      skills: [],
      mcpServers: [],
      maxTurns: 15,
      deliverable: '调研报告',
    },
    {
      name: 'implementer',
      role: '实现者',
      systemPrompt: '你是实现者，负责编码。',
      engine: 'claude',
      model: null,
      skills: [],
      mcpServers: [],
      maxTurns: 25,
      deliverable: '可运行原型',
    },
  ],
  graph: {
    nodes: [
      { id: 'research', type: 'agent', title: '调研', agentMember: 'researcher', deliverable: '调研报告', dependsOn: [] },
      { id: 'impl', type: 'agent', title: '实现', agentMember: 'implementer', deliverable: '原型', dependsOn: ['research'] },
      {
        id: 'accept',
        type: 'gate',
        title: '验收',
        successCriteria: '测试通过且报告含X',
        upstreamNodeId: 'impl',
        assertions: [{ kind: 'contains', value: '测试通过' }],
        shellCheck: 'echo ok',
        dependsOn: ['impl'],
      },
    ],
  },
  acceptanceCriteria: '测试通过且报告含X',
});

describe('super-agent-team C4: parseTeamPlan + integrity (TC1/TC2)', () => {
  test('TC1 — valid plan parses', () => {
    const plan = parseTeamPlan(validPlanJson);
    expect(plan).not.toBeNull();
    expect(plan!.members).toHaveLength(2);
    expect(plan!.graph.nodes).toHaveLength(3);
    expect(validatePlanIntegrity(plan!)).toBe(true);
  });

  test('parseTeamPlan strips markdown fences', () => {
    const fenced = '```json\n' + validPlanJson + '\n```';
    const plan = parseTeamPlan(fenced);
    expect(plan).not.toBeNull();
    expect(plan!.teamName).toBe('demo');
  });

  test('TC2 — missing member reference → rejected', () => {
    const j = JSON.parse(validPlanJson);
    j.graph.nodes[0].agentMember = 'ghost';
    expect(parseTeamPlan(JSON.stringify(j))).toBeNull();
  });

  test('TC2 — cycle in dependsOn → rejected', () => {
    const j = JSON.parse(validPlanJson);
    // research depends on impl (which depends on research) → cycle
    j.graph.nodes[0].dependsOn = ['impl'];
    expect(parseTeamPlan(JSON.stringify(j))).toBeNull();
  });

  test('TC2 — dependsOn references nonexistent node → rejected', () => {
    const j = JSON.parse(validPlanJson);
    j.graph.nodes[1].dependsOn = ['nonexistent'];
    expect(parseTeamPlan(JSON.stringify(j))).toBeNull();
  });

  test('TC2 — no agent node → rejected', () => {
    const j = JSON.parse(validPlanJson);
    j.graph.nodes = [{ id: 'g', type: 'gate', title: 'g', dependsOn: [] }];
    expect(parseTeamPlan(JSON.stringify(j))).toBeNull();
  });

  test('TC2 — malformed JSON → rejected', () => {
    expect(parseTeamPlan('not json')).toBeNull();
    expect(parseTeamPlan(null)).toBeNull();
  });
});

describe('super-agent-team C4: assembleGraphDefinition (TC3/TC4)', () => {
  test('agent nodes carry agentDefId + goalAnchor; gate carries assertions/shellCheck', () => {
    const plan = parseTeamPlan(validPlanJson)!;
    const memberDefIds = { researcher: 'def-r', implementer: 'def-i' };
    const def = assembleGraphDefinition(plan, memberDefIds, baseInput);

    const researchNode = def.nodes.find((n) => n.id === 'research')!;
    expect(researchNode.agentDefId).toBe('def-r');
    expect(researchNode.agentMember).toBe('researcher');
    expect(researchNode.goalAnchor).toContain('调研X并实现Y原型并写测试');
    expect(researchNode.goalAnchor).toContain('测试通过且报告含X');
    expect(researchNode.goalAnchor).toContain('调研员');
    expect(researchNode.prompt).toContain('调研报告');

    const implNode = def.nodes.find((n) => n.id === 'impl')!;
    expect(implNode.agentDefId).toBe('def-i');
    expect(implNode.goalAnchor).toContain('实现者');

    const acceptNode = def.nodes.find((n) => n.id === 'accept')!;
    expect(acceptNode.type).toBe('gate');
    expect(acceptNode.assertions![0]).toEqual({ kind: 'contains', value: '测试通过' });
    expect(acceptNode.shellCheck).toBe('echo ok');
    expect(acceptNode.upstreamNodeId).toBe('impl');
  });

  test('edges derived from dependsOn', () => {
    const plan = parseTeamPlan(validPlanJson)!;
    const def = assembleGraphDefinition(plan, { researcher: 'r', implementer: 'i' }, baseInput);
    expect(def.edges.some((e) => e.from === 'research' && e.to === 'impl')).toBe(true);
    expect(def.edges.some((e) => e.from === 'impl' && e.to === 'accept')).toBe(true);
  });

  test('acceptance gate backstop appended when no evidence gate exists', () => {
    const j = JSON.parse(validPlanJson);
    // remove the gate entirely
    j.graph.nodes = j.graph.nodes.filter((n: { type: string }) => n.type === 'agent');
    const plan = parseTeamPlan(JSON.stringify(j))!;
    const def = assembleGraphDefinition(plan, { researcher: 'r', implementer: 'i' }, baseInput);
    const gate = def.nodes.find((n) => n.type === 'gate');
    expect(gate).toBeTruthy();
    expect(gate!.assertions!.length).toBeGreaterThan(0);
    expect(gate!.upstreamNodeId).toBe('impl');
  });

  test('throws on agent node referencing missing member def id', () => {
    const plan = parseTeamPlan(validPlanJson)!;
    // implementer has no def id
    expect(() => assembleGraphDefinition(plan, { researcher: 'r' }, baseInput)).toThrow();
  });
});
