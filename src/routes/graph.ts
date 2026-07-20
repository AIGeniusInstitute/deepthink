// Graph Engineering routes.
//
// Mirrors routes/loops.ts. List/detail/pause/cancel/rerun hit the DB directly
// (no orchestrator deps needed). Start + resume go through WebDeps
// (startGraphRun / resumeGraphRun), wired in index.ts where full GraphDeps
// (queue, broadcastStreamEvent, sendMessage) are in scope — same pattern as
// triggerTaskRun.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getWebDeps } from '../web-context.js';
import {
  getGraphRun,
  listGraphRuns,
  listGraphNodeRuns,
  listGraphDefinitions,
} from '../db.js';
import {
  deserializeDefinition,
  registerDefinition,
  toMermaid,
} from '../graph-engineering/graph-registry.js';
import {
  cancelGraphRun,
  pauseGraphRun,
  rerunGraphNode,
} from '../graph-engineering/graph-orchestrator.js';
import { logger } from '../logger.js';

export const graphRoutes = new Hono<{ Variables: Variables }>();

graphRoutes.use('*', authMiddleware);

/** GET /api/graph/definitions — list latest active graph definitions. */
graphRoutes.get('/definitions', (c) => {
  const rows = listGraphDefinitions();
  const defs = rows.map((r) => ({
    id: r.id,
    version: r.version,
    name: r.name,
    description: r.description,
    nodeCount: (JSON.parse(r.nodes_json) as unknown[]).length,
    createdAt: r.created_at,
  }));
  return c.json({ definitions: defs });
});

/** GET /api/graph/definitions/:id — definition detail + Mermaid export (AC1.3). */
graphRoutes.get('/definitions/:id', (c) => {
  const id = c.req.param('id');
  const row = listGraphDefinitions().find((r) => r.id === id);
  if (!row) return c.json({ error: 'Definition not found' }, 404);
  const def = deserializeDefinition(row);
  return c.json({ definition: def, mermaid: toMermaid(def) });
});

/** POST /api/graph/definitions — register a new version of a graph definition. */
graphRoutes.post('/definitions', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'admin only' }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body?.id || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    return c.json({ error: 'Missing id/nodes/edges' }, 400);
  }
  try {
    const { key, hash } = registerDefinition({
      id: body.id,
      version: body.version ?? 1,
      name: body.name ?? body.id,
      description: body.description,
      nodes: body.nodes,
      edges: body.edges,
      stateSchema: body.stateSchema,
    });
    return c.json({ ok: true, key, hash });
  } catch (err) {
    logger.error({ err }, 'Failed to register graph definition');
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** GET /api/graph/runs — list current user's graph runs. */
graphRoutes.get('/runs', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const status = c.req.query('status');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const runs = listGraphRuns(authUser.id, { status, limit, offset });
  return c.json({ runs });
});

/** POST /api/graph/runs — start a new graph run (AC3.4 start). */
graphRoutes.post('/runs', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const body = await c.req.json().catch(() => null);
  if (!body?.definitionId || !body.groupFolder || !body.chatJid) {
    return c.json({ error: 'Missing definitionId/groupFolder/chatJid' }, 400);
  }
  const webDeps = getWebDeps();
  if (!webDeps?.startGraphRun) {
    return c.json({ error: 'Graph execution not initialized' }, 503);
  }
  const result = webDeps.startGraphRun({
    definitionId: body.definitionId,
    ownerUserId: authUser.id,
    groupFolder: body.groupFolder,
    chatJid: body.chatJid,
    goalText: body.goalText,
    maxParallel: body.maxParallel,
    initialState: body.initialState,
  });
  if (!result.success) {
    return c.json({ error: result.error ?? 'Failed to start graph run' }, 400);
  }
  return c.json({ ok: true, runId: result.runId });
});

/** GET /api/graph/runs/:id — graph run + node_runs tree. */
graphRoutes.get('/runs/:id', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const nodes = listGraphNodeRuns(id);
  return c.json({ run, nodeRuns: nodes });
});

/** POST /api/graph/runs/:id/resume — resume from checkpoint (AC3.4). */
graphRoutes.post('/runs/:id/resume', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  if (run.status !== 'paused' && run.status !== 'failed') {
    return c.json({ error: `Cannot resume run in status '${run.status}'` }, 400);
  }
  const webDeps = getWebDeps();
  if (!webDeps?.resumeGraphRun) {
    return c.json({ error: 'Graph execution not initialized' }, 503);
  }
  const result = webDeps.resumeGraphRun(id);
  return result.success
    ? c.json({ ok: true, status: 'running' })
    : c.json({ error: result.error ?? 'Failed to resume' }, 400);
});

/** POST /api/graph/runs/:id/pause — pause at next node boundary (AC4.1). */
graphRoutes.post('/runs/:id/pause', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  pauseGraphRun(id);
  return c.json({ ok: true, status: 'paused' });
});

/** POST /api/graph/runs/:id/cancel — cancel (AC4.3). */
graphRoutes.post('/runs/:id/cancel', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  cancelGraphRun(id, `Cancelled via Web by ${authUser.username}`);
  return c.json({ ok: true, status: 'cancelled' });
});

/** POST /api/graph/runs/:id/nodes/:nodeId/rerun — rerun node + downstream (AC4.4). */
graphRoutes.post('/runs/:id/nodes/:nodeId/rerun', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const nodeId = c.req.param('nodeId');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const changed = rerunGraphNode(id, nodeId);
  // Kick resume so the scheduler re-derives the ready queue.
  const webDeps = getWebDeps();
  webDeps?.resumeGraphRun?.(id);
  return c.json({ ok: true, resetNodes: changed });
});

/** GET /api/graph/runs/:id/usage — token/cost aggregated per node. */
graphRoutes.get('/runs/:id/usage', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getGraphRun(id);
  if (!run) return c.json({ error: 'Graph run not found' }, 404);
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Graph run not found' }, 404);
  }
  const nodes = listGraphNodeRuns(id);
  const byNode = nodes.map((n) => ({
    nodeId: n.node_id,
    attempt: n.attempt,
    status: n.status,
    inputTokens: n.input_tokens,
    outputTokens: n.output_tokens,
    costUsd: n.cost_usd,
  }));
  const totals = nodes.reduce(
    (acc, n) => {
      acc.inputTokens += n.input_tokens;
      acc.outputTokens += n.output_tokens;
      acc.costUsd += n.cost_usd;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  return c.json({ byNode, totals });
});
