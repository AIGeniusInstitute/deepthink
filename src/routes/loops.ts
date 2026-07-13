// Loop Engineering routes

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getLoopRun,
  listLoopRuns,
  listLoopIterations,
  listLoopTraceNodes,
  updateLoopTraceNode,
} from '../db.js';
import { cancelLoopRun } from '../loop-orchestrator.js';
import { logger } from '../logger.js';

const loopsRoutes = new Hono<{ Variables: Variables }>();

// All routes require authentication
loopsRoutes.use('*', authMiddleware);

/** GET /api/loops — list current user's loop_runs. */
loopsRoutes.get('/', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const status = c.req.query('status') as string | undefined;
  const kind = c.req.query('kind') as string | undefined;
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const runs = listLoopRuns(authUser.id, { status, kind, limit, offset });
  return c.json({ loops: runs });
});

/** GET /api/loops/:id — loop_run + iterations + trace_nodes. */
loopsRoutes.get('/:id', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getLoopRun(id);
  if (!run) {
    return c.json({ error: 'Loop not found' }, 404);
  }
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Loop not found' }, 404);
  }
  const iterations = listLoopIterations(id);
  const traceNodes = listLoopTraceNodes(id);
  return c.json({ loop: run, iterations, traceNodes });
});

/** POST /api/loops/:id/cancel — cancel a running loop. */
loopsRoutes.post('/:id/cancel', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getLoopRun(id);
  if (!run) {
    return c.json({ error: 'Loop not found' }, 404);
  }
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Loop not found' }, 404);
  }
  try {
    await cancelLoopRun(id, `Cancelled via Web by ${authUser.username}`);
    return c.json({ ok: true, status: 'cancelled' });
  } catch (err) {
    logger.error({ err, loopRunId: id }, 'Failed to cancel loop');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/** GET /api/loops/:id/usage — token usage aggregated by iteration. */
loopsRoutes.get('/:id/usage', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getLoopRun(id);
  if (!run) {
    return c.json({ error: 'Loop not found' }, 404);
  }
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Loop not found' }, 404);
  }
  const iterations = listLoopIterations(id);
  const byIteration = iterations.map((it) => ({
    iteration: it.turn_index,
    input_tokens: it.input_tokens,
    output_tokens: it.output_tokens,
    cost_usd: it.cost_usd,
    review_result: it.review_result,
  }));
  return c.json({
    loop_run_id: id,
    total_input_tokens: run.total_input_tokens,
    total_output_tokens: run.total_output_tokens,
    total_cost_usd: run.total_cost_usd,
    by_iteration: byIteration,
  });
});

/** GET /api/loops/:id/trace — trace_nodes as a tree. */
loopsRoutes.get('/:id/trace', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const run = getLoopRun(id);
  if (!run) {
    return c.json({ error: 'Loop not found' }, 404);
  }
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Loop not found' }, 404);
  }
  const nodes = listLoopTraceNodes(id);
  // Build tree
  const nodeMap = new Map<number, any>();
  const roots: any[] = [];
  for (const n of nodes) {
    nodeMap.set(n.id, { ...n, children: [] });
  }
  for (const n of nodes) {
    const node = nodeMap.get(n.id)!;
    if (n.parent_node_id && nodeMap.has(n.parent_node_id)) {
      nodeMap.get(n.parent_node_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return c.json({ loop_run_id: id, roots });
});

/** PATCH /api/loops/:id/trace/:nodeId — edit a trace node's output_summary.
 *  Only allowed when the owning loop_run is in a terminal state (completed /
 *  failed / cancelled), to avoid polluting an active execution. Records
 *  edited_at so the original value can be surfaced if needed. */
loopsRoutes.patch('/:id/trace/:nodeId', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const nodeId = parseInt(c.req.param('nodeId'), 10);
  const run = getLoopRun(id);
  if (!run) {
    return c.json({ error: 'Loop not found' }, 404);
  }
  if (run.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Loop not found' }, 404);
  }
  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
    return c.json({ error: '只能编辑已结束循环的 trace 节点' }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const outputSummary = typeof body.output_summary === 'string' ? body.output_summary.slice(0, 8000) : null;
  if (outputSummary === null) {
    return c.json({ error: 'output_summary 字段必填' }, 400);
  }
  try {
    updateLoopTraceNode(nodeId, {
      output_summary: outputSummary,
      edited_at: new Date().toISOString(),
    });
    return c.json({ ok: true, nodeId });
  } catch (err) {
    logger.error({ err, loopRunId: id, nodeId }, 'Failed to edit trace node');
    return c.json({ error: (err as Error).message }, 500);
  }
});

export default loopsRoutes;
