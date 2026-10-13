/**
 * shared/web-search.ts — the pluggable search backends behind the `web_search`
 * MCP tool.
 *
 * Imported through the generated src/web-search.ts copy, which is the one the
 * host runs (settings-page self-test). All three copies are byte-identical;
 * scripts/check-stream-event-sync.sh enforces that in CI.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  WEB_SEARCH_PROVIDERS,
  decodeBingRedirect,
  filterByDomain,
  getWebSearchProviderMeta,
  isWebSearchProviderId,
  parseBingHtml,
  runWebSearch,
} from '../src/web-search.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Replace global fetch with a scripted responder; records every call. */
function stubFetch(
  respond: (call: FetchCall) => { status?: number; json?: unknown; text?: string },
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init: unknown) => {
    const call: FetchCall = { url: String(url), init: (init ?? {}) as RequestInit };
    calls.push(call);
    const r = respond(call);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json ?? ''),
    } as unknown as Response;
  });
  return { calls };
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Provider registry ───────────────────────────────────────────────

describe('provider registry', () => {
  test('exposes the five supported backends', () => {
    expect(WEB_SEARCH_PROVIDERS.map((p) => p.id)).toEqual([
      'zhipu',
      'tavily',
      'bocha',
      'serper',
      'bing',
    ]);
  });

  test('only bing is keyless', () => {
    const keyless = WEB_SEARCH_PROVIDERS.filter((p) => !p.needsKey).map((p) => p.id);
    expect(keyless).toEqual(['bing']);
  });

  test('isWebSearchProviderId accepts known ids only', () => {
    expect(isWebSearchProviderId('bing')).toBe(true);
    expect(isWebSearchProviderId('serper')).toBe(true);
    expect(isWebSearchProviderId('google')).toBe(false);
    expect(isWebSearchProviderId('')).toBe(false);
  });

  test('getWebSearchProviderMeta falls back to the first entry for an unknown id', () => {
    expect(getWebSearchProviderMeta('tavily').label).toBe('Tavily');
    expect(getWebSearchProviderMeta('nope' as never).id).toBe('zhipu');
  });
});

// ── Credential gating ───────────────────────────────────────────────

