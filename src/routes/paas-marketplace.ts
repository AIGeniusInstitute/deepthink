/**
 * Agent PaaS: Marketplace — admin publishes templates, users browse/install.
 *
 * 四种 item_type:
 *  - agent_template: payload = AgentDefinition + mounts
 *  - mcp_template:   payload = MCP server config
 *  - skill_template: payload = skill package name
 *  - kb_template:    payload = KB + initial documents
 *
 * 安装行为 = 复制 payload 为用户私有实例。
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, adminRoleMiddleware } from '../middleware/auth.js';
import {
  listMarketplaceItems,
  getMarketplaceItem,
  createMarketplaceItem,
  createMarketplaceItemWithStatus,
  incrementInstallCount,
  setMarketplaceItemStatus,
  listMarketplaceItemsByUser,
  upsertReview,
  listReviews,
  getReviewStats,
  type MarketplaceItemRow,
  type MarketplaceReviewRow,
  type MarketplaceStatus,
} from '../db.js';
import { MarketplaceItemCreateSchema } from '../schemas.js';
import type { MarketplaceItem, MarketplaceItemType } from '../types.js';
import { logger } from '../logger.js';
import fs from 'node:fs';
import path from 'node:path';

export const paasMarketplaceRoute = new Hono<{ Variables: Variables }>();

paasMarketplaceRoute.use('*', authMiddleware);

function serializeItem(row: MarketplaceItemRow): MarketplaceItem {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = null;
  }
  let tags: string[];
  try {
    tags = JSON.parse(row.tags) as string[];
    if (!Array.isArray(tags)) tags = [];
  } catch {
    tags = [];
  }
  const stats = getReviewStats(row.id);
  return {
    id: row.id,
    itemType: row.item_type as MarketplaceItemType,
    name: row.name,
    description: row.description,
    authorName: row.author_name,
    tags,
    payload,
    installedCount: row.installed_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    submittedBy: row.submitted_by,
    ratingAverage: stats.avg,
    ratingCount: stats.count,
  };
}

paasMarketplaceRoute.get('/', (c) => {
  const user = c.get('user');
  const itemType = c.req.query('item_type');
  const statusParam = c.req.query('status') as MarketplaceStatus | undefined;
  // Non-admin users can only see approved items; admin can pass ?status=pending
  const status: MarketplaceStatus | undefined =
    user.role === 'admin' && statusParam ? statusParam : 'approved';
  const rows = listMarketplaceItems(status, itemType ?? undefined);
  return c.json({ items: rows.map(serializeItem) });
});

paasMarketplaceRoute.get('/mine', (c) => {
  const user = c.get('user');
  const rows = listMarketplaceItemsByUser(user.id);
  return c.json({ items: rows.map(serializeItem) });
});

paasMarketplaceRoute.get('/:id', (c) => {
  const id = c.req.param('id');
  const row = getMarketplaceItem(id);
  if (!row) {
    return c.json({ error: 'Item not found' }, 404);
  }
  return c.json({ item: serializeItem(row) });
});

// Admin 发布新模板
paasMarketplaceRoute.post('/', adminRoleMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MarketplaceItemCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const row = createMarketplaceItem({
    item_type: validation.data.item_type,
    name: validation.data.name,
    description: validation.data.description,
    author_name: validation.data.author_name,
    tags: validation.data.tags,
    payload: validation.data.payload,
  });
  return c.json({ item: serializeItem(row) }, 201);
});

// Phase 2: 用户提交模板（status=pending，需 admin 审核）
paasMarketplaceRoute.post('/submit', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const validation = MarketplaceItemCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const row = createMarketplaceItemWithStatus({
    item_type: validation.data.item_type,
    name: validation.data.name,
    description: validation.data.description,
    author_name: validation.data.author_name ?? user.username,
    tags: validation.data.tags,
    payload: validation.data.payload,
    status: 'pending',
    submitted_by: user.id,
  });
  return c.json({ item: serializeItem(row) }, 201);
});

// Phase 2: admin 审核
paasMarketplaceRoute.post('/:id/approve', adminRoleMiddleware, (c) => {
  const id = c.req.param('id');
  if (!getMarketplaceItem(id)) return c.json({ error: 'Item not found' }, 404);
  setMarketplaceItemStatus(id, 'approved');
  return c.json({ success: true });
});

paasMarketplaceRoute.post('/:id/reject', adminRoleMiddleware, (c) => {
  const id = c.req.param('id');
  if (!getMarketplaceItem(id)) return c.json({ error: 'Item not found' }, 404);
  setMarketplaceItemStatus(id, 'rejected');
  return c.json({ success: true });
});

// Phase 2: 评分评论
paasMarketplaceRoute.post('/:id/reviews', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!getMarketplaceItem(id)) return c.json({ error: 'Item not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return c.json({ error: 'rating must be an integer 1-5' }, 400);
  }
  const comment = typeof body.comment === 'string' ? body.comment.slice(0, 2000) : null;
  const row = upsertReview(id, user.id, rating, comment);
  return c.json({ review: serializeReview(row) }, 201);
});

paasMarketplaceRoute.get('/:id/reviews', (c) => {
  const id = c.req.param('id');
  if (!getMarketplaceItem(id)) return c.json({ error: 'Item not found' }, 404);
  const rows = listReviews(id);
  return c.json({ reviews: rows.map(serializeReview) });
});

function serializeReview(row: MarketplaceReviewRow) {
  return {
    id: row.id,
    itemId: row.item_id,
    userId: row.user_id,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 安装模板到用户资源
paasMarketplaceRoute.post('/:id/install', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = getMarketplaceItem(id);
  if (!row) {
    return c.json({ error: 'Item not found' }, 404);
  }
  const item = serializeItem(row);
  let payload: any = item.payload;
  if (!payload || typeof payload !== 'object') {
    return c.json({ error: 'Invalid template payload' }, 500);
  }

  try {
    const result = await installTemplate(item.itemType, payload, user.id);
    incrementInstallCount(id);
    return c.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err, itemId: id, itemType: item.itemType }, 'Install failed');
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Install failed',
      },
      500,
    );
  }
});

async function installTemplate(
  itemType: MarketplaceItemType,
  payload: any,
  userId: string,
): Promise<{ installed: { type: string; id?: string; name?: string } }> {
  if (itemType === 'agent_template') {
    const { createAgentDefinition, addAgentMount } = await import('../db.js');
    const def = await createAgentDefinition(userId, {
      name: payload.name ?? 'Installed Agent',
      description: payload.description ?? '',
      system_prompt: payload.system_prompt ?? '',
      model: payload.model ?? null,
      engine: payload.engine ?? 'claude',
      avatar_emoji: payload.avatar_emoji ?? null,
      avatar_color: payload.avatar_color ?? null,
      max_turns: payload.max_turns ?? null,
      temperature: payload.temperature ?? null,
      enabled: true,
    });
    if (Array.isArray(payload.mounts)) {
      for (const m of payload.mounts) {
        if (m && m.resource_type && m.resource_id) {
          addAgentMount(def.id, m.resource_type, m.resource_id);
        }
      }
    }
    return { installed: { type: 'agent', id: def.id, name: def.name } };
  }
  if (itemType === 'mcp_template') {
    const { getUserMcpServersDir } = await import('./mcp-servers.js');
    const dir = getUserMcpServersDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'servers.json');
    let existing: { servers?: Record<string, Record<string, unknown>> } = { servers: {} };
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
          existing = parsed;
        }
      } catch {
        // corrupt file — keep empty
      }
    }
    const newId = (payload.id as string) || crypto.randomUUID();
    const newServer: Record<string, unknown> = {
      id: newId,
      name: payload.name ?? 'Installed MCP',
      type: payload.type ?? 'stdio',
      command: payload.command,
      args: payload.args,
      env: payload.env,
      url: payload.url,
      enabled: true,
      addedAt: new Date().toISOString(),
    };
    existing.servers![newId] = newServer;
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf8');
    return { installed: { type: 'mcp', id: newId, name: newServer.name as string } };
  }
  if (itemType === 'skill_template') {
    // 安装 skill 通过 mcp 工具，此处仅返回 packageName 供前端调用
    return {
      installed: {
        type: 'skill',
        name: payload.packageName ?? payload.name,
      },
    };
  }
  if (itemType === 'kb_template') {
    const { createKnowledgeBase, addKbDocument } = await import('../db.js');
    const kb = createKnowledgeBase(
      userId,
      payload.name ?? 'Installed KB',
      payload.description ?? '',
    );
    if (Array.isArray(payload.documents)) {
      for (const doc of payload.documents) {
        if (doc && doc.filename && doc.content) {
          addKbDocument(kb.id, userId, doc.filename, doc.content);
        }
      }
    }
    return { installed: { type: 'kb', id: kb.id, name: kb.name } };
  }
  throw new Error(`Unknown template type: ${itemType}`);
}

export default paasMarketplaceRoute;
