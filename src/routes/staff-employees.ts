// Digital Employee management routes.
//
// CRUD for staff_employees — the "digital employee" concept layer that wraps
// agent_definitions with employee metadata (role/department/avatar/persona).
// Each employee stores skills/KB/tools as JSON arrays for MVP simplicity.
//
// Access: owner (user.id) or admin. Employees are user-scoped.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createStaffEmployee,
  getStaffEmployee,
  listStaffEmployees,
  updateStaffEmployee,
  softDeleteStaffEmployee,
} from '../db.js';

export const staffEmployeeRoutes = new Hono<{ Variables: Variables }>();
staffEmployeeRoutes.use('*', authMiddleware);

// List employees for the current user
staffEmployeeRoutes.get('/', (c) => {
  const user = c.get('user') as AuthUser;
  const q = c.req.query('includeInactive');
  const includeInactive = q === '1' || q === 'true';
  const employees = listStaffEmployees(user.id, includeInactive);
  return c.json({ employees });
});

// Create employee
staffEmployeeRoutes.post('/', async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json();
  const name = typeof body.name === 'string' && body.name.trim();
  const role = typeof body.role === 'string' && body.role.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!role) return c.json({ error: 'role is required' }, 400);

  const skills = Array.isArray(body.skills) ? body.skills : [];
  const knowledgeBases = Array.isArray(body.knowledgeBases) ? body.knowledgeBases : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  const id = createStaffEmployee({
    ownerUserId: user.id,
    name,
    role,
    department: typeof body.department === 'string' ? body.department : '',
    avatarEmoji: typeof body.avatarEmoji === 'string' ? body.avatarEmoji : '🤖',
    personaPrompt: typeof body.personaPrompt === 'string' ? body.personaPrompt : '',
    model: typeof body.model === 'string' ? body.model : '',
    skillsJson: JSON.stringify(skills),
    knowledgeBasesJson: JSON.stringify(knowledgeBases),
    toolsJson: JSON.stringify(tools),
  });
  const emp = getStaffEmployee(id);
  return c.json({ employee: emp }, 201);
});

// Get single employee
staffEmployeeRoutes.get('/:id', (c) => {
  const user = c.get('user') as AuthUser;
  const emp = getStaffEmployee(c.req.param('id'));
  if (!emp) return c.json({ error: 'not found' }, 404);
  if (emp.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  return c.json({ employee: emp });
});

// Update employee
staffEmployeeRoutes.put('/:id', async (c) => {
  const user = c.get('user') as AuthUser;
  const emp = getStaffEmployee(c.req.param('id'));
  if (!emp) return c.json({ error: 'not found' }, 404);
  if (emp.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = await c.req.json();
  const fields: Record<string, unknown> = {};
  if (typeof body.name === 'string') fields.name = body.name;
  if (typeof body.role === 'string') fields.role = body.role;
  if (typeof body.department === 'string') fields.department = body.department;
  if (typeof body.avatarEmoji === 'string') fields.avatar_emoji = body.avatarEmoji;
  if (typeof body.personaPrompt === 'string') fields.persona_prompt = body.personaPrompt;
  if (typeof body.model === 'string') fields.model = body.model;
  if (Array.isArray(body.skills)) fields.skills_json = JSON.stringify(body.skills);
  if (Array.isArray(body.knowledgeBases)) fields.knowledge_bases_json = JSON.stringify(body.knowledgeBases);
  if (Array.isArray(body.tools)) fields.tools_json = JSON.stringify(body.tools);
  if (typeof body.status === 'string') fields.status = body.status;
  updateStaffEmployee(emp.id, fields);
  return c.json({ employee: getStaffEmployee(emp.id) });
});

// Soft delete employee
staffEmployeeRoutes.delete('/:id', (c) => {
  const user = c.get('user') as AuthUser;
  const emp = getStaffEmployee(c.req.param('id'));
  if (!emp) return c.json({ error: 'not found' }, 404);
  if (emp.owner_user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  softDeleteStaffEmployee(emp.id);
  return c.json({ ok: true });
});
