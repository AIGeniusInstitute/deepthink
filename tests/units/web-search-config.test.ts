/**
 * src/web-search-config.ts — which search backend agent containers run with, the
 * credentials injected for it, and the settings-page connectivity self-test.
 *
 * Also covers container-runner's resolveZhipuApiKey(), the legacy ZHIPU_API_KEY
 * discovery that used to hardcode /home/me/zhipu_web_search/.env.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// config.ts captures DATA_DIR at module load, so point it at a throwaway dir
// before any src module is imported.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepthink-websearch-cfg-'));
const dataDir = path.join(tmpRoot, 'data');
process.env.DEEPTHINK_DATA_DIR = dataDir;

const homeDir = path.join(tmpRoot, 'home');
const bareHomeDir = path.join(tmpRoot, 'bare-home');
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(bareHomeDir, { recursive: true });

const CONFIG_PATH = path.join(dataDir, 'config', 'web-search.json');

// The keyless browser backend shells out to agent-browser; stub it so these
// tests never launch a real browser. Other child_process exports pass through.
const cliCalls = vi.hoisted(() => [] as { args: string[]; stdin: string }[]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cliCalls.push({ args, stdin: '' });
      const entry = cliCalls[cliCalls.length - 1];
      const stdin = {
        on: () => stdin,
        write: (chunk: string) => {
          entry.stdin += chunk;
          return true;
        },
        end: () => {
          queueMicrotask(() =>
            cb(
              null,
              JSON.stringify([
                { command: ['open', 'x'], success: true, error: null, result: null },
                {
                  command: ['eval', 's'],
                  success: true,
                  error: null,
                  result: { result: '[{"title":"T","url":"https://t.example/","snippet":"s"}]' },
                },
                { command: ['close'], success: true, error: null, result: null },
              ]),
              '',
            ),
          );
        },
      };
      return { stdin };
    },
  };
});

const { logger } = await import('../../src/logger.js');
const { getWebSearchConfig, resolveWebSearchEnv, saveWebSearchConfig, testWebSearchConnection } =
  await import('../../src/web-search-config.js');
const { resolveZhipuApiKey } = await import('../../src/container-runner.js');

/** Env vars this suite manipulates; restored once at the end. */
const MANAGED_VARS = [
  'WEB_SEARCH_PROVIDER',
  'WEB_SEARCH_API_KEY',
  'WEB_SEARCH_BASE_URL',
  'ZHIPU_API_KEY',
  'ZHIPU_WEB_SEARCH_ENV',
] as const;

