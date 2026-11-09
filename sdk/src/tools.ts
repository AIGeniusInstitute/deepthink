/**
 * 自包含工具包（F7）—— web_fetch / web_search / disk_* / memory_*，
 * 零 IPC、纯本地实现，通过 SDK in-process MCP server 注册。
 *
 * 与 agent-runner/mcp-tools.ts 的关系：只搬「自包含」子集（A/B/C/D 回连
 * 分类中的 C 本地 + D 外部 HTTP），宿主回连类工具（send_message /
 * schedule_task / sandbox_* 等 T2）不在 SDK 范围——未实现即不注册。
 */
import fs from 'node:fs';
import path from 'node:path';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface ToolsContext {
  /** 工具的文件根（disk_* 的沙箱边界） */
  workspace: string;
  /** memory_* 的记忆目录（默认 {workspace}/memory） */
  memoryDir?: string;
  /** web_search 凭据（可选；缺失时工具返回明确降级提示） */
  webSearch?: {
    provider: string;
    apiKey?: string;
    baseUrl?: string;
  };
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** workspace 内安全路径解析（A7.2：路径穿越拒绝，对齐 agent-runner 语义）。 */
export function resolveDiskPath(
  root: string,
  relPath: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!relPath || relPath === '.' || relPath === '/') {
    return { ok: true, path: root };
  }
  const safeRoot = root.endsWith(path.sep) ? root : root + path.sep;
  const resolved = path.resolve(root, path.normalize(relPath));
  if (resolved !== root && !resolved.startsWith(safeRoot)) {
    return { ok: false, error: 'Path traversal detected' };
  }
  return { ok: true, path: resolved };
}

// ---- web_fetch：fetch + 最小 HTML→Markdown（自包含，无三方依赖） ----

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

