// Long-running Supervisor Agent — REST routes.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createSupervisorSessionFromInput,
  getSupervisorSessionById,
  listSupervisorSessionsFor,
  updateSupervisorSessionFromInput,
  deleteSupervisorSessionById,
  listDecisionsForSession,
  runSupervisionCheck,
  type SupervisorCheckDeps,
} from '../supervisor-agent.js';
import { logger } from '../logger.js';

// Injected at boot via setSupervisorDeps(...) — the same deps object the tick
// loop uses (getRecentMessages, sdkQuery, storePromptMessage,
// enqueueMessageCheck, notifyUser, getBoundLoopSummary).
let injectedDeps: SupervisorCheckDeps | null = null;

export function setSupervisorDeps(deps: SupervisorCheckDeps): void {
  injectedDeps = deps;
}

function getDeps(): SupervisorCheckDeps {
  if (!injectedDeps) {
    throw new Error('Supervisor deps not initialized');
  }
  return injectedDeps;
}

const supervisorRoutes = new Hono<{ Variables: Variables }>();

supervisorRoutes.use('*', authMiddleware);

/** POST /api/supervisor — create a session. */
supervisorRoutes.post('/', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const groupFolder = typeof body.group_folder === 'string' ? body.group_folder : null;
  const chatJid = typeof body.chat_jid === 'string' ? body.chat_jid : null;
  const goal = typeof body.goal_text === 'string' ? body.goal_text.trim() : '';
  const success = typeof body.success_criteria === 'string' ? body.success_criteria.trim() : '';
  if (!groupFolder || !chatJid || !goal || !success) {
    return c.json(
      { error: 'group_folder, chat_jid, goal_text, success_criteria 必填' },
      400,
    );
  }
  try {
    const session = createSupervisorSessionFromInput({
      group_folder: groupFolder,
      chat_jid: chatJid,
      owner_user_id: authUser.id,
      goal_text: goal,
      success_criteria: success,
      strategy: body.strategy,
      period_ms: body.period_ms,
      max_checks: body.max_checks,
      bound_loop_run_id: body.bound_loop_run_id ?? null,
      created_by: authUser.id,
    });
    return c.json({ session }, 201);
  } catch (err: any) {
    const status = err.statusCode ?? 500;
    return c.json({ error: err.message }, status);
  }
});

/** GET /api/supervisor — list current user's sessions. */
supervisorRoutes.get('/', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const status = c.req.query('status') as string | undefined;
  const chatJid = c.req.query('chat_jid') as string | undefined;
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const sessions = listSupervisorSessionsFor(authUser.id, { status, chatJid, limit, offset });
  return c.json({ sessions });
});

/** GET /api/supervisor/:id — session detail + recent decisions. */
supervisorRoutes.get('/:id', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const session = getSupervisorSessionById(id);
  if (!session) {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  if (session.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  const decisions = listDecisionsForSession(id, { limit: 50 });
  return c.json({ session, decisions });
});

/** PATCH /api/supervisor/:id — update config / toggle enabled. */
supervisorRoutes.patch('/:id', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const session = getSupervisorSessionById(id);
  if (!session) {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  if (session.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  try {
    const updated = updateSupervisorSessionFromInput(id, {
      goal_text: typeof body.goal_text === 'string' ? body.goal_text : undefined,
      success_criteria:
        typeof body.success_criteria === 'string' ? body.success_criteria : undefined,
      strategy: body.strategy,
      period_ms: body.period_ms,
      max_checks: body.max_checks,
      bound_loop_run_id: body.bound_loop_run_id,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    });
    return c.json({ session: updated });
  } catch (err: any) {
    const status = err.statusCode ?? 500;
    return c.json({ error: err.message }, status);
  }
});

/** DELETE /api/supervisor/:id — delete (active requires ?force=true or pause first). */
supervisorRoutes.delete('/:id', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const session = getSupervisorSessionById(id);
  if (!session) {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  if (session.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  const force = c.req.query('force') === 'true';
  try {
    deleteSupervisorSessionById(id, { force });
    return c.json({ ok: true });
  } catch (err: any) {
    const status = err.statusCode ?? 500;
    return c.json({ error: err.message }, status);
  }
});

/** POST /api/supervisor/:id/check — manual trigger. */
supervisorRoutes.post('/:id/check', async (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const session = getSupervisorSessionById(id);
  if (!session) {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  if (session.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  try {
    const deps = getDeps();
    const outcome = await runSupervisionCheck(id, deps, 'manual');
    if (!outcome) {
      return c.json({ ok: false, reason: 'session not active or completed' });
    }
    return c.json({ ok: true, decision: outcome.decision, fedBack: outcome.fedBack });
  } catch (err) {
    logger.error({ err, sessionId: id }, 'Manual supervisor check failed');
    return c.json({ error: (err as Error).message }, 500);
  }
});

/** GET /api/supervisor/:id/decisions — decision timeline (paginated). */
supervisorRoutes.get('/:id/decisions', (c) => {
  const authUser = c.get('user') as import('../types.js').AuthUser;
  const id = c.req.param('id');
  const session = getSupervisorSessionById(id);
  if (!session) {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  if (session.owner_user_id !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Supervisor not found' }, 404);
  }
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const decisions = listDecisionsForSession(id, { limit, offset });
  return c.json({ decisions });
});

export default supervisorRoutes;
