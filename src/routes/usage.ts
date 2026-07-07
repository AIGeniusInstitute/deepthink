import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getUsageDailyStats,
  getUsageDailySummary,
  getUsageModels,
  getUsageUsers,
} from '../db.js';
import type { AuthUser } from '../types.js';

const usage = new Hono<{ Variables: Variables }>();

usage.use('*', authMiddleware);

/**
 * Resolve userId for queries:
 * - Admin can filter by any userId or see all (undefined = all)
 * - Member always sees only their own data
 */
function resolveUserId(
  user: AuthUser,
  requestedUserId?: string,
): string | undefined {
  if (user.role === 'admin') {
    return requestedUserId || undefined; // undefined = all users
  }
  return user.id; // member always sees only own data
}

/**
 * GET /api/usage/stats?days=7&userId=&model=
 * Returns aggregated token usage statistics from usage_daily_summary.
 * Fixes: token KPI (uses modelUsage data) + timezone (local date grouping).
 */
usage.get('/stats', (c) => {
  const user = c.get('user') as AuthUser;
  const daysParam = c.req.query('days');
  const days = daysParam
    ? Math.min(Math.max(parseInt(daysParam, 10) || 7, 1), 365)
    : 7;

  const userId = resolveUserId(user, c.req.query('userId') || undefined);
  const model = c.req.query('model') || undefined;

  const summary = getUsageDailySummary(days, userId, model);
  const breakdown = getUsageDailyStats(days, userId, model);

  // Compute actual data range for frontend display
  const dates = breakdown.map((r) => r.date);
  const uniqueDates = [...new Set(dates)].sort();
  const dataRange =
    uniqueDates.length > 0
      ? {
          from: uniqueDates[0],
          to: uniqueDates[uniqueDates.length - 1],
          activeDays: uniqueDates.length,
        }
      : null;

  return c.json({ summary, breakdown, days, dataRange });
});

/**
 * GET /api/usage/models
 * Returns list of all models that have usage data.
 */
usage.get('/models', (c) => {
  const models = getUsageModels();
  return c.json({ models });
});

/**
 * GET /api/usage/users
 * Returns list of users that have usage data. Admin only.
 */
usage.get('/users', (c) => {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') {
    return c.json({ users: [{ id: user.id, username: user.username }] });
  }
  const users = getUsageUsers();
  return c.json({ users });
});

export { usage };
