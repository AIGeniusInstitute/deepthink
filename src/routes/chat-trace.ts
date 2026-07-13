/**
 * Routes for chat trace node DAG visualization.
 *
 * Two endpoints:
 *   GET  /api/groups/:jid/trace/nodes              — list all nodes for a chat
 *   PUT  /api/groups/:jid/trace/nodes/:id/annotation — save user annotations
 *
 * Rerun / continue-from-here is implemented client-side: the DAG node detail
 * panel reads the node's input (annotation if present, else original
 * input_summary) and sends it as a normal user message via the existing
 * /api/messages endpoint. This keeps the message pipeline single-path and
 * avoids a redundant server-side enqueue path.
 *
 * All endpoints require auth and group access (canAccessGroup).
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup } from '../web-context.js';
import {
  listChatTraceNodes,
  getChatTraceNode,
  saveChatTraceNodeAnnotation,
  getRegisteredGroup,
} from '../db.js';

const router = new Hono<{ Variables: Variables }>();

router.use('*', authMiddleware);

router.get('/:jid/trace/nodes', async (c) => {
  const jid = c.req.param('jid');
  const user = c.get('user');
  const group = getRegisteredGroup(jid);
  if (!group || !canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'No access to this group' }, 403);
  }
  const nodes = listChatTraceNodes(jid);
  return c.json({ nodes });
});

router.put('/:jid/trace/nodes/:id/annotation', async (c) => {
  const jid = c.req.param('jid');
  const nodeId = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(nodeId) || nodeId <= 0) {
    return c.json({ error: 'Invalid node id' }, 400);
  }
  const user = c.get('user');
  const group = getRegisteredGroup(jid);
  if (!group || !canAccessGroup(user, { ...group, jid })) {
    return c.json({ error: 'No access to this group' }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid body' }, 400);
  }
  const { annotationInput, annotationOutput } = body as {
    annotationInput?: unknown;
    annotationOutput?: unknown;
  };
  const inputStr =
    typeof annotationInput === 'string' ? annotationInput : null;
  const outputStr =
    typeof annotationOutput === 'string' ? annotationOutput : null;
  const existing = getChatTraceNode(jid, nodeId);
  if (!existing) {
    return c.json({ error: 'Node not found' }, 404);
  }
  saveChatTraceNodeAnnotation(jid, nodeId, inputStr, outputStr);
  return c.json({ ok: true });
});

export default router;

