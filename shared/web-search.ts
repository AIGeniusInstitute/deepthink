/**
 * Pluggable web-search backends behind the `web_search` MCP tool.
 * Canonical source — synced to src/ and container/agent-runner/src/ via make sync-types.
 * Do not edit the copies.
 *
 * Three consumers share this file:
 *   - container/agent-runner/src/mcp-tools.ts  (the actual tool call, in-container)
 *   - src/routes/config.ts                     (settings-page connectivity self-test, on host)
 *   - src/container-runner.ts                  (picking which credentials to inject)
 *
 * Keep this file dependency-free (no imports): it is copied verbatim into projects
 * with different module layouts and package.json files.
 */

export type WebSearchProviderId = 'zhipu' | 'tavily' | 'bocha' | 'serper' | 'bing';

export interface WebSearchProviderMeta {
  id: WebSearchProviderId;
  label: string;
  /** false = keyless, works out of the box (currently only the Bing scrape) */
  needsKey: boolean;
  defaultBaseUrl: string;
  hint: string;
}

export const WEB_SEARCH_PROVIDERS: WebSearchProviderMeta[] = [
  {
    id: 'zhipu',
    label: '智谱 GLM',
    needsKey: true,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    hint: '国内直连可用。账户需有余额或资源包，欠费会返回 1113。',
  },
  {
    id: 'tavily',
    label: 'Tavily',
    needsKey: true,
    defaultBaseUrl: 'https://api.tavily.com',
    hint: 'Agent 场景常用的搜索 API，服务在海外。',
  },
  {
    id: 'bocha',
    label: '博查 Bocha',
    needsKey: true,
    defaultBaseUrl: 'https://api.bochaai.com/v1',
    hint: '国内直连可用，中文检索质量好。',
  },
  {
    id: 'serper',
    label: 'Serper (Google)',
    needsKey: true,
    defaultBaseUrl: 'https://google.serper.dev',
    hint: '返回 Google 结果，国内直连通常不通。',
  },
  {
    id: 'bing',
    label: 'Bing 网页抓取（免费）',
    needsKey: false,
    defaultBaseUrl: 'https://www.bing.com',
    hint: '无需 key，国内可直连。爬虫式实现：Bing 改版或限流时可能失败。',
  },
];

