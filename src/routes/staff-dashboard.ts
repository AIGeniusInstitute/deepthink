// Staff dashboard — aggregate statistics for the workbench overview.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  listStaffEmployees,
  listStaffTeams,
  listStaffTeamTasks,
} from '../db.js';

export const staffDashboardRoutes = new Hono<{ Variables: Variables }>();
staffDashboardRoutes.use('*', authMiddleware);

staffDashboardRoutes.get('/', (c) => {
  const user = c.get('user') as AuthUser;
  const employees = listStaffEmployees(user.id, false);
  const teams = listStaffTeams(user.id);

  // Aggregate task stats across all teams
  let totalTasks = 0;
  const statusCounts: Record<string, number> = {
    pending: 0, in_progress: 0, review: 0, done: 0, rework: 0,
  };
  for (const t of teams) {
    const tasks = listStaffTeamTasks(t.id);
    totalTasks += tasks.length;
    for (const task of tasks) {
      if (statusCounts[task.status] !== undefined) {
        statusCounts[task.status]++;
      }
    }
  }

  return c.json({
    employeeCount: employees.length,
    teamCount: teams.length,
    taskStats: { total: totalTasks, ...statusCounts },
  });
});
