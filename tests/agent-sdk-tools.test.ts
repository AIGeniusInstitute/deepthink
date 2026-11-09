/**
 * M0.3 约束测试：skills（F5）+ MCP（F6）+ 自包含工具（F7）。
 * 对应 PRD 测试用例：
 *   TC-5.1 skill 装配（物化 + 白名单注入）
 *   TC-5.2 skill 白名单收敛（bundle 外不可见）
 *   TC-6.1 stdio MCP 装配
 *   TC-6.2 http/sse MCP 装配
 *   TC-6.3 secret 缺失显式报错
 *   TC-7.1 自包含工具可用（disk_* / memory_* 本地；web_search 无凭据明确降级）
 *   TC-7.2 disk_* 路径穿越防护
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- mock SDK query（同 agent-sdk-runtime 测试的脚本化模式） ----
interface MockCall {
  prompt: unknown;
  options: Record<string, unknown>;
}
const queryCalls: MockCall[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...orig,
    query: ({ prompt, options }: MockCall) => {
      queryCalls.push({ prompt, options });
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-t',
          usage: {},
        };
      })();
    },
  };
});

const { Agent } = await import('../sdk/src/runtime.js');
const { computeContentHash, BUNDLE_SCHEMA_VERSION } = await import('../sdk/src/agent-bundle.js');
const { createTools, resolveDiskPath, htmlToMarkdown } = await import('../sdk/src/tools.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-tools-'));

interface BundleSpec {
  mcpServers?: Record<string, Record<string, unknown>>;
  secrets?: Array<{ ref: string; usedBy: string; optional: boolean }>;
  skills?: Record<string, Record<string, string>>;
}

function writeBundleAt(dir: string, spec: BundleSpec): void {
  const files: Record<string, string> = {
    'agent.json': JSON.stringify({
      id: 'a2',
      name: '工具测试 Agent',
      description: '',
      kind: 'assistant',
      systemPrompt: '你是测试助手。',
      model: null,
      engine: 'claude',
      maxTurns: null,
      temperature: null,
    }),
    'prompts/system.md': '你是测试助手。',
    'mcp/servers.json': JSON.stringify({ servers: spec.mcpServers ?? {} }),
  };
  for (const [skillId, skillFiles] of Object.entries(spec.skills ?? {})) {
    for (const [rel, content] of Object.entries(skillFiles)) {
      files[`skills/${skillId}/${rel}`] = content;
    }
  }
  const manifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    agent: { id: 'a2', name: '工具测试 Agent', kind: 'assistant' },
    requires: { tier: 'T1', hostTools: [] },
    secrets: spec.secrets ?? [],
    runtime: { engines: ['claude'], sdkRange: '^1.0.0', nodeRange: '>=22', platform: 'any', mcpDeps: {} },
    contentHash: '',
  };
  (manifest as { contentHash: string }).contentHash = computeContentHash(
    Object.entries(files).map(([p, c]) => [p, c] as [string, string]),
  );
  files['manifest.json'] = JSON.stringify(manifest);

  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
}

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows 占用容忍 */
  }
});

beforeEach(() => {
  queryCalls.length = 0;
});

describe('TC-5.1/5.2 skills 装配与白名单', () => {
  it('bundle 内联 skill 物化到 .claude/skills 并注入 skills 白名单', async () => {
    const dir = path.join(tmpRoot, 'b-skills');
    const ws = path.join(tmpRoot, 'ws-skills');
    writeBundleAt(dir, {
      skills: {
        'format-output': {
          'SKILL.md': '---\nname: format-output\ndescription: 按格式输出\n---\n使用表格。',
        },
      },
    });
    const agent = await Agent.fromBundle(dir, { workspace: ws, credentials: { apiKey: 'sk' } });
    // 物化检查（TC-5.1）
    const skillFile = path.join(ws, '.claude', 'skills', 'format-output', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);
    expect(fs.readFileSync(skillFile, 'utf-8')).toContain('按格式输出');
    // 白名单（TC-5.2：仅 bundle 内 skill；workspace 无 bundle 外 skill 目录）
    expect(agent.skillNames).toEqual(['format-output']);
    await agent.run('hi');
    expect(queryCalls[0].options.skills).toEqual(['format-output']);
  });

  it('无 skill 的 bundle 不注入 skills 选项（走 SDK 默认）', async () => {
    const dir = path.join(tmpRoot, 'b-noskills');
    writeBundleAt(dir, {});
    const agent = await Agent.fromBundle(dir, {
      workspace: path.join(tmpRoot, 'ws-noskills'),
      credentials: { apiKey: 'sk' },
    });
    await agent.run('hi');
    expect(queryCalls[0].options.skills).toBeUndefined();
  });
});

