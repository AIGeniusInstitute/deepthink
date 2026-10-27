/**
 * Web-search backend configuration: which provider the agent containers should
 * call, plus that provider's credentials.
 *
 * Configuration: data/config/web-search.json (0600)
 *
 * Note this file is host-side only. The provider implementations live in
 * src/web-search.ts, which is a generated copy of shared/web-search.ts.
 *
 * When unconfigured, `resolveWebSearchEnv()` falls back to the legacy
 * ZHIPU_API_KEY discovery if one is available, and otherwise to the keyless
 * browser backend — so web_search is never left with no backend at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';
import {
  getWebSearchProviderMeta,
  isWebSearchProviderId,
  runWebSearch,
  type WebSearchProviderId,
  type WebSearchResponse,
} from './web-search.js';

const WEB_SEARCH_CONFIG_PATH = path.join(DATA_DIR, 'config', 'web-search.json');

export interface WebSearchProviderSettings {
  apiKey: string;
  /** Optional; overrides the provider default (for `bing`, the origin to scrape). */
  baseUrl?: string;
}

export interface WebSearchConfig {
  /** Which backend agent containers should call. */
  active: WebSearchProviderId;
  providers: Partial<Record<WebSearchProviderId, WebSearchProviderSettings>>;
}

export interface WebSearchEnv {
  provider: WebSearchProviderId;
  /** Env vars to inject into the agent container / host agent process. */
  env: Record<string, string>;
}

let cachedConfig: WebSearchConfig | null | undefined = undefined;
let configMtime = 0;

export function getWebSearchConfig(): WebSearchConfig | null {
  try {
    if (!fs.existsSync(WEB_SEARCH_CONFIG_PATH)) {
      cachedConfig = null;
      return null;
    }
    const stat = fs.statSync(WEB_SEARCH_CONFIG_PATH);
    if (cachedConfig !== undefined && stat.mtimeMs === configMtime) {
      return cachedConfig;
    }
    const parsed = JSON.parse(fs.readFileSync(WEB_SEARCH_CONFIG_PATH, 'utf8')) as Partial<WebSearchConfig>;
    if (typeof parsed.active !== 'string' || !isWebSearchProviderId(parsed.active)) {
      cachedConfig = null;
      return null;
    }
    const providers: Partial<Record<WebSearchProviderId, WebSearchProviderSettings>> = {};
    for (const [id, value] of Object.entries(parsed.providers ?? {})) {
      if (!isWebSearchProviderId(id) || !value || typeof value !== 'object') continue;
      const entry = value as Partial<WebSearchProviderSettings>;
      providers[id] = {
        apiKey: typeof entry.apiKey === 'string' ? entry.apiKey.trim() : '',
        ...(typeof entry.baseUrl === 'string' && entry.baseUrl.trim()
          ? { baseUrl: entry.baseUrl.trim().replace(/\/+$/, '') }
          : {}),
      };
    }
    cachedConfig = { active: parsed.active, providers };
    configMtime = stat.mtimeMs;
    return cachedConfig;
  } catch (err) {
    logger.warn({ err }, 'getWebSearchConfig: unreadable config, treating as unconfigured');
    cachedConfig = null;
    return null;
  }
}

export function saveWebSearchConfig(config: WebSearchConfig): void {
  const dir = path.dirname(WEB_SEARCH_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const providers: Record<string, WebSearchProviderSettings> = {};
  for (const [id, value] of Object.entries(config.providers ?? {})) {
    if (!isWebSearchProviderId(id) || !value) continue;
    const apiKey = (value.apiKey ?? '').trim();
    const baseUrl = (value.baseUrl ?? '').trim().replace(/\/+$/, '');
    // Keep entries that still carry something; drop the ones cleared in the UI.
    if (!apiKey && !baseUrl) continue;
    providers[id] = { apiKey, ...(baseUrl ? { baseUrl } : {}) };
  }
  const payload: WebSearchConfig = { active: config.active, providers };
  const tmp = `${WEB_SEARCH_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, WEB_SEARCH_CONFIG_PATH);
  cachedConfig = undefined;
  configMtime = 0;
}

/**
 * Decide which backend the agent container runs with.
 *
 * `legacyZhipuApiKey` is the pre-pluggable ZHIPU_API_KEY discovery result
 * (host env or ~/zhipu_web_search/.env), passed in by container-runner so this
 * module does not need to know about that legacy path itself.
 */
export function resolveWebSearchEnv(legacyZhipuApiKey?: string): WebSearchEnv {
  const config = getWebSearchConfig();

  let provider: WebSearchProviderId;
  let settings: WebSearchProviderSettings;

  const envProvider = (process.env.WEB_SEARCH_PROVIDER || '').trim();

  if (config) {
    provider = config.active;
    settings = config.providers[provider] ?? { apiKey: '' };
  } else if (isWebSearchProviderId(envProvider)) {
    // No settings-page config yet: honour an explicit env-var setup, which is
    // how every other platform setting can be overridden.
    provider = envProvider;
    settings = {
      apiKey: (process.env.WEB_SEARCH_API_KEY || '').trim(),
      baseUrl: (process.env.WEB_SEARCH_BASE_URL || '').trim(),
    };
  } else if (legacyZhipuApiKey) {
    provider = 'zhipu';
    settings = { apiKey: legacyZhipuApiKey };
  } else {
    // Nothing configured at all — the keyless browser backend keeps web_search
    // usable without any API key.
    provider = 'browser';
    settings = { apiKey: '' };
  }

  const env: Record<string, string> = { WEB_SEARCH_PROVIDER: provider };
  if (settings.apiKey) env.WEB_SEARCH_API_KEY = settings.apiKey;
  const baseUrl = settings.baseUrl || getWebSearchProviderMeta(provider).defaultBaseUrl;
  env.WEB_SEARCH_BASE_URL = baseUrl;

  // A key-less provider chosen explicitly is a configuration mistake worth
  // surfacing in the logs rather than silently degrading to no results.
  if (getWebSearchProviderMeta(provider).needsKey && !settings.apiKey) {
    logger.warn({ provider }, 'web_search provider needs an API key but none is configured');
  }

  return { provider, env };
}

/**
 * Connectivity self-test for the settings page. Never throws.
 *
 * `overrides` lets the UI exercise credentials the admin has typed but not yet
 * saved, so "test" answers the question the admin is actually asking.
 */
export async function testWebSearchConnection(
  provider?: WebSearchProviderId,
  overrides: { apiKey?: string; baseUrl?: string } = {},
): Promise<WebSearchResponse> {
  const config = getWebSearchConfig();
  const target = provider ?? config?.active ?? 'browser';
  const settings = config?.providers[target];
  return runWebSearch(
    target,
    { query: 'DeepThink AI agent platform', count: 3 },
    {
      apiKey: overrides.apiKey ?? settings?.apiKey ?? '',
      baseUrl: overrides.baseUrl ?? settings?.baseUrl,
    },
  );
}
