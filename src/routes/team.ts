// Super Agent Team routes.
//
// POST /api/team/runs: autonomously decompose a complex task into a team
// (Team Builder creates agent members + assembles a graph definition) and
// starts a graph run. Mirrors routes/graph.ts POST /runs but goes through
// webDeps.buildTeam (wired in index.ts where full GraphDeps are in scope).
// The returned runId is a standard graph_run, so /api/graph/runs/:id and the
// GraphPage visualization work unchanged.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getWebDeps } from '../web-context.js';
import { z } from 'zod';

export const teamRoutes = new Hono<{ Variables: Variables }>();

teamRoutes.use('*', authMiddleware);

const TeamRunBodySchema = z.object({
  goalText: z.string().min(1),
  background: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  groupFolder: z.string().min(1),
  chatJid: z.string().min(1),
  userLanguage: z.string().optional(),
});

/** POST /api/team/runs — build a Super Agent Team for a complex task. */
teamRoutes.post('/runs', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const body = await c.req.json().catch(() => null);
  const parsed = TeamRunBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body', detail: parsed.error.issues.map((i) => i.message).join('; ') },
      400,
    );
  }
  const webDeps = getWebDeps();
  if (!webDeps?.buildTeam) {
    return c.json({ error: 'Team builder not initialized' }, 503);
  }
  const result = await webDeps.buildTeam({
    goalText: parsed.data.goalText,
    background: parsed.data.background,
    acceptanceCriteria: parsed.data.acceptanceCriteria,
    ownerUserId: authUser.id,
    groupFolder: parsed.data.groupFolder,
    chatJid: parsed.data.chatJid,
    userLanguage: parsed.data.userLanguage ?? 'zh-CN',
  });
  if ('error' in result) {
    return c.json({ error: result.error, detail: result.detail }, 400);
  }
  return c.json({
    ok: true,
    runId: result.runId,
    plan: result.plan,
    memberDefIds: result.memberDefIds,
  });
});
