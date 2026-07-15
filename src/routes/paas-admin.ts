/**
 * Agent PaaS: admin-only endpoints (Phase 2 + Phase 3).
 *
 * Currently: Agent quota management + review reports. Mounted at /api/paas/admin/*.
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, adminRoleMiddleware } from '../middleware/auth.js';
import { listUserAgentQuotas, updateUserAgentQuota, listPendingReviewReports, resolveReviewReport } from '../db.js';

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

// Phase 3: GET /api/paas/admin/review-reports — list pending review reports
paasAdminRoute.get('/review-reports', (c) => {
  const rows = listPendingReviewReports();
  return c.json({
    reports: rows.map((r) => ({
      id: r.id,
      review_id: r.review_id,
      reporter_id: r.reporter_id,
      reporter_username: r.reporter_username ?? r.reporter_id.slice(0, 8),
      reason: r.reason,
      status: r.status,
      created_at: r.created_at,
      review: {
        rating: r.rating,
        comment: r.comment,
        item_id: r.item_id,
        item_name: r.item_name,
      },
    })),
  });
});

// Phase 3: POST /api/paas/admin/review-reports/:id/resolve — resolve a report
paasAdminRoute.post('/review-reports/:id/resolve', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const action = body.action === 'delete_review' ? 'delete_review' : 'dismiss';
  const ok = resolveReviewReport(id, action, user.id);
  if (!ok) {
    return c.json({ error: 'Report not found or already resolved' }, 404);
  }
  return c.json({ success: true, action });
});

export default paasAdminRoute;
