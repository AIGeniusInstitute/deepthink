import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { GraphDefinition, GraphNode, GraphEdge } from '../../src/graph-engineering/graph-types.js';

// Dynamic import: we must set DEEPTHINK_DATA_DIR BEFORE db.ts (and its
// graph-engineering dependents) load, otherwise config.ts computes DATA_DIR
// from the production path at static-import time. Static imports are hoisted,
// so we import the modules dynamically inside beforeAll after setting env.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-approval-'));
process.env.DEEPTHINK_DATA_DIR = tmpDir;

let db: typeof import('../../src/db.js');
let registry: typeof import('../../src/graph-engineering/graph-registry.js');
let orchestrator: typeof import('../../src/graph-engineering/graph-orchestrator.js');

beforeAll(async () => {
  db = await import('../../src/db.js');
  registry = await import('../../src/graph-engineering/graph-registry.js');
  orchestrator = await import('../../src/graph-engineering/graph-orchestrator.js');
  db.initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const baseNodes: GraphNode[] = [
  { id: 'work', type: 'agent', title: '干活', prompt: 'do the work' },
  {
    id: 'approve1',
    type: 'human',
    title: '审批',
    approvalPrompt: '是否继续？',
    approvalOptions: [
      { label: '批准', value: 'approve' },
      { label: '拒绝', value: 'reject' },
    ],
  },
];
const baseEdges: GraphEdge[] = [{ id: 'e1', from: 'work', to: 'approve1' }];

let runCounter = 0;
function setupRun(): string {
  runCounter++;
  const def: GraphDefinition = {
    id: 'team-approval',
    version: 1,
    name: 'team-approval',
    nodes: baseNodes,
    edges: baseEdges,
  };
  registry.registerDefinition(def);
  const runId = `run-approval-${runCounter}`;
  db.createGraphRun({
    id: runId,
    definition_id: 'team-approval',
    definition_version: 1,
    owner_user_id: 'u1',
    group_folder: 'main',
    chat_jid: 'web:main',
    started_at: new Date().toISOString(),
  });
  // Simulate the orchestrator pausing at the human node: run paused + the
  // human node_run created then flipped to 'paused'.
  db.updateGraphRunStatus(runId, 'paused');
  const nodeRunId = db.createGraphNodeRun({
    id: `nr-approve1-${runCounter}`,
    graph_run_id: runId,
    node_id: 'approve1',
    node_type: 'human',
  });
  db.updateGraphNodeRun(nodeRunId, { status: 'paused' });
  return runId;
}

describe('super-agent-team P1: human approval closed loop (TC15-TC18)', () => {
  test('TC15 — approve marks the human node completed + writes decision into state', () => {
    const runId = setupRun();
    const result = orchestrator.approveHumanNode(runId, 'approve1', 'approve', 'go');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stateKey).toBe('node_approve1_approval');

    const nodeRun = db.getLatestGraphNodeRun(runId, 'approve1');
    expect(nodeRun?.status).toBe('completed');
    const patch = JSON.parse(nodeRun?.state_patch_json ?? '{}');
    expect(patch.node_approve1_approval).toBe('approve');
    expect(patch.node_approve1_approval__note).toBe('go');

    const run = db.getGraphRun(runId);
    const state = JSON.parse(run?.state_json ?? '{}');
    expect(state.node_approve1_approval).toBe('approve');
    // Run stays paused for the caller to resume (approve does not resume itself).
    expect(run?.status).toBe('paused');
  });

  test('TC16 — after approve, resume skip-set includes the human node (no re-pause)', () => {
    const runId = setupRun();
    orchestrator.approveHumanNode(runId, 'approve1', 'approve');
    // The core fix for the P0 infinite re-pause: a completed human node is in
    // getCompletedGraphNodeIds, so computeReadyNodes will NOT re-emit it.
    const completed = db.getCompletedGraphNodeIds(runId);
    expect(completed.has('approve1')).toBe(true);
  });

  test('TC17 — approve rejects when the run is not paused', () => {
    const runId = setupRun();
    // Flip the run to running (simulating a race); approve must refuse.
    db.updateGraphRunStatus(runId, 'running');
    const result = orchestrator.approveHumanNode(runId, 'approve1', 'approve');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not paused');
    }
  });

  test('TC18 — approve rejects when the node is not a human node', () => {
    const runId = setupRun();
    const agentNodeRun = db.createGraphNodeRun({
      id: `nr-work-${runCounter}`,
      graph_run_id: runId,
      node_id: 'work',
      node_type: 'agent',
    });
    db.updateGraphNodeRun(agentNodeRun, { status: 'paused' });
    const result = orchestrator.approveHumanNode(runId, 'work', 'approve');
    expect(result.ok).toBe(false);
  });
});

describe('super-agent-team P1: dynamic re-plan (TC19)', () => {
  test('TC19 — repoint run to a new definition version; resume loads new version', () => {
    const def: GraphDefinition = {
      id: 'team-replan',
      version: 1,
      name: 'team-replan',
      nodes: baseNodes,
      edges: baseEdges,
    };
    registry.registerDefinition(def);
    const runId = 'run-replan-1';
    db.createGraphRun({
      id: runId,
      definition_id: 'team-replan',
      definition_version: 1,
      owner_user_id: 'u1',
      group_folder: 'main',
      chat_jid: 'web:main',
      started_at: new Date().toISOString(),
    });

    // Register v2 with an extra downstream node.
    const v2Nodes: GraphNode[] = [
      ...baseNodes,
      { id: 'extra', type: 'agent', title: '额外', prompt: 'extra work' },
    ];
    const v2Edges: GraphEdge[] = [
      ...baseEdges,
      { id: 'e2', from: 'approve1', to: 'extra' },
    ];
    registry.registerDefinition({
      id: 'team-replan',
      version: 2,
      name: 'team-replan',
      nodes: v2Nodes,
      edges: v2Edges,
    });

    db.repointGraphRunDefinition(runId, 'team-replan', 2);

    const run = db.getGraphRun(runId);
    expect(run?.definition_version).toBe(2);
    const defRow = db.getGraphDefinition('team-replan', 2);
    expect(defRow).toBeDefined();
    const v2NodeIds = (JSON.parse(defRow!.nodes_json) as GraphNode[]).map((n) => n.id);
    expect(v2NodeIds).toContain('extra');
  });
});