const originalEnv: Record<string, string | undefined> = { HOME: process.env.HOME };
for (const key of MANAGED_VARS) originalEnv[key] = process.env[key];

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of MANAGED_VARS) delete process.env[key];
  process.env.HOME = homeDir;
  fs.rmSync(CONFIG_PATH, { force: true });
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.unstubAllGlobals();
  fs.rmSync(path.join(homeDir, 'zhipu_web_search'), { recursive: true, force: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Provider selection ──────────────────────────────────────────────

describe('resolveWebSearchEnv — provider selection', () => {
  test('nothing configured anywhere falls back to the keyless browser backend', () => {
    const { provider, env } = resolveWebSearchEnv();
    expect(provider).toBe('browser');
    expect(env).toEqual({
      WEB_SEARCH_PROVIDER: 'browser',
      WEB_SEARCH_BASE_URL: 'https://www.bing.com',
    });
    // No WEB_SEARCH_API_KEY at all — the keyless provider must not be handed an empty one.
    expect(env).not.toHaveProperty('WEB_SEARCH_API_KEY');
  });

  test('the legacy ZHIPU_API_KEY discovery keeps a zhipu-only deployment working', () => {
    const { provider, env } = resolveWebSearchEnv('zk-legacy');
    expect(provider).toBe('zhipu');
    expect(env.WEB_SEARCH_API_KEY).toBe('zk-legacy');
    expect(env.WEB_SEARCH_BASE_URL).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  test('WEB_SEARCH_PROVIDER env is honoured when the settings page has nothing saved', () => {
    process.env.WEB_SEARCH_PROVIDER = 'tavily';
    process.env.WEB_SEARCH_API_KEY = 'tv-env';
    const { provider, env } = resolveWebSearchEnv();
    expect(provider).toBe('tavily');
    expect(env.WEB_SEARCH_API_KEY).toBe('tv-env');
    expect(env.WEB_SEARCH_BASE_URL).toBe('https://api.tavily.com');
  });

  test('a saved config outranks both the env var and the legacy zhipu key', () => {
    process.env.WEB_SEARCH_PROVIDER = 'serper';
    saveWebSearchConfig({ active: 'bocha', providers: { bocha: { apiKey: 'bk-saved' } } });

    const { provider, env } = resolveWebSearchEnv('zk-legacy');
    expect(provider).toBe('bocha');
    expect(env.WEB_SEARCH_API_KEY).toBe('bk-saved');
  });

  test('a saved baseUrl override reaches the container env with trailing slashes trimmed', () => {
    saveWebSearchConfig({
      active: 'tavily',
      providers: { tavily: { apiKey: 'tv', baseUrl: 'https://proxy.local/v2/' } },
    });
    expect(resolveWebSearchEnv().env.WEB_SEARCH_BASE_URL).toBe('https://proxy.local/v2');
  });

  test('a key-requiring provider saved without a key does NOT silently fall back', () => {
    saveWebSearchConfig({ active: 'serper', providers: {} });

    const { provider, env } = resolveWebSearchEnv('zk-legacy');
    expect(provider).toBe('serper');
    expect(env).not.toHaveProperty('WEB_SEARCH_API_KEY');
    expect(warnSpy).toHaveBeenCalledWith(
      { provider: 'serper' },
      expect.stringContaining('needs an API key'),
    );
  });
});

// ── Config persistence ──────────────────────────────────────────────

describe('config persistence', () => {
  test('missing config reads as null', () => {
    expect(getWebSearchConfig()).toBeNull();
  });

  test('save → read round-trips and writes the file 0600', () => {
    saveWebSearchConfig({
      active: 'tavily',
      providers: { tavily: { apiKey: '  tv-1  ', baseUrl: 'https://api.tavily.com/' } },
    });

    expect(getWebSearchConfig()).toEqual({
      active: 'tavily',
      providers: { tavily: { apiKey: 'tv-1', baseUrl: 'https://api.tavily.com' } },
    });
    expect(fs.statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
  });

  test('a provider whose credentials were cleared in the UI is dropped on save', () => {
    saveWebSearchConfig({
      active: 'tavily',
      providers: {
        bing: { apiKey: '', baseUrl: '' },
        tavily: { apiKey: '  ', baseUrl: '   ' },
      },
    });

    expect(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))).toEqual({
      active: 'tavily',
      providers: {},
    });
    expect(getWebSearchConfig()).toEqual({ active: 'tavily', providers: {} });
  });

  test('unknown provider ids in a hand-edited file are ignored', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        active: 'bing',
        providers: { bogus: { apiKey: 'nope' }, serper: { apiKey: 'sp-1' } },
      }),
    );

    expect(getWebSearchConfig()).toEqual({
      active: 'bing',
      providers: { serper: { apiKey: 'sp-1' } },
    });
  });

  test('an unparseable config file degrades to unconfigured instead of throwing', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, '{ not json');
    expect(getWebSearchConfig()).toBeNull();
  });

  test('an unknown active provider degrades to unconfigured', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ active: 'google', providers: {} }));
    expect(getWebSearchConfig()).toBeNull();
  });
});

// ── Connectivity self-test ──────────────────────────────────────────

interface FetchCall {
  url: string;
  init: RequestInit;
}

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