export function htmlToMarkdown(html: string, maxChars = 20000): { title: string; markdown: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : '';
  let h = html.replace(/<(script|style|nav|footer|aside|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => `\n\n${'#'.repeat(Number(lvl))} ${stripTags(inner).trim()}\n\n`)
    .replace(/<a\b[^>]*href\s*=\s*['"]([^'"]*)['"][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => `[${stripTags(inner).trim()}](${href})`)
    .replace(/<(pre|code)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => `\n\`\`\`\n${decodeEntities(stripTags(inner)).trim()}\n\`\`\`\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `- ${stripTags(inner).trim()}\n`)
    .replace(/<(p|div|br|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const markdown = decodeEntities(h)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
  return { title, markdown };
}

async function fetchUrlAsMarkdown(url: string): Promise<{ url: string; title: string; markdown: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await res.text();
  const { title, markdown } = htmlToMarkdown(html);
  return { url, title, markdown };
}

// ---- memory_*：workspace 内日期记忆文件 ----

function memoryFile(memoryDir: string, date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return path.join(memoryDir, `${d}.md`);
}

/**
 * 构造自包含工具定义数组。
 */
export function createTools(ctx: ToolsContext): SdkMcpToolDefinition<any>[] {
  const memoryDir = ctx.memoryDir ?? path.join(ctx.workspace, 'memory');

  return [
    tool(
      'web_fetch',
      'Fetch a URL and convert the page to Markdown. Answer the `prompt` against the returned markdown.',
      {
        url: z.string().describe('The URL to fetch (http/https)'),
        prompt: z.string().describe('What to extract or answer from the page content'),
      },
      async (args) => {
        try {
          const result = await fetchUrlAsMarkdown(args.url);
          return ok(JSON.stringify(result));
        } catch (e) {
          return err(`web_fetch failed: ${(e as Error).message}`);
        }
      },
    ),

    tool(
      'web_search',
      'Search the web and return top results with snippets.',
      { query: z.string().describe('The search query') },
      async (args) => {
        const cfg = ctx.webSearch;
        if (!cfg?.apiKey && cfg?.provider !== 'browser') {
          return err(
            'web_search unavailable: no search provider credentials configured. ' +
              'Provide webSearch.apiKey in Agent options, or use web_fetch instead.',
          );
        }
        try {
          // 动态 import 避免未配置搜索时也加载共享搜索实现
          const { runWebSearch } = await import('./web-search.js');
          const results = await runWebSearch(cfg.provider as never, { query: args.query }, {
            apiKey: cfg.apiKey ?? '',
            baseUrl: cfg.baseUrl ?? '',
          });
          return ok(JSON.stringify(results));
        } catch (e) {
          return err(`web_search failed: ${(e as Error).message}`);
        }
      },
    ),

    // ---- disk_*（workspace 文件操作，路径穿越防护） ----
    tool(
      'disk_list',
      'List files in a workspace directory.',
      { path: z.string().optional().describe('Relative path inside the workspace (default root)') },
      async (args) => {
        const p = resolveDiskPath(ctx.workspace, args.path ?? '');
        if (!p.ok) return err(p.error);
        try {
          const entries = fs.readdirSync(p.path, { withFileTypes: true });
          return ok(
            JSON.stringify(
              entries.map((e) => ({
                name: e.name,
                type: e.isDirectory() ? 'directory' : 'file',
                size: e.isDirectory() ? undefined : fs.statSync(path.join(p.path, e.name)).size,
              })),
            ),
          );
        } catch (e) {
          return err(`disk_list failed: ${(e as Error).message}`);
        }
      },
    ),

    tool(
      'disk_read',
      'Read a text file from the workspace.',
      { path: z.string().describe('Relative path inside the workspace') },
      async (args) => {
        const p = resolveDiskPath(ctx.workspace, args.path);
        if (!p.ok) return err(p.error);
        try {
          return ok(fs.readFileSync(p.path, 'utf-8'));
        } catch (e) {
          return err(`disk_read failed: ${(e as Error).message}`);
        }
      },
    ),

    tool(
      'disk_write',
      'Write a text file in the workspace (creates parent directories).',
      {
        path: z.string().describe('Relative path inside the workspace'),
        content: z.string().describe('File content'),
      },
      async (args) => {
        const p = resolveDiskPath(ctx.workspace, args.path);
        if (!p.ok) return err(p.error);
        try {
          fs.mkdirSync(path.dirname(p.path), { recursive: true });
          fs.writeFileSync(p.path, args.content, 'utf-8');
          return ok(`written: ${args.path} (${Buffer.byteLength(args.content)} bytes)`);
        } catch (e) {
          return err(`disk_write failed: ${(e as Error).message}`);
        }
      },
    ),

    tool(
      'disk_delete',
      'Delete a file or empty directory in the workspace.',
      { path: z.string().describe('Relative path inside the workspace') },
      async (args) => {
        const p = resolveDiskPath(ctx.workspace, args.path);
        if (!p.ok) return err(p.error);
        try {
          fs.rmSync(p.path, { recursive: false, force: true });
          return ok(`deleted: ${args.path}`);
        } catch (e) {
          return err(`disk_delete failed: ${(e as Error).message}`);
        }
      },
    ),

    // ---- memory_*（日期记忆） ----
    tool(
      'memory_append',
      'Append a note to today\'s memory file.',
      { content: z.string().describe('The note to remember') },
      async (args) => {
        try {
          fs.mkdirSync(memoryDir, { recursive: true });
          const file = memoryFile(memoryDir);
          const stamp = new Date().toISOString();
          fs.appendFileSync(file, `\n[${stamp}] ${args.content}\n`, 'utf-8');
          return ok(`appended to ${path.basename(file)}`);
        } catch (e) {
          return err(`memory_append failed: ${(e as Error).message}`);
        }
      },
    ),

    tool(
      'memory_search',
      'Search memory files by keyword. Returns matching lines with dates.',
      {
        query: z.string().describe('Keyword to search for'),
        limit: z.number().optional().describe('Max results (default 20)'),
      },
      async (args) => {
        try {
          if (!fs.existsSync(memoryDir)) return ok('[]');
          const hits: Array<{ date: string; line: string }> = [];
          const limit = args.limit ?? 20;
          for (const name of fs.readdirSync(memoryDir).sort().reverse()) {
            if (!name.endsWith('.md')) continue;
            const content = fs.readFileSync(path.join(memoryDir, name), 'utf-8');
            for (const line of content.split('\n')) {
              if (line.toLowerCase().includes(args.query.toLowerCase())) {
                hits.push({ date: name.replace(/\.md$/, ''), line: line.trim() });
                if (hits.length >= limit) return ok(JSON.stringify(hits));
              }
            }
          }
          return ok(JSON.stringify(hits));
        } catch (e) {
          return err(`memory_search failed: ${(e as Error).message}`);
        }
      },
    ),

    tool(
      'memory_get',
      'Read a memory file by date (YYYY-MM-DD, default today).',
      { date: z.string().optional().describe('Date in YYYY-MM-DD format') },
      async (args) => {
        const p = resolveDiskPath(memoryDir, `${args.date ?? new Date().toISOString().slice(0, 10)}.md`);
        if (!p.ok) return err(p.error);
        try {
          return ok(fs.readFileSync(p.path, 'utf-8'));
        } catch {
          return ok('(no memory for this date)');
        }
      },
    ),
  ];
}

/** 封装为 SDK in-process MCP server（挂进 options.mcpServers）。 */
export function createToolsServer(ctx: ToolsContext): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'deepthink-tools',
    version: '1.0.0',
    tools: createTools(ctx),
  });
}