export interface WebSearchParams {
  query: string;
  count?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface WebSearchCredentials {
  apiKey?: string;
  /** Overrides the provider default; for `bing` it is the Bing origin to scrape. */
  baseUrl?: string;
}

export interface WebSearchResultItem {
  title: string;
  content: string;
  link: string;
  publish_date: string;
  media: string;
}

export type WebSearchStatus = 'ok' | 'empty' | 'error';

export interface WebSearchResponse {
  status: WebSearchStatus;
  provider: WebSearchProviderId;
  query: string;
  results: WebSearchResultItem[];
  latency_ms: number;
  error: string | null;
}

const WEB_SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 50;

export function isWebSearchProviderId(value: string): value is WebSearchProviderId {
  return WEB_SEARCH_PROVIDERS.some((p) => p.id === value);
}

export function getWebSearchProviderMeta(id: WebSearchProviderId): WebSearchProviderMeta {
  return WEB_SEARCH_PROVIDERS.find((p) => p.id === id) ?? WEB_SEARCH_PROVIDERS[0];
}

function clampCount(count: number | undefined): number {
  if (!Number.isFinite(count) || count === undefined) return DEFAULT_COUNT;
  return Math.min(Math.max(Math.trunc(count), 1), MAX_COUNT);
}

/**
 * Run one search against `provider`. Never throws: every failure mode (missing key,
 * timeout, non-2xx, malformed payload) comes back as `status: 'error'` so the calling
 * agent can read the reason and adapt instead of seeing a tool crash.
 */
export async function runWebSearch(
  provider: WebSearchProviderId,
  params: WebSearchParams,
  creds: WebSearchCredentials = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WebSearchResponse> {
  const t0 = Date.now();
  const query = params.query;
  const count = clampCount(params.count);
  const meta = getWebSearchProviderMeta(provider);
  const baseUrl = (creds.baseUrl || meta.defaultBaseUrl).replace(/\/+$/, '');
  const apiKey = (creds.apiKey || '').trim();

  const fail = (error: string): WebSearchResponse => ({
    status: 'error',
    provider,
    query,
    results: [],
    latency_ms: Date.now() - t0,
    error,
  });

  if (meta.needsKey && !apiKey) {
    return fail(`missing_api_key: ${provider}`);
  }

  try {
    let raw: Record<string, unknown>[];
    switch (provider) {
      case 'zhipu':
        raw = await searchZhipu(baseUrl, apiKey, query, count, timeoutMs);
        break;
      case 'tavily':
        raw = await searchTavily(baseUrl, apiKey, query, count, timeoutMs);
        break;
      case 'bocha':
        raw = await searchBocha(baseUrl, apiKey, query, count, timeoutMs);
        break;
      case 'serper':
        raw = await searchSerper(baseUrl, apiKey, query, count, timeoutMs);
        break;
      case 'bing':
        raw = await searchBing(baseUrl, query, count, timeoutMs);
        break;
      default:
        return fail(`unknown_provider: ${provider}`);
    }

    const normalized = filterByDomain(
      raw.slice(0, count).map(normalizeItem),
      params.allowed_domains,
      params.blocked_domains,
    );

    return {
      status: normalized.length ? 'ok' : 'empty',
      provider,
      query,
      results: normalized,
      latency_ms: Date.now() - t0,
      error: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

// ── Per-provider implementations ────────────────────────────────────
// Each returns raw provider-shaped records; normalizeItem() maps them onto the
// shared result shape afterwards, tolerating the field-name drift between APIs.

async function searchZhipu(
  baseUrl: string,
  apiKey: string,
  query: string,
  count: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const resp = await fetchChecked(
    `${baseUrl}/web_search`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search_query: query,
        search_engine: 'search_std',
        count,
        content_size: 'medium',
      }),
    },
    timeoutMs,
  );
  const data = (await resp.json()) as Record<string, unknown>;
  return pickArray(data.search_result, data.data);
}

async function searchTavily(
  baseUrl: string,
  apiKey: string,
  query: string,
  count: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const resp = await fetchChecked(
    `${baseUrl}/search`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, max_results: count, include_answer: false }),
    },
    timeoutMs,
  );
  const data = (await resp.json()) as Record<string, unknown>;
  return pickArray(data.results);
}

async function searchBocha(
  baseUrl: string,
  apiKey: string,
  query: string,
  count: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const resp = await fetchChecked(
    `${baseUrl}/web-search`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, count, summary: true, freshness: 'noLimit' }),
    },
    timeoutMs,
  );
  const data = (await resp.json()) as Record<string, unknown>;
  // Bocha mirrors the Bing Web Search v7 envelope: data.webPages.value[]
  const pages = data.data as Record<string, unknown> | undefined;
  return pickArray(pages?.webPages, data.webPages);
}

async function searchSerper(
  baseUrl: string,
  apiKey: string,
  query: string,
  count: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const resp = await fetchChecked(
    `${baseUrl}/search`,
    {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: count }),
    },
    timeoutMs,
  );
  const data = (await resp.json()) as Record<string, unknown>;
  return pickArray(data.organic);
}

/**
 * Keyless fallback: scrape Bing's HTML result page. Deliberately tolerant — Bing
 * ships several result-card variants (b_algo, b_algoBigWiki, ...), so cards are
 * split on the class prefix rather than matched with one rigid pattern.
 */