describe('testWebSearchConnection', () => {
  test('targets the browser backend when nothing is configured', async () => {
    cliCalls.length = 0;
    const result = await testWebSearchConnection();
    expect(result.provider).toBe('browser');
    expect(result.status).toBe('ok');
    expect(cliCalls[0].args.join(' ')).toContain('batch');
    const commands = JSON.parse(cliCalls[0].stdin) as string[][];
    expect(commands[0][1]).toContain('https://www.bing.com/search?q=');
  });

  test('targets the saved provider by default', async () => {
    saveWebSearchConfig({ active: 'tavily', providers: { tavily: { apiKey: 'tv-saved' } } });
    const { calls } = stubFetch(() => ({ json: { results: [] } }));

    const result = await testWebSearchConnection();

    expect(result.provider).toBe('tavily');
    expect(calls[0].url).toBe('https://api.tavily.com/search');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tv-saved');
  });

  test('unsaved overrides beat the stored credentials — that is what the UI asks about', async () => {
    saveWebSearchConfig({ active: 'tavily', providers: { tavily: { apiKey: 'tv-saved' } } });
    const { calls } = stubFetch(() => ({ json: { results: [] } }));

    await testWebSearchConnection('tavily', { apiKey: 'tv-typed-but-unsaved' });

    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tv-typed-but-unsaved',
    );
  });

  test('a bad credential comes back as a reportable error, not a thrown exception', async () => {
    stubFetch(() => ({ status: 401, text: '{"error":"invalid api key"}' }));
    const result = await testWebSearchConnection('tavily', { apiKey: 'nope' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('http_401');
  });
});

// ── Legacy ZHIPU_API_KEY discovery ──────────────────────────────────

describe('resolveZhipuApiKey', () => {
  /** Write an env file at $HOME/zhipu_web_search/.env and return its path. */
  function writeHomeEnvFile(contents: string): string {
    const envPath = path.join(homeDir, 'zhipu_web_search', '.env');
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, contents);
    return envPath;
  }

  test('the host env var wins over every file', () => {
    process.env.ZHIPU_API_KEY = 'zk-inline';
    writeHomeEnvFile('ZHIPU_API_KEY=zk-from-home\n');
    expect(resolveZhipuApiKey()).toBe('zk-inline');
  });

  test('ZHIPU_WEB_SEARCH_ENV wins over the home directory default', () => {
    const explicit = path.join(tmpRoot, 'explicit.env');
    fs.writeFileSync(explicit, 'ZHIPU_API_KEY=zk-explicit\n');
    process.env.ZHIPU_WEB_SEARCH_ENV = explicit;
    writeHomeEnvFile('ZHIPU_API_KEY=zk-from-home\n');

    expect(resolveZhipuApiKey()).toBe('zk-explicit');
  });

  test('a miss on ZHIPU_WEB_SEARCH_ENV falls through to $HOME/zhipu_web_search/.env', () => {
    // Regression: the original implementation consulted exactly one path —
    // ZHIPU_WEB_SEARCH_ENV, defaulting to the hardcoded /home/me/zhipu_web_search/.env.
    // Any machine that was not that original Linux dev box therefore got no key at
    // all, and web_search returned `missing_api_key` on every single call.
    process.env.ZHIPU_WEB_SEARCH_ENV = path.join(tmpRoot, 'absent.env');
    writeHomeEnvFile('ZHIPU_API_KEY=zk-from-home\n');

    expect(resolveZhipuApiKey()).toBe('zk-from-home');
  });

  test('returns undefined when no source yields a key', () => {
    process.env.HOME = bareHomeDir;
    process.env.ZHIPU_WEB_SEARCH_ENV = path.join(tmpRoot, 'also-absent.env');
    expect(resolveZhipuApiKey()).toBeUndefined();
  });

  test('an env file without the key is not mistaken for a hit', () => {
    process.env.HOME = bareHomeDir;
    const noKey = path.join(tmpRoot, 'no-key.env');
    fs.writeFileSync(noKey, 'OTHER_VAR=1\n');
    process.env.ZHIPU_WEB_SEARCH_ENV = noKey;
    expect(resolveZhipuApiKey()).toBeUndefined();
  });
});
