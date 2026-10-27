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
  parseJsonTolerant,
  runWebSearch,
} from '../src/web-search.js';

// ── agent-browser CLI mocking (browser backend) ────────────────────

const cli = vi.hoisted(() => {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown>; stdin: string }[] = [];
  let responder: (call: { cmd: string; args: string[]; opts: Record<string, unknown>; stdin: string }) => {
    error?: Error & { code?: string; killed?: boolean };
    stdout?: string;
    stderr?: string;
  } = () => ({ stdout: '[]' });
  let active = 0;
  let maxActive = 0;
  return {
    calls,
    get maxActive() {
      return maxActive;
    },
    setResponder(fn: typeof responder): void {
      responder = fn;
      calls.length = 0;
      active = 0;
      maxActive = 0;
    },
    respond(call: { cmd: string; args: string[]; opts: Record<string, unknown>; stdin: string }) {
      return responder(call);
    },
    enter(): void {
      active += 1;
      if (active > maxActive) maxActive = active;
    },
    leave(): void {
      active -= 1;
    },
  };
});

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const call = { cmd, args, opts, stdin: '' };
    cli.calls.push(call);
    cli.enter();
    const stdin = {
      on: () => stdin,
      write: (chunk: string) => {
        call.stdin += chunk;
        return true;
      },
      end: () => {
        const outcome = cli.respond(call);
        queueMicrotask(() => {
          cli.leave();
          cb(outcome.error ?? null, outcome.stdout ?? '', outcome.stderr ?? '');
        });
      },
    };
    return { stdin };
  },
}));

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
  test('exposes the six supported backends', () => {
    expect(WEB_SEARCH_PROVIDERS.map((p) => p.id)).toEqual([
      'zhipu',
      'tavily',
      'bocha',
      'serper',
      'bing',
      'browser',
    ]);
  });

  test('only the scrape backends are keyless', () => {
    const keyless = WEB_SEARCH_PROVIDERS.filter((p) => !p.needsKey).map((p) => p.id);
    expect(keyless).toEqual(['bing', 'browser']);
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

// ── Browser backend (agent-browser driven, keyless) ────────────────

/** Shape a `batch --json` stdout envelope the way agent-browser prints it. */
function batchStdout(entries: Record<string, unknown>[]): string {
  return JSON.stringify(entries.map((e) => ({ success: true, error: null, result: null, ...e })));
}

function batchWithEvalCards(cards: string, extra: Record<string, unknown> = {}): string {
  return batchStdout([
    { command: ['open', 'https://www.bing.com/search?q=q'], ...extra },
    { command: ['eval', 'script'], result: { result: cards } },
    { command: ['close'] },
  ]);
}

const RESULT_CARDS = JSON.stringify([
  { title: 'Alpha', url: 'https://alpha.example/a', snippet: 'first' },
  { title: 'Beta', url: 'https://beta.example/b', snippet: 'second' },
]);

describe('browser backend (agent-browser)', () => {
  test('one batch call runs open → extract → close in an isolated session', async () => {
    cli.setResponder(() => ({ stdout: batchWithEvalCards(RESULT_CARDS) }));

    const res = await runWebSearch('browser', { query: 'deep think' });

    expect(res.status).toBe('ok');
    expect(res.error).toBeNull();
    expect(cli.calls).toHaveLength(1);
    const call = cli.calls[0];
    // POSIX spawns agent-browser directly; win32 wraps it in `cmd.exe /d /s /c`
    // (a .cmd shim cannot be spawned without a shell). Assert the invariants
    // that hold for both shapes.
    const spawnText = [call.cmd, ...call.args].join(' ');
    expect(spawnText).toContain('agent-browser');
    expect(spawnText).toContain(`websearch-${process.pid}`);
    expect(spawnText).toContain('batch');
    expect(spawnText).toContain('--json');
    expect(call.opts.timeout).toBe(20_000);

    const commands = JSON.parse(call.stdin) as string[][];
    expect(commands[0]).toEqual(['open', 'https://www.bing.com/search?q=deep%20think']);
    expect(commands[1][0]).toBe('eval');
    expect(commands[1][1]).toContain('b_algo');
    expect(commands[2]).toEqual(['close']);
  });

  test('honours a baseUrl override (e.g. cn.bing.com)', async () => {
    cli.setResponder(() => ({ stdout: batchWithEvalCards(RESULT_CARDS) }));
    await runWebSearch('browser', { query: 'q' }, { baseUrl: 'https://cn.bing.com/' });
    const commands = JSON.parse(cli.calls[0].stdin) as string[][];
    expect(commands[0][1]).toBe('https://cn.bing.com/search?q=q');
  });

  test('normalizes cards into WebSearchResultItem', async () => {
    cli.setResponder(() => ({ stdout: batchWithEvalCards(RESULT_CARDS) }));

    const res = await runWebSearch('browser', { query: 'q' });

    expect(res.results).toEqual([
      { title: 'Alpha', content: 'first', link: 'https://alpha.example/a', publish_date: '', media: 'alpha.example' },
      { title: 'Beta', content: 'second', link: 'https://beta.example/b', publish_date: '', media: 'beta.example' },
    ]);
  });

  test('decodes Bing /ck/a redirect links to the real URL', async () => {
    const real = 'https://real.example/page';
    const redirect = `https://www.bing.com/ck/a?u=a1${Buffer.from(real, 'utf8').toString('base64url')}`;
    const cards = JSON.stringify([{ title: 'T', url: redirect, snippet: 's' }]);
    cli.setResponder(() => ({ stdout: batchWithEvalCards(cards) }));

    const res = await runWebSearch('browser', { query: 'q' });

    expect(res.results[0].link).toBe(real);
  });

  test('injects the clamped count into the extraction script', async () => {
    cli.setResponder(() => ({ stdout: batchWithEvalCards(RESULT_CARDS) }));
    await runWebSearch('browser', { query: 'q', count: 100 });
    const commands = JSON.parse(cli.calls[0].stdin) as string[][];
    expect(commands[1][1]).toContain('length >= 50');
  });

  test('applies domain filters to browser results', async () => {
    cli.setResponder(() => ({ stdout: batchWithEvalCards(RESULT_CARDS) }));
    const res = await runWebSearch('browser', { query: 'q', allowed_domains: ['alpha.example'] });
    expect(res.results.map((r) => r.link)).toEqual(['https://alpha.example/a']);
  });

  test('an empty result page reports status=empty', async () => {
    cli.setResponder(() => ({ stdout: batchWithEvalCards('[]') }));
    const res = await runWebSearch('browser', { query: 'q' });
    expect(res.status).toBe('empty');
    expect(res.results).toEqual([]);
  });

  test('a failed open surfaces the browser error', async () => {
    cli.setResponder(() => ({
      stdout: batchWithEvalCards(RESULT_CARDS, { success: false, error: { message: 'net::ERR_NAME_NOT_RESOLVED' } }),
    }));
    const res = await runWebSearch('browser', { query: 'q' });
    expect(res.status).toBe('error');
    expect(res.error).toContain('browser_open_failed');
    expect(res.error).toContain('net::ERR_NAME_NOT_RESOLVED');
  });

  test('an unparsable eval payload is a tool error, not a crash', async () => {
    cli.setResponder(() => ({ stdout: batchWithEvalCards('not-json') }));
    const res = await runWebSearch('browser', { query: 'q' });
    expect(res.status).toBe('error');
    expect(res.error).toContain('unparsable');
  });

  test('a missing agent-browser explains how to install it', async () => {
    cli.setResponder(() => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }));
    const res = await runWebSearch('browser', { query: 'q' });
    expect(res.status).toBe('error');
    expect(res.error).toContain('agent-browser_not_installed');
    expect(res.error).toContain('install-host-tools.sh');
  });

  test('a CLI failure reports stderr', async () => {
    cli.setResponder(() => ({ error: new Error('exit 1'), stderr: 'browser crashed' }));
    const res = await runWebSearch('browser', { query: 'q' });
    expect(res.status).toBe('error');
    expect(res.error).toContain('browser_cli_failed');
    expect(res.error).toContain('browser crashed');
  });

  test('a hung browser times out within the budget', async () => {
    cli.setResponder(() => ({ error: Object.assign(new Error('killed'), { killed: true }) }));
    const res = await runWebSearch('browser', { query: 'q' }, {}, 1234);
    expect(res.status).toBe('error');
    expect(res.error).toContain('browser_timeout');
    expect(res.error).toContain('1234ms');
  });

  test('tolerates log noise around the batch envelope', async () => {
    cli.setResponder(() => ({
      stdout: `daemon ready\n${batchWithEvalCards(RESULT_CARDS)}\ndone`,
    }));
    const res = await runWebSearch('browser', { query: 'q' });
    expect(res.status).toBe('ok');
    expect(res.results).toHaveLength(2);
  });

  test('runs concurrent searches one at a time (one session, one tab)', async () => {
    cli.setResponder(() => ({ stdout: batchWithEvalCards(RESULT_CARDS) }));
    const [a, b] = await Promise.all([
      runWebSearch('browser', { query: 'one' }),
      runWebSearch('browser', { query: 'two' }),
    ]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(cli.calls).toHaveLength(2);
    expect(cli.maxActive).toBe(1);
  });
});

describe('parseJsonTolerant', () => {
  test('parses clean JSON as-is', () => {
    expect(parseJsonTolerant('[1,2]', 'x')).toEqual([1, 2]);
  });

  test('unwraps a JSON-encoded string payload', () => {
    expect(parseJsonTolerant('"{\\"a\\":1}"', 'x')).toEqual({ a: 1 });
  });

  test('slices out surrounding log noise', () => {
    expect(parseJsonTolerant('noise [1,2] noise', 'x')).toEqual([1, 2]);
  });

  test('rejects garbage and empty output', () => {
    expect(() => parseJsonTolerant('nope', 'x')).toThrow('x_unparsable');
    expect(() => parseJsonTolerant('   ', 'x')).toThrow('x_empty');
  });
});