async function searchBing(
  baseUrl: string,
  query: string,
  count: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&count=${count}`;
  const resp = await fetchChecked(
    url,
    {
      headers: {
        'User-Agent': WEB_SEARCH_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    },
    timeoutMs,
  );
  const html = await resp.text();
  return parseBingHtml(html);
}

// ── Bing HTML parsing ───────────────────────────────────────────────

/** Split Bing's SERP into individual result cards (any `b_algo*` variant). */
export function parseBingHtml(html: string): Record<string, unknown>[] {
  const chunks = html.split(/<li class="b_algo[^"]*"/).slice(1);
  const out: Record<string, unknown>[] = [];
  for (const chunk of chunks) {
    // Each chunk runs until the next card starts; clamp so a malformed tail
    // cannot pull in content from a following card.
    const body = chunk.slice(0, 20_000);

    const titleMatch = body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const linkMatch =
      body.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/) ??
      body.match(/<a[^>]+href="(https?:\/\/[^"]+)"/);
    if (!titleMatch || !linkMatch) continue;

    const title = decodeHtmlEntities(stripTags(titleMatch[1])).trim();
    const link = decodeBingRedirect(decodeHtmlEntities(linkMatch[1]));
    if (!title || !link || !/^https?:/i.test(link)) continue;

    const snippetMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const content = snippetMatch
      ? decodeHtmlEntities(stripTags(snippetMatch[1])).replace(/\s+/g, ' ').trim()
      : '';

    out.push({ title, url: link, snippet: content, site: domainOf(link) });
  }
  return out;
}

/** Bing wraps some hits in /ck/a redirects carrying the real URL base64url'd in `u=a1<...>`. */
export function decodeBingRedirect(href: string): string {
  if (!/^https?:\/\/(www\.)?bing\.com\/ck\/a/i.test(href)) return href;
  const m = href.match(/[?&]u=a1([^&]+)/);
  if (!m) return href;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

// ── Shared helpers ──────────────────────────────────────────────────

async function fetchChecked(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const resp = await fetch(url, { redirect: 'follow', ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) {
    const snippet = await resp.text().catch(() => '');
    throw new Error(`http_${resp.status}: ${snippet.slice(0, 200)}`);
  }
  return resp;
}

/** Read the first of the given candidates that is an array of objects. */
function pickArray(...candidates: unknown[]): Record<string, unknown>[] {
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
    // Some providers nest the array one level deeper (Bocha: data.webPages.value)
    if (c && typeof c === 'object') {
      const inner = (c as Record<string, unknown>).value;
      if (Array.isArray(inner)) {
        return inner.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
      }
    }
  }
  return [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Map a provider-shaped record onto the shared result shape. */
function normalizeItem(r: Record<string, unknown>): WebSearchResultItem {
  const link = asString(r.link) || asString(r.url);
  return {
    title: asString(r.title) || asString(r.name),
    content: asString(r.content) || asString(r.snippet) || asString(r.summary),
    link,
    publish_date:
      asString(r.publish_date) ||
      asString(r.published_date) ||
      asString(r.date) ||
      asString(r.datePublished) ||
      asString(r.dateLastCrawled),
    media: asString(r.media) || asString(r.source) || asString(r.siteName) || asString(r.site) || domainOf(link),
  };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Apply allowed_domains / blocked_domains. Matching is on label boundaries:
 * `example.com` matches `news.example.com` but not `notexample.com`.
 */
export function filterByDomain<T extends { link: string }>(
  items: T[],
  allowed?: string[],
  blocked?: string[],
): T[] {
  const normalize = (d: string) => d.replace(/^www\./, '').toLowerCase().replace(/^\./, '');
  const matches = (host: string, domain: string): boolean =>
    host === domain || host.endsWith(`.${domain}`);

  let out = items;
  if (allowed?.length) {
    const allow = allowed.map(normalize).filter(Boolean);
    out = out.filter((it) => {
      const host = domainOf(it.link);
      return allow.some((d) => matches(host, d));
    });
  }
  if (blocked?.length) {
    const block = blocked.map(normalize).filter(Boolean);
    out = out.filter((it) => {
      const host = domainOf(it.link);
      return !block.some((d) => matches(host, d));
    });
  }
  return out;
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    const key = entity.toLowerCase();
    if (key in NAMED_ENTITIES) return NAMED_ENTITIES[key];
    if (key.startsWith('#')) {
      const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}
