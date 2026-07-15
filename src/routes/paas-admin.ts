/**
 * Agent PaaS: admin-only endpoints (Phase 2).
 *
 * Currently: Agent quota management. Mounted at /api/paas/admin/*.
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, adminRoleMiddleware } from '../middleware/auth.js';
import { listUserAgentQuotas, updateUserAgentQuota } from '../db.js';

export const paasAdminRoute = new Hono<{ Variables: Variables }>();

paasAdminRoute.use('*', authMiddleware);
paasAdminRoute.use('*', adminRoleMiddleware);

// GET /api/paas/admin/quotas — list all users' Agent quotas + usage
paasAdminRoute.get('/quotas', (c) => {
  const rows = listUserAgentQuotas();
  return c.json({
    quotas: rows.map((r) => ({
      user_id: r.user_id,
      username: r.username,
      quota: r.agent_quota,
      used: r.used,
    })),
  });
});

// PUT /api/paas/admin/quotas/:userId — adjust single user's quota
paasAdminRoute.put('/quotas/:userId', async (c) => {
  const userId = c.req.param('userId');
  const body = await c.req.json().catch(() => ({}));
  const quota = Number(body.quota);
  if (!Number.isInteger(quota) || quota < 0 || quota > 10000) {
    return c.json({ error: 'quota must be an integer 0-10000' }, 400);
  }
  updateUserAgentQuota(userId, quota);
  return c.json({ success: true, user_id: userId, quota });
});

export default paasAdminRoute;