describe('credential gating', () => {
  test('a key-requiring provider without a key fails without any network call', async () => {
    const { calls } = stubFetch(() => ({ json: {} }));
    const res = await runWebSearch('tavily', { query: 'q' }, {});
    expect(res.status).toBe('error');
    expect(res.error).toBe('missing_api_key: tavily');
    expect(res.results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('a whitespace-only key counts as missing', async () => {
    const { calls } = stubFetch(() => ({ json: {} }));
    const res = await runWebSearch('bocha', { query: 'q' }, { apiKey: '   ' });
    expect(res.error).toBe('missing_api_key: bocha');
    expect(calls).toHaveLength(0);
  });

  test('bing needs no key and does reach the network', async () => {
    const { calls } = stubFetch(() => ({ text: '<ol></ol>' }));
    const res = await runWebSearch('bing', { query: 'q' }, {});
    expect(res.error).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

// ── Per-provider request shapes and response normalization ──────────

describe('provider request/response handling', () => {
  test('zhipu posts to /web_search with a Bearer token and normalizes search_result[]', async () => {
    const { calls } = stubFetch(() => ({
      json: {
        search_result: [
          {
            title: '智谱结果',
            link: 'https://news.example.com/a',
            content: '正文内容',
            publish_date: '2026-01-02',
            media: '示例新闻',
          },
        ],
      },
    }));

    const res = await runWebSearch('zhipu', { query: '大模型', count: 3 }, { apiKey: 'zk-1' });

    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer zk-1');
    expect(bodyOf(calls[0])).toMatchObject({
      search_query: '大模型',
      search_engine: 'search_std',
      count: 3,
    });

    expect(res.status).toBe('ok');
    expect(res.provider).toBe('zhipu');
    expect(res.results[0]).toEqual({
      title: '智谱结果',
      content: '正文内容',
      link: 'https://news.example.com/a',
      publish_date: '2026-01-02',
      media: '示例新闻',
    });
  });

  test('tavily maps results[] and picks up published_date', async () => {
    const { calls } = stubFetch(() => ({
      json: {
        results: [
          {
            title: 'Tavily hit',
            url: 'https://blog.example.org/post',
            content: 'snippet',
            published_date: '2026-03-04',
          },
        ],
      },
    }));

    const res = await runWebSearch('tavily', { query: 'q', count: 7 }, { apiKey: 'tv-1' });

    expect(calls[0].url).toBe('https://api.tavily.com/search');
    expect(bodyOf(calls[0])).toMatchObject({ query: 'q', max_results: 7 });
    // published_date (not publish_date) is tavily's field name — dropping it was a real bug.
    expect(res.results[0].publish_date).toBe('2026-03-04');
    // No media/site field in the payload: falls back to the link's hostname.
    expect(res.results[0].media).toBe('blog.example.org');
  });

  test('bocha unwraps the Bing-v7 style data.webPages.value envelope', async () => {
    const { calls } = stubFetch(() => ({
      json: {
        data: {
          webPages: {
            value: [
              { name: '博查标题', url: 'https://www.example.cn/x', summary: '摘要', siteName: '示例' },
            ],
          },
        },
      },
    }));

    const res = await runWebSearch('bocha', { query: 'q' }, { apiKey: 'bk-1' });

    expect(calls[0].url).toBe('https://api.bochaai.com/v1/web-search');
    expect(res.status).toBe('ok');
    // `name`/`summary`/`siteName` are bocha's field names, not title/content/media.
    expect(res.results[0]).toMatchObject({
      title: '博查标题',
      content: '摘要',
      link: 'https://www.example.cn/x',
      media: '示例',
    });
  });

  test('serper reads organic[] and sends the key in X-API-KEY', async () => {
    const { calls } = stubFetch(() => ({
      json: {
        organic: [{ title: 'Google hit', link: 'https://serp.example.com/1', snippet: 'desc' }],
      },
    }));

    const res = await runWebSearch('serper', { query: 'q' }, { apiKey: 'sp-1' });

    expect(calls[0].url).toBe('https://google.serper.dev/search');
    expect((calls[0].init.headers as Record<string, string>)['X-API-KEY']).toBe('sp-1');
    expect(bodyOf(calls[0])).toMatchObject({ q: 'q' });
    expect(res.results[0].link).toBe('https://serp.example.com/1');
  });

  test('a per-provider baseUrl override replaces the default origin', async () => {
    const { calls } = stubFetch(() => ({ json: { results: [] } }));
    await runWebSearch('tavily', { query: 'q' }, { apiKey: 'k', baseUrl: 'https://proxy.local/v2/' });
    expect(calls[0].url).toBe('https://proxy.local/v2/search');
  });
});

// ── count clamping ──────────────────────────────────────────────────

describe('count clamping', () => {
  test.each([
    [undefined, 5],
    [0, 1],
    [-4, 1],
    [999, 50],
    [3.9, 3],
  ])('count %s is sent as %s', async (input, expected) => {
    const { calls } = stubFetch(() => ({ json: { results: [] } }));
    await runWebSearch('tavily', { query: 'q', count: input as number | undefined }, { apiKey: 'k' });
    expect(bodyOf(calls[0]).max_results).toBe(expected);
  });
});

// ── Failure envelopes ───────────────────────────────────────────────

describe('failure envelopes', () => {
  test('a non-2xx response becomes status=error instead of throwing', async () => {
    stubFetch(() => ({ status: 401, text: '{"error":"bad key"}' }));
    const res = await runWebSearch('zhipu', { query: 'q' }, { apiKey: 'bad' });
    expect(res.status).toBe('error');
    expect(res.error).toContain('http_401');
    expect(res.error).toContain('bad key');
  });

  test('a network rejection becomes status=error instead of throwing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const res = await runWebSearch('tavily', { query: 'q' }, { apiKey: 'k' });
    expect(res.status).toBe('error');
    expect(res.error).toBe('TypeError: fetch failed');
    expect(res.provider).toBe('tavily');
  });

  test('a malformed JSON body becomes status=error instead of throwing', async () => {
    stubFetch(() => ({ text: '<html>not json</html>' }));
    const res = await runWebSearch('serper', { query: 'q' }, { apiKey: 'k' });
    expect(res.status).toBe('error');
    expect(res.results).toEqual([]);
  });

  test('zero parsed results is status=empty, not an error', async () => {
    stubFetch(() => ({ json: { results: [] } }));
    const res = await runWebSearch('tavily', { query: 'q' }, { apiKey: 'k' });
    expect(res.status).toBe('empty');
    expect(res.error).toBeNull();
  });

  test('every response carries the query, provider and a latency', async () => {
    stubFetch(() => ({ json: { results: [] } }));
    const res = await runWebSearch('tavily', { query: 'hello world' }, { apiKey: 'k' });
    expect(res.query).toBe('hello world');
    expect(res.provider).toBe('tavily');
    expect(res.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

// ── Bing HTML scraping ──────────────────────────────────────────────

const BING_HTML = `
<ol id="b_results">
<li class="b_algo" data-id="1">
  <h2><a href="https://example.com/real-page">Example &amp; Title</a></h2>
  <div class="b_caption"><p class="b_lineclamp4">First <strong>snippet</strong> body&nbsp;here</p></div>
</li>
<li class="b_algoBigWiki" data-id="2">
  <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9yZWFsLXBhZ2U&amp;ntb=1">Redirected Hit</a></h2>
  <p>Second snippet</p>
</li>
<li class="b_ans" data-id="3">
  <h2><a href="https://skip.example/">Answer card, not an organic result</a></h2>
  <p>should not surface</p>
</li>
</ol>`;

describe('bing html parsing', () => {
  test('extracts every b_algo* card and leaves non-organic cards alone', () => {
    const items = parseBingHtml(BING_HTML);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title)).toEqual(['Example & Title', 'Redirected Hit']);
    expect(items[0].url).toBe('https://example.com/real-page');
    expect(items[0].snippet).toBe('First snippet body here');
    expect(items[0].site).toBe('example.com');
  });

  test('resolves /ck/a redirect wrappers to the real destination', () => {
    expect(decodeBingRedirect('https://www.bing.com/ck/a?!&&p=x&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9yZWFsLXBhZ2U&ntb=1')).toBe(
      'https://example.com/real-page',
    );
  });

  test('passes through direct links and unusable redirects untouched', () => {
    expect(decodeBingRedirect('https://example.com/direct')).toBe('https://example.com/direct');
    // Bing /ck/a wrapper with no `u=` payload cannot be decoded — keep the wrapper.
    expect(decodeBingRedirect('https://www.bing.com/ck/a?!&&p=only')).toBe(
      'https://www.bing.com/ck/a?!&&p=only',
    );
  });

  test('runWebSearch(bing) scrapes the mocked SERP into normalized results', async () => {
    const { calls } = stubFetch(() => ({ text: BING_HTML }));
    const res = await runWebSearch('bing', { query: '大模型 平台', count: 10 }, {});

    expect(calls[0].url).toBe(
      `https://www.bing.com/search?q=${encodeURIComponent('大模型 平台')}&count=10`,
    );
    expect(res.status).toBe('ok');
    expect(res.results).toHaveLength(2);
    expect(res.results[1]).toMatchObject({
      title: 'Redirected Hit',
      link: 'https://example.com/real-page',
      content: 'Second snippet',
      media: 'example.com',
    });
  });
});

// ── Domain filtering ────────────────────────────────────────────────

const DOMAIN_ITEMS = [
  { link: 'https://example.com/a' },
  { link: 'https://news.example.com/b' },
  { link: 'https://www.example.com/c' },
  { link: 'https://notexample.com/d' },
  { link: 'https://evil-example.com/e' },
  { link: 'https://other.org/f' },
];

describe('domain filtering', () => {
  test('allowed_domains matches on label boundaries, not raw suffixes', () => {
    const kept = filterByDomain(DOMAIN_ITEMS, ['example.com']);
    // notexample.com must NOT match: the old endsWith() implementation let it through.
    expect(kept.map((i) => i.link)).toEqual([
      'https://example.com/a',
      'https://news.example.com/b',
      'https://www.example.com/c',
    ]);
  });

  test('blocked_domains matches on label boundaries too', () => {
    const kept = filterByDomain(DOMAIN_ITEMS, undefined, ['example.com']);
    expect(kept.map((i) => i.link)).toEqual([
      'https://notexample.com/d',
      'https://evil-example.com/e',
      'https://other.org/f',
    ]);
  });

  test('the domain list tolerates www. and leading-dot forms', () => {
    expect(filterByDomain(DOMAIN_ITEMS, ['www.example.com']).map((i) => i.link)).toEqual([
      'https://example.com/a',
      'https://news.example.com/b',
      'https://www.example.com/c',
    ]);
    expect(filterByDomain(DOMAIN_ITEMS, ['.example.com'])).toHaveLength(3);
  });

  test('allowed and blocked compose with block winning', () => {
    const kept = filterByDomain(DOMAIN_ITEMS, ['example.com'], ['news.example.com']);
    expect(kept.map((i) => i.link)).toEqual([
      'https://example.com/a',
      'https://www.example.com/c',
    ]);
  });

  test('an empty filter list is a no-op', () => {
    expect(filterByDomain(DOMAIN_ITEMS, [], [])).toHaveLength(DOMAIN_ITEMS.length);
  });

  test('runWebSearch applies the filters to the provider payload', async () => {
    stubFetch(() => ({
      json: {
        results: [
          { title: 'a', url: 'https://docs.example.com/a' },
          { title: 'b', url: 'https://www.baidu.com/b' },
          { title: 'c', url: 'https://faq.example.com/c' },
        ],
      },
    }));

    const res = await runWebSearch(
      'tavily',
      { query: 'q', allowed_domains: ['example.com'], blocked_domains: ['faq.example.com'] },
      { apiKey: 'k' },
    );

    expect(res.results.map((r) => r.link)).toEqual(['https://docs.example.com/a']);
  });

  test('filtering everything out reports status=empty', async () => {
    stubFetch(() => ({ json: { results: [{ title: 'a', url: 'https://other.org/a' }] } }));
    const res = await runWebSearch(
      'tavily',
      { query: 'q', allowed_domains: ['example.com'] },
      { apiKey: 'k' },
    );
    expect(res.status).toBe('empty');
  });
});
