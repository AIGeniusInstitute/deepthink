/**
 * Agent PaaS Phase 3: Embedding API configuration routes.
 * Mounted at /api/paas/embedding-config.
 *
 * GET /  — any logged-in user (admin: full fields, member: model + dimensions only)
 * PUT /  — admin only
 * POST /test — admin only
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, adminRoleMiddleware } from '../middleware/auth.js';
import { getEmbeddingConfig, saveEmbeddingConfig, testEmbeddingConnection } from '../embedding.js';

export const paasEmbeddingRoute = new Hono<{ Variables: Variables }>();

paasEmbeddingRoute.use('*', authMiddleware);

paasEmbeddingRoute.get('/', (c) => {
  const user = c.get('user');
  const config = getEmbeddingConfig();
  const configured = config !== null;
  if (user.role === 'admin') {
    return c.json({
      baseUrl: config?.baseUrl ?? '',
      apiKey: config ? '<masked>' : '',
      model: config?.model ?? 'text-embedding-3-small',
      dimensions: config?.dimensions ?? 1536,
      configured,
    });
  }
  return c.json({
    model: config?.model ?? 'text-embedding-3-small',
    dimensions: config?.dimensions ?? 1536,
    configured,
  });
});

paasEmbeddingRoute.put('/', adminRoleMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : 'text-embedding-3-small';
  const dimensions = Number(body.dimensions ?? 1536);
  if (!baseUrl || !apiKey || !model) {
    return c.json({ error: 'baseUrl, apiKey, model are required' }, 400);
  }
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
    return c.json({ error: 'dimensions must be integer 1-8192' }, 400);
  }
  saveEmbeddingConfig({ baseUrl, apiKey, model, dimensions });
  return c.json({ success: true });
});

paasEmbeddingRoute.post('/test', adminRoleMiddleware, async (c) => {
  const result = await testEmbeddingConnection();
  return c.json(result, result.success ? 200 : 400);
});

export default paasEmbeddingRoute;
