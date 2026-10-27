/**
 * Lightweight MCP client used by the "MCP 服务器" module to list a server's
 * tools (tools/list) and test-call them (tools/call) directly from the UI.
 *
 * Each list/call opens a one-shot connection and closes it in `finally`, so a
 * stdio server's child process is always torn down afterwards.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from './logger.js';

// --- Types ---

export interface McpServerConfig {
  // http/sse type
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  // stdio type
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content: McpToolCallContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
}

// --- Timeouts ---

const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

// --- Helpers ---

export function buildTransport(cfg: McpServerConfig): Transport {
  const isHttp = cfg.type === 'http';
  const isSse = cfg.type === 'sse';

  if (isHttp || isSse) {
    const url = cfg.url;
    if (!url) {
      throw new Error('HTTP/Sse MCP server missing url');
    }
    const parsed = new URL(url);
    const headers = cfg.headers && Object.keys(cfg.headers).length > 0 ? cfg.headers : undefined;
    if (isHttp) {
      return new StreamableHTTPClientTransport(parsed, {
        requestInit: headers ? { headers } : undefined,
      });
    }
    // SSE (deprecated in MCP spec, kept for backward compatibility)
    return new SSEClientTransport(parsed, {
      requestInit: headers ? { headers } : undefined,
    });
  }

  const command = cfg.command;
  if (!command) {
    throw new Error('stdio MCP server missing command');
  }
  // Merge the server's custom env on top of a safe default environment
  // (PATH/HOME/etc). Passing env alone would drop PATH and the child fails.
  const wrapped = wrapWinBatchCommand(cfg);
  return new StdioClientTransport({
    command: wrapped.command as string,
    args: wrapped.args ?? [],
    env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
    stderr: 'ignore',
  });
}

// --- Windows 批处理命令兼容 ---

/**
 * Windows 上 Node child_process.spawn 无法直接启动 .cmd/.bat（Node 的
 * CVE-2024-27980 安全修复后报 spawn EINVAL），而 MCP stdio transport 底层
 * 就是 spawn，用户侧症状是 "MCP error -32000: Connection closed"。
 * 改写为 `cmd.exe /c <原命令> ...<原 args>` 前缀形式后可正常拉起。
 *
 * 仅适用于命令将在 Windows 宿主进程 spawn 的路径：本模块的工具列表/测试
 * 调用、宿主机模式的 settings.json（container-runner）、开放平台 query 的
 * mcpServers（open-platform/agent-service）。Docker 模式下命令在 Linux 容器
 * 内执行，不要改写。
 */
export function wrapWinBatchCommand<T extends { command?: unknown; args?: unknown }>(
  cfg: T,
  platform: NodeJS.Platform = process.platform,
): T {
  if (platform !== 'win32') return cfg;
  const raw = typeof cfg.command === 'string' ? cfg.command.trim().replace(/^"(.*)"$/, '$1') : '';
  if (!/\.(cmd|bat)$/i.test(raw)) return cfg;
  const args = Array.isArray(cfg.args)
    ? (cfg.args as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  return { ...cfg, command: process.env.ComSpec || 'cmd.exe', args: ['/c', raw, ...args] } as T;
}

/** 对整个 mcpServers 映射逐个应用 {@link wrapWinBatchCommand}。 */
export function wrapWinBatchServers<T extends { command?: unknown; args?: unknown }>(
  servers: Record<string, T>,
  platform: NodeJS.Platform = process.platform,
): Record<string, T> {
  if (platform !== 'win32') return servers;
  const out: Record<string, T> = {};
  for (const [name, entry] of Object.entries(servers)) {
    out[name] = wrapWinBatchCommand(entry, platform);
  }
  return out;
}

/** Convert an unknown thrown value into a clean, user-readable message. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    // ENOENT (stdio spawn failure) surfaces via onerror / connect rejection.
    if (code === 'ENOENT') {
      return `命令不存在或无法执行：${err.message}`;
    }
    // EINVAL：Node 拒绝直接启动 Windows 批处理（.cmd/.bat），需经 cmd /c。
    if (code === 'EINVAL') {
      return `命令无法被直接启动：${err.message}（Windows 批处理 .cmd/.bat 需通过 cmd /c 执行）`;
    }
    return err.message;
  }
  return String(err);
}

// --- Public API ---

export async function listMcpTools(cfg: McpServerConfig): Promise<McpToolInfo[]> {
  const transport = buildTransport(cfg);
  const client = new Client({ name: 'deepthink', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    const result = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  } catch (err) {
    logger.warn({ err: toErrorMessage(err) }, 'mcp listTools failed');
    throw new Error(toErrorMessage(err));
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close errors on a failed connection
    }
  }
}

export async function callMcpTool(
  cfg: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const transport = buildTransport(cfg);
  const client = new Client({ name: 'deepthink', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    const raw = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    const result = raw as {
      content?: McpToolCallContentItem[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    return {
      content: Array.isArray(result.content) ? result.content : [],
      isError: result.isError === true,
      structuredContent: result.structuredContent,
    };
  } catch (err) {
    logger.warn({ err: toErrorMessage(err), tool: toolName }, 'mcp callTool failed');
    throw new Error(toErrorMessage(err));
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
  }
}
