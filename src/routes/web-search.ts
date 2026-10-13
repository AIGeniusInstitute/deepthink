/**
 * Web-search backend configuration routes.
 * Mounted at /api/config/web-search.
 *
 * GET  /     — current backend + per-provider credentials (keys masked)
 * PUT  /     — save (keys omitted from the body are preserved)
 * POST /test — connectivity self-test against a provider
 *
 * All endpoints require manage_system_config: there is no member-facing view
 * of this configuration.
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { WEB_SEARCH_PROVIDERS, isWebSearchProviderId } from '../web-search.js';
import type { WebSearchProviderId } from '../web-search.js';
import {
  getWebSearchConfig,
  saveWebSearchConfig,
  testWebSearchConnection,
  type WebSearchProviderSettings,
} from '../web-search-config.js';

export const webSearchRoute = new Hono<{ Variables: Variables }>();

webSearchRoute.use('*', authMiddleware);

webSearchRoute.get('/', systemConfigMiddleware, (c) => {
  const config = getWebSearchConfig();
  const providers: Record<string, { apiKey: string; baseUrl: string }> = {};
  for (const meta of WEB_SEARCH_PROVIDERS) {
    const stored = config?.providers[meta.id];
    providers[meta.id] = {
      apiKey: stored?.apiKey ? '<masked>' : '',
      baseUrl: stored?.baseUrl ?? '',
    };
  }
  return c.json({
    active: config?.active ?? '',
    configured: config !== null,
    providers,
    providersMeta: WEB_SEARCH_PROVIDERS,
  });
});

webSearchRoute.put('/', systemConfigMiddleware, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    active?: unknown;
    providers?: Record<string, { apiKey?: unknown; baseUrl?: unknown }>;
  };

  const active = typeof body.active === 'string' ? body.active.trim() : '';
  if (!isWebSearchProviderId(active)) {
    return c.json({ error: `active must be one of: ${WEB_SEARCH_PROVIDERS.map((p) => p.id).join(', ')}` }, 400);
  }

  const existing = getWebSearchConfig();
  const providers: Partial<Record<string, WebSearchProviderSettings>> = {
    ...(existing?.providers ?? {}),
  };

  for (const [id, raw] of Object.entries(body.providers ?? {})) {
    if (!isWebSearchProviderId(id) || !raw || typeof raw !== 'object') continue;
    const prev = existing?.providers[id];
    // An omitted field means "leave what's stored alone" — that is how the UI
    // submits a provider whose key the admin never retyped.
    providers[id] = {
      apiKey: 'apiKey' in raw ? String(raw.apiKey ?? '').trim() : (prev?.apiKey ?? ''),
      baseUrl: 'baseUrl' in raw ? String(raw.baseUrl ?? '').trim() : (prev?.baseUrl ?? ''),
    };
  }

  saveWebSearchConfig({ active, providers: providers as never });
  return c.json({ success: true });
});

webSearchRoute.post('/test', systemConfigMiddleware, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    provider?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
  };
  const requested = typeof body.provider === 'string' ? body.provider.trim() : '';
  let provider: WebSearchProviderId | undefined;
  if (requested) {
    if (!isWebSearchProviderId(requested)) {
      return c.json({ status: 'error', error: `unknown_provider: ${requested}` }, 400);
    }
    provider = requested;
  }
  // Overrides let the UI test credentials that have not been saved yet; omitted
  // fields fall back to whatever is stored.
  const overrides = {
    ...(typeof body.apiKey === 'string' && body.apiKey.trim() ? { apiKey: body.apiKey.trim() } : {}),
    ...(typeof body.baseUrl === 'string' && body.baseUrl.trim() ? { baseUrl: body.baseUrl.trim() } : {}),
  };
  const result = await testWebSearchConnection(provider, overrides);
  return c.json(result, result.status === 'error' ? 400 : 200);
});

export default webSearchRoute;