describe('TC-6.1/6.2 MCP 装配', () => {
  it('stdio MCP 注入 query options（env 值已由加载端解析）', async () => {
    const dir = path.join(tmpRoot, 'b-mcp-stdio');
    writeBundleAt(dir, {
      mcpServers: {
        echo: {
          command: 'node',
          args: ['echo.js'],
          env: { API_KEY: '${ENV:MY_KEY}' },
        },
      },
      secrets: [{ ref: '${ENV:MY_KEY}', usedBy: 'mcp/echo', optional: false }],
    });
    const agent = await Agent.fromBundle(dir, {
      workspace: path.join(tmpRoot, 'ws-mcp-stdio'),
      credentials: { apiKey: 'sk' },
      secrets: { MY_KEY: 'sk-loaded' },
    });
    await agent.run('hi');
    const mcp = queryCalls[0].options.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcp.echo.command).toBe('node');
    expect(mcp.echo.args).toEqual(['echo.js']);
    expect(mcp.echo.env).toEqual({ API_KEY: 'sk-loaded' });
  });

  it('http MCP 注入 type/url/headers（headers 值已解析）', async () => {
    const dir = path.join(tmpRoot, 'b-mcp-http');
    writeBundleAt(dir, {
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: '${ENV:AUTH_HEADER}' },
        },
      },
      secrets: [{ ref: '${ENV:AUTH_HEADER}', usedBy: 'mcp/remote', optional: false }],
    });
    const agent = await Agent.fromBundle(dir, {
      workspace: path.join(tmpRoot, 'ws-mcp-http'),
      credentials: { apiKey: 'sk' },
      secrets: { AUTH_HEADER: 'Bearer t' },
    });
    await agent.run('hi');
    const mcp = queryCalls[0].options.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcp.remote.type).toBe('http');
    expect(mcp.remote.url).toBe('https://mcp.example.com/mcp');
    expect(mcp.remote.headers).toEqual({ Authorization: 'Bearer t' });
  });
});

describe('TC-6.3 secret 缺失显式报错', () => {
  it('必需 secret 缺失 → fromBundle 抛错并列缺失清单', async () => {
    const dir = path.join(tmpRoot, 'b-missing');
    writeBundleAt(dir, {
      mcpServers: {
        secure: { command: 'node', args: [], env: { TOKEN: '${ENV:MISSING_TOKEN}' } },
      },
      secrets: [{ ref: '${ENV:MISSING_TOKEN}', usedBy: 'mcp/secure', optional: false }],
    });
    await expect(
      Agent.fromBundle(dir, {
        workspace: path.join(tmpRoot, 'ws-missing'),
        credentials: { apiKey: 'sk' },
        secrets: {}, // 不提供
        // 从 process.env 也不会有 MISSING_TOKEN
      }),
    ).rejects.toThrow(/missing required secrets.*MISSING_TOKEN/);
  });

  it('optional secret 缺失不阻塞加载', async () => {
    const dir = path.join(tmpRoot, 'b-optional');
    writeBundleAt(dir, {
      mcpServers: {
        soft: { command: 'node', args: [], env: { OPTIONAL_KEY: '${ENV:SOFT_KEY}' } },
      },
      secrets: [{ ref: '${ENV:SOFT_KEY}', usedBy: 'mcp/soft', optional: true }],
    });
    const agent = await Agent.fromBundle(dir, {
      workspace: path.join(tmpRoot, 'ws-optional'),
      credentials: { apiKey: 'sk' },
      secrets: {},
    });
    expect(agent).toBeDefined();
  });
});

describe('TC-7.1/7.2 自包含工具', () => {
  function toolCtx(workspace: string) {
    return createTools({ workspace });
  }
  const byName = (tools: ReturnType<typeof createTools>, name: string) =>
    tools.find((t) => t.name === name)!;

  it('disk_write / disk_list / disk_read 可用', async () => {
    const ws = path.join(tmpRoot, 'ws-disk');
    fs.mkdirSync(ws, { recursive: true });
    const tools = toolCtx(ws);
    const w = await byName(tools, 'disk_write').handler(
      { path: 'notes/a.md', content: 'hello 世界' },
      {} as never,
    );
    expect(w.isError).toBeFalsy();
    const l = await byName(tools, 'disk_list').handler({ path: 'notes' }, {} as never);
    expect(l.content[0].text).toContain('a.md');
    const r = await byName(tools, 'disk_read').handler({ path: 'notes/a.md' }, {} as never);
    expect(r.content[0].text).toBe('hello 世界');
  });

  it('TC-7.2 disk_read 路径穿越被拒', async () => {
    const ws = path.join(tmpRoot, 'ws-traversal');
    fs.mkdirSync(ws, { recursive: true });
    const tools = toolCtx(ws);
    for (const evil of ['../../etc/passwd', '..\\..\\windows\\system32', 'a/../../b']) {
      const r = await byName(tools, 'disk_read').handler({ path: evil }, {} as never);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('Path traversal');
    }
    // resolveDiskPath 直接验证
    expect(resolveDiskPath(ws, '../outside').ok).toBe(false);
    expect(resolveDiskPath(ws, 'inside/ok.txt').ok).toBe(true);
  });

  it('memory_append / memory_search / memory_get 可用', async () => {
    const ws = path.join(tmpRoot, 'ws-memory');
    fs.mkdirSync(ws, { recursive: true });
    const tools = toolCtx(ws);
    const a = await byName(tools, 'memory_append').handler(
      { content: '项目暗号是 42' },
      {} as never,
    );
    expect(a.isError).toBeFalsy();
    const s = await byName(tools, 'memory_search').handler({ query: '暗号' }, {} as never);
    expect(s.content[0].text).toContain('42');
    const g = await byName(tools, 'memory_get').handler({}, {} as never);
    expect(g.content[0].text).toContain('42');
  });

  it('web_search 无凭据时明确降级（不静默）', async () => {
    const tools = createTools({ workspace: path.join(tmpRoot, 'ws-ws') });
    const r = await byName(tools, 'web_search').handler({ query: 'test' }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('unavailable');
    expect(r.content[0].text).toContain('webSearch.apiKey');
  });

  it('htmlToMarkdown 提取标题与正文', () => {
    const { title, markdown } = htmlToMarkdown(
      '<html><head><title>测试页</title></head><body><h1>Hi</h1><p>内容 &amp; more</p><script>evil()</script></body></html>',
    );
    expect(title).toBe('测试页');
    expect(markdown).toContain('# Hi');
    expect(markdown).toContain('内容 & more');
    expect(markdown).not.toContain('evil()');
  });
});
