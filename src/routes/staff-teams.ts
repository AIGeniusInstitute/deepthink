// Team collaboration routes — persistent teams with members, task state
// machine, and shared blackboard.
//
// Unlike /api/collaborations (one-shot graph runs), teams are persistent
// organizational units. Team tasks follow a state machine:
//   pending → in_progress → review → done (or rework → in_progress loop)
//
// Access: team owner or admin for management; members can view/create tasks.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createStaffTeam, getStaffTeam, listStaffTeams, updateStaffTeam, deleteStaffTeam,
  addStaffTeamMember, removeStaffTeamMember, listStaffTeamMembers,
  createStaffTeamTask, getStaffTeamTask, listStaffTeamTasks,
  updateStaffTaskStatus, updateStaffTask, isValidTaskTransition,
  createStaffBlackboardEntry, listStaffBlackboard, updateStaffBlackboardEntry,
  addStaffTeamEvent, listStaffTeamEvents, listStaffTaskEvents,
  getStaffEmployee,
  type StaffEmployeeRow, type StaffTeamMemberRow,
} from '../db.js';

export const staffTeamRoutes = new Hono<{ Variables: Variables }>();
staffTeamRoutes.use('*', authMiddleware);

// --- Team CRUD ---

staffTeamRoutes.get('/', (c) => {
  const user = c.get('user') as AuthUser;
  const teams = listStaffTeams(user.id);
  // Augment with member count and task stats
  const enriched = teams.map((t) => {
    const members = listStaffTeamMembers(t.id);
    const tasks = listStaffTeamTasks(t.id);
    const taskStats = {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      in_progress: tasks.filter((t) => t.status === 'in_progress').length,
      review: tasks.filter((t) => t.status === 'review').length,
      done: tasks.filter((t) => t.status === 'done').length,
      rework: tasks.filter((t) => t.status === 'rework').length,
    };
    return { ...t, memberCount: members.length, taskStats };
  });
  return c.json({ teams: enriched });
});

staffTeamRoutes.post('/', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json();
  const name = typeof body.name === 'string' && body.name.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const id = createStaffTeam({
    ownerUserId: user.id, name,
    description: typeof body.description === 'string' ? body.description : '',
  });
  const team = getStaffTeam(id);
  return c.json({ team }, 201);
});

staffTeamRoutes.get('/:id', (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const members = listStaffTeamMembers(team.id);
  // Augment members with employee info
  const memberDetails = members.map((m: StaffTeamMemberRow) => {
    const emp = getStaffEmployee(m.employee_id);
    return { ...m, employee: emp };
  });
  return c.json({ team, members: memberDetails });
});

staffTeamRoutes.put('/:id', async (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = await c.req.json();
  const fields: { name?: string; description?: string } = {};
  if (typeof body.name === 'string') fields.name = body.name;
  if (typeof body.description === 'string') fields.description = body.description;
  updateStaffTeam(team.id, fields);
  return c.json({ team: getStaffTeam(team.id) });
});

staffTeamRoutes.delete('/:id', (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  deleteStaffTeam(team.id);
  return c.json({ ok: true });
});

// --- Team Members ---

