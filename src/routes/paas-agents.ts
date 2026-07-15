/**
 * Agent PaaS: User-level Agent Definitions CRUD + Mounts.
 *
 * 用户级 Agent 定义实体（DB-backed），与现有 /api/agent-definitions（管理
 * ~/.claude/agents/*.md 全局文件）不同。挂载在 /api/paas/agents。
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  listAgentDefinitions,
  getAgentDefinition,
  createAgentDefinition,
  updateAgentDefinition,
  deleteAgentDefinition,
  listAgentMounts,
  addAgentMount,
  deleteAgentMount,
  countAgentDefinitions,
  getUserAgentQuota,
  listKnowledgeBases,
  saveAgentVersionSnapshot,
  listAgentVersions,
  getAgentVersionSnapshot,
  restoreAgentVersion,
  listAgentMounts as _listAgentMountsForSnapshot,
  type AgentDefinitionRow,
  type AgentMountRow,
  type KnowledgeBaseRow,
} from '../db.js';
import {
  AgentDefinitionCreateSchema,
  AgentDefinitionPatchSchema,
  AgentMountCreateSchema,
} from '../schemas.js';
import type { AgentDefinition, AgentMount, ResourceType } from '../types.js';
import { logger } from '../logger.js';
import fs from 'node:fs';
import path from 'node:path';

export const paasAgentsRoute = new Hono<{ Variables: Variables }>();

paasAgentsRoute.use('*', authMiddleware);

function serializeAgentDef(row: AgentDefinitionRow): AgentDefinition {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    model: row.model,
    engine: row.engine === 'atomcode' ? 'atomcode' : 'claude',
    avatarEmoji: row.avatar_emoji,
    avatarColor: row.avatar_color,
    maxTurns: row.max_turns,
    temperature: row.temperature,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeMount(row: AgentMountRow): AgentMount {
  return {
    id: row.id,
    agentDefId: row.agent_def_id,
    resourceType: row.resource_type as ResourceType,
    resourceId: row.resource_id,
    createdAt: row.created_at,
  };
}

paasAgentsRoute.get('/', (c) => {
  const user = c.get('user');
  const rows = listAgentDefinitions(user.id);
  const result = rows.map((row) => {
    const def = serializeAgentDef(row);
    const mounts = listAgentMounts(row.id).map(serializeMount);
    return { ...def, mounts };
  });
  return c.json({
    agents: result,
    quota: getUserAgentQuota(user.id),
    used: rows.length,
  });
});

paasAgentsRoute.get('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = getAgentDefinition(id, user.id);
  if (!row) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const def = serializeAgentDef(row);
  const mounts = listAgentMounts(row.id).map(serializeMount);
  return c.json({ ...def, mounts });
});

paasAgentsRoute.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const validation = AgentDefinitionCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const used = countAgentDefinitions(user.id);
  const quota = getUserAgentQuota(user.id);
  if (used >= quota) {
    return c.json(
      { error: `Agent quota exceeded (${used}/${quota})` },
      402,
    );
  }
  try {
    const row = createAgentDefinition(user.id, {
      name: validation.data.name,
      description: validation.data.description,
      system_prompt: validation.data.system_prompt,
      model: validation.data.model ?? null,
      engine: validation.data.engine,
      avatar_emoji: validation.data.avatar_emoji ?? null,
      avatar_color: validation.data.avatar_color ?? null,
      max_turns: validation.data.max_turns ?? null,
      temperature: validation.data.temperature ?? null,
      enabled: validation.data.enabled,
    });
    return c.json({ agent: serializeAgentDef(row), mounts: [] }, 201);
  } catch (err) {
    logger.error({ err }, 'Failed to create agent definition');
    return c.json({ error: 'Failed to create agent definition' }, 500);
  }
});

paasAgentsRoute.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const validation = AgentDefinitionPatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const row = updateAgentDefinition(id, user.id, {
    name: validation.data.name,
    description: validation.data.description,
    system_prompt: validation.data.system_prompt,
    model: validation.data.model,
    engine: validation.data.engine,
    avatar_emoji: validation.data.avatar_emoji,
    avatar_color: validation.data.avatar_color,
    max_turns: validation.data.max_turns,
    temperature: validation.data.temperature,
    enabled: validation.data.enabled,
  });
  if (!row) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  return c.json({ agent: serializeAgentDef(row) });
});

paasAgentsRoute.delete('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const ok = deleteAgentDefinition(id, user.id);
  if (!ok) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  return c.json({ success: true });
});

paasAgentsRoute.post('/:id/mounts', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = AgentMountCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const row = addAgentMount(
    id,
    validation.data.resource_type,
    validation.data.resource_id,
  );
  return c.json({ mount: serializeMount(row) }, 201);
});

paasAgentsRoute.delete('/:id/mounts/:mountId', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const mountId = c.req.param('mountId');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const ok = deleteAgentMount(mountId, id);
  if (!ok) {
    return c.json({ error: 'Mount not found' }, 404);
  }
  return c.json({ success: true });
});

// Phase 2: 版本历史
paasAgentsRoute.get('/:id/versions', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const rows = listAgentVersions(id);
  return c.json({
    versions: rows.map((r) => ({
      id: r.id,
      version: r.version,
      created_at: r.created_at,
      created_by: r.created_by,
    })),
  });
});

// Phase 2: 回滚到指定版本
paasAgentsRoute.post('/:id/versions/:vid/restore', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const snapshot = getAgentVersionSnapshot(vid);
  if (!snapshot) {
    return c.json({ error: 'Version not found' }, 404);
  }
  const restored = restoreAgentVersion(id, vid, user.id);
  if (!restored) {
    return c.json({ error: 'Restore failed' }, 500);
  }
  return c.json({
    agent: serializeAgentDef(restored),
    mounts: listAgentMounts(id).map(serializeMount),
  });
});

// 便捷端点: 列出当前用户可挂载的所有资源（供前端挂载面板选择器）
paasAgentsRoute.get('/resources/available', async (c) => {
  const user = c.get('user');
  const mcpServers = await loadUserMcpServersMeta(user.id);
  const kbs = listKnowledgeBases(user.id).map((r: KnowledgeBaseRow) => ({
    id: r.id,
    name: r.name,
    doc_count: r.doc_count,
  }));
  const skills = await loadUserSkillsMeta(user.id);
  return c.json({
    mcp_servers: mcpServers,
    knowledge_bases: kbs,
    skills,
  });
});

async function loadUserMcpServersMeta(
  userId: string,
): Promise<Array<{ id: string; name: string; type: string; enabled: boolean }>> {
  try {
    const { getUserMcpServersDir } = await import('./mcp-servers.js');
    const dir = getUserMcpServersDir(userId);
    const file = path.join(dir, 'servers.json');
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as
      | { servers?: Record<string, { name?: string; type?: string; enabled?: boolean }> }
      | { servers?: Array<{ id?: string; name?: string; type?: string; enabled?: boolean }> };
    const raw = data.servers;
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.map((s) => ({
        id: s.id ?? '',
        name: s.name ?? s.id ?? '',
        type: s.type ?? 'stdio',
        enabled: s.enabled !== false,
      }));
    }
    return Object.entries(raw).map(([id, s]) => ({
      id,
      name: s.name ?? id,
      type: s.type ?? 'stdio',
      enabled: s.enabled !== false,
    }));
  } catch {
    return [];
  }
}

async function loadUserSkillsMeta(
  userId: string,
): Promise<Array<{ id: string; name: string; description: string }>> {
  try {
    const dir = path.join(process.cwd(), 'data', 'skills', userId);
    if (!fs.existsSync(dir)) return [];
    const manifestPath = path.join(dir, '.skills-manifest.json');
    if (!fs.existsSync(manifestPath)) return [];
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Array<{
      packageName: string;
      source?: string;
    }>;
    return data.map((s) => ({
      id: s.packageName,
      name: s.packageName,
      description: s.source ?? '',
    }));
  } catch {
    return [];
  }
}

export default paasAgentsRoute;
