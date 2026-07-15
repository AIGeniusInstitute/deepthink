/**
 * Agent PaaS Phase 3: Public share routes (no auth for viewing, auth for install).
 * Mounted at /api/paas/share.
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getAgentShareByToken,
  incrementShareInstall,
  getAgentDefinition,
  listAgentMounts,
  createAgentDefinition,
  countAgentDefinitions,
  getUserAgentQuota,
  type AgentDefinitionRow,
  type AgentMountRow,
} from '../db.js';
import { logger } from '../logger.js';

export const paasShareRoute = new Hono<{ Variables: Variables }>();

const MAX_PROMPT_PREVIEW = 200;

// GET /:token — public, no auth
paasShareRoute.get('/:token', (c) => {
  const token = c.req.param('token');
  const share = getAgentShareByToken(token);
  if (!share) {
    return c.json({ error: 'Share link not found or revoked' }, 404);
  }
  if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
    return c.json({ error: 'Share link has expired' }, 410);
  }
  const agent = getAgentDefinition(share.agent_def_id, share.created_by);
  if (!agent) {
    return c.json({ error: 'Agent has been deleted' }, 404);
  }
  const mounts = listAgentMounts(share.agent_def_id);
  const promptPreview =
    (agent.system_prompt ?? '').slice(0, MAX_PROMPT_PREVIEW) +
    ((agent.system_prompt ?? '').length > MAX_PROMPT_PREVIEW ? '…' : '');
  return c.json({
    shareId: share.id,
    agentName: agent.name,
    description: agent.description,
    systemPromptPreview: promptPreview,
    model: agent.model,
    engine: agent.engine,
    mountCount: mounts.length,
    installCount: share.install_count,
    createdAt: share.created_at,
  });
});

// POST /:token/install — auth required
paasShareRoute.post('/:token/install', authMiddleware, async (c) => {
  const user = c.get('user');
  const token = c.req.param('token');
  const share = getAgentShareByToken(token);
  if (!share) {
    return c.json({ error: 'Share link not found or revoked' }, 404);
  }
  if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
    return c.json({ error: 'Share link has expired' }, 410);
  }
  const sourceAgent = getAgentDefinition(share.agent_def_id, share.created_by);
  if (!sourceAgent) {
    return c.json({ error: 'Source agent has been deleted' }, 404);
  }
  // Quota check
  const used = countAgentDefinitions(user.id);
  const quota = getUserAgentQuota(user.id);
  if (used >= quota) {
    return c.json({ error: `Agent quota exceeded (${used}/${quota})` }, 402);
  }
  // Copy mounts
  const sourceMounts = listAgentMounts(share.agent_def_id);
  try {
    const row = createAgentDefinition(user.id, {
      name: `${sourceAgent.name} (copy)`,
      description: sourceAgent.description,
      system_prompt: sourceAgent.system_prompt,
      model: sourceAgent.model ?? null,
      engine: sourceAgent.engine === 'atomcode' ? 'atomcode' : 'claude',
      avatar_emoji: sourceAgent.avatar_emoji ?? null,
      avatar_color: sourceAgent.avatar_color ?? null,
      max_turns: sourceAgent.max_turns ?? null,
      temperature: sourceAgent.temperature ?? null,
      enabled: !!sourceAgent.enabled,
    });
    // Replicate mounts (user may not own all resources, but mount records are
    // just pointers — agent-runner resolves actual MCP/KB/Skill ownership)
    for (const m of sourceMounts) {
      try {
        const { addAgentMount } = await import('../db.js');
        addAgentMount(row.id, m.resource_type, m.resource_id);
      } catch (err) {
        logger.warn({ err, mountId: m.id }, 'Failed to replicate mount on install');
      }
    }
    incrementShareInstall(token);
    return c.json({ agentId: row.id, name: row.name }, 201);
  } catch (err) {
    logger.error({ err }, 'Failed to install agent from share');
    return c.json({ error: 'Install failed' }, 500);
  }
});

export default paasShareRoute;

// Re-export for type narrowing in route
export type { AgentDefinitionRow, AgentMountRow };