staffTeamRoutes.post('/:id/members', async (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = await c.req.json();
  const employeeId = typeof body.employeeId === 'string' && body.employeeId.trim();
  if (!employeeId) return c.json({ error: 'employeeId is required' }, 400);
  const emp = getStaffEmployee(employeeId);
  if (!emp) return c.json({ error: 'employee not found' }, 404);
  if (emp.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const role = body.role === 'leader' ? 'leader' : 'member';
  addStaffTeamMember({
    teamId: team.id, employeeId, role, addedBy: user.id,
  });
  addStaffTeamEvent({
    teamId: team.id, employeeId, eventType: 'member_added',
    payloadJson: JSON.stringify({ role }), actorUserId: user.id,
  });
  return c.json({ ok: true }, 201);
});

staffTeamRoutes.delete('/:id/members/:employeeId', (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  removeStaffTeamMember(team.id, c.req.param('employeeId'));
  addStaffTeamEvent({
    teamId: team.id, employeeId: c.req.param('employeeId'),
    eventType: 'member_removed', actorUserId: user.id,
  });
  return c.json({ ok: true });
});

// --- Team Tasks ---

staffTeamRoutes.get('/:id/tasks', (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const tasks = listStaffTeamTasks(team.id);
  // Augment with assignee info and events
  const enriched = tasks.map((t) => {
    const assignee = t.assignee_employee_id ? getStaffEmployee(t.assignee_employee_id) : null;
    const events = listStaffTaskEvents(t.id);
    return { ...t, assignee, events };
  });
  return c.json({ tasks: enriched });
});

staffTeamRoutes.post('/:id/tasks', async (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = await c.req.json();
  const title = typeof body.title === 'string' && body.title.trim();
  if (!title) return c.json({ error: 'title is required' }, 400);
  const priority = ['low', 'medium', 'high'].includes(body.priority) ? body.priority : 'medium';
  const assigneeId = typeof body.assigneeId === 'string' && body.assigneeId ? body.assigneeId : null;
  // Validate assignee belongs to team
  if (assigneeId) {
    const members = listStaffTeamMembers(team.id);
    if (!members.some((m) => m.employee_id === assigneeId)) {
      return c.json({ error: 'assignee is not a team member' }, 400);
    }
  }
  const id = createStaffTeamTask({
    teamId: team.id, title,
    description: typeof body.description === 'string' ? body.description : '',
    assigneeEmployeeId: assigneeId, priority,
    parentTaskId: typeof body.parentTaskId === 'string' ? body.parentTaskId : null,
    createdBy: user.id,
  });
  addStaffTeamEvent({
    teamId: team.id, taskId: id, employeeId: assigneeId,
    eventType: 'task_created',
    payloadJson: JSON.stringify({ title, priority }), actorUserId: user.id,
  });
  const task = getStaffTeamTask(id);
  return c.json({ task }, 201);
});

staffTeamRoutes.patch('/:id/tasks/:taskId/status', async (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const task = getStaffTeamTask(c.req.param('taskId'));
  if (!task || task.team_id !== team.id) return c.json({ error: 'task not found' }, 404);
  const body = await c.req.json();
  const newStatus = typeof body.status === 'string' ? body.status : '';
  if (!isValidTaskTransition(task.status, newStatus)) {
    return c.json({ error: `invalid transition: ${task.status} → ${newStatus}`, current: task.status }, 400);
  }
  updateStaffTaskStatus(task.id, newStatus);
  addStaffTeamEvent({
    teamId: team.id, taskId: task.id,
    eventType: 'status_changed',
    payloadJson: JSON.stringify({ from: task.status, to: newStatus }),
    actorUserId: user.id,
  });
  return c.json({ task: getStaffTeamTask(task.id) });
});

staffTeamRoutes.put('/:id/tasks/:taskId', async (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const task = getStaffTeamTask(c.req.param('taskId'));
  if (!task || task.team_id !== team.id) return c.json({ error: 'task not found' }, 404);
  const body = await c.req.json();
  const fields: Record<string, unknown> = {};
  if (typeof body.title === 'string') fields.title = body.title;
  if (typeof body.description === 'string') fields.description = body.description;
  if (body.assigneeId !== undefined) fields.assignee_employee_id = body.assigneeId || null;
  if (typeof body.priority === 'string') fields.priority = body.priority;
  updateStaffTask(task.id, fields);
  return c.json({ task: getStaffTeamTask(task.id) });
});

// --- Team Blackboard ---

staffTeamRoutes.get('/:id/blackboard', (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const includeArchived = c.req.query('includeArchived') === '1';
  const entries = listStaffBlackboard(team.id, includeArchived);
  // Augment with employee info
  const enriched = entries.map((e) => ({
    ...e,
    employee: e.source_employee_id ? getStaffEmployee(e.source_employee_id) : null,
  }));
  return c.json({ entries: enriched });
});

staffTeamRoutes.post('/:id/blackboard', async (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = await c.req.json();
  const content = typeof body.content === 'string' && body.content.trim();
  if (!content) return c.json({ error: 'content is required' }, 400);
  const tags = Array.isArray(body.tags) ? body.tags : [];
  const sourceEmployeeId = typeof body.sourceEmployeeId === 'string' ? body.sourceEmployeeId : null;
  const sourceTaskId = typeof body.sourceTaskId === 'string' ? body.sourceTaskId : null;
  const id = createStaffBlackboardEntry({
    teamId: team.id, content, tagsJson: JSON.stringify(tags),
    sourceEmployeeId, sourceTaskId,
  });
  addStaffTeamEvent({
    teamId: team.id, employeeId: sourceEmployeeId,
    eventType: 'blackboard_written',
    payloadJson: JSON.stringify({ entryId: id, tags }), actorUserId: user.id,
  });
  return c.json({ id }, 201);
});

staffTeamRoutes.patch('/:id/blackboard/:entryId', async (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = await c.req.json();
  const fields: { pinned?: number; archived?: number; content?: string } = {};
  if (typeof body.pinned === 'boolean') fields.pinned = body.pinned ? 1 : 0;
  if (typeof body.archived === 'boolean') fields.archived = body.archived ? 1 : 0;
  if (typeof body.content === 'string') fields.content = body.content;
  updateStaffBlackboardEntry(c.req.param('entryId'), fields);
  return c.json({ ok: true });
});

// --- Team Events ---

staffTeamRoutes.get('/:id/events', (c) => {
  const user = c.get('user') as AuthUser;
  const team = getStaffTeam(c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  if (team.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 200);
  const events = listStaffTeamEvents(team.id, limit);
  return c.json({ events });
});
