/**
 * Agent as a Service — 同步/流式执行一个 Agent Studio Agent。
 *
 * 加载 agent_definitions 的 system_prompt / model / max_turns / temperature，
 * 注入 MCP 挂载（mcpServers）与 workers（agents），用 Claude Agent SDK
 * query() 执行并返回 Agent 文本。与 group-queue / IM 通道解耦，专供外部
 * HTTP SDK 调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { GROUPS_DIR } from '../config.js';
import {
  buildClaudeEnvLines,
  getClaudeProviderConfig,
  getSystemSettings,
} from '../runtime-config.js';
import {
  getAgentDefinitionById,
  getRegisteredGroup,
  getUserById,
  listAgentMounts,
  listAgentWorkers,
  type AgentDefinitionRow,
} from '../db.js';
import { loadUserMcpServers } from '../mcp-utils.js';
import { logger } from '../logger.js';
import { billOpenPlatformUsage } from './billing.js';

/**
 * Agent 单次运行的时长上限。用平台统一的 `containerTimeout`（默认 30 分钟，
 * 设置页 / `CONTAINER_TIMEOUT` 可调），与容器 / 宿主机路径同一把尺子。
 *
 * 这里曾硬编码 120s（同步）/ 300s（流式），但一次 Agent 运行的耗时由任务决定
 * 而非 HTTP 层：本平台同一个 Agent 在 web 路径下写完一篇 44KB 论文要 ~15 分钟，
 * 于是走 API 的长任务 100% 被 AbortController 掐断。
 */
function agentTimeoutMs(): number {
  return getSystemSettings().containerTimeout;
}

/** 把 Agent Studio 的 name 转成 SDK 子 Agent 合法 key（与 agent-runner 同构）。 */
function sanitizeAgentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * orchestrator-workers：把 worker 定义转成 SDK `agents` 条目。
 * DeepThink 用规范化 agent_worker_links 表，listAgentWorkers 返回 JOIN
 * 后的完整 AgentDefinitionRow[]，直接映射字段即可。
 */
function buildWorkerAgents(
  workers: AgentDefinitionRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const used = new Set<string>();
  for (const w of workers) {
    if (w.enabled !== 1) continue;
    let name = sanitizeAgentName(w.name) || `worker-${w.id.slice(0, 8)}`;
    while (used.has(name)) name = `${name}-${w.id.slice(0, 6)}`;
    used.add(name);
    out[name] = {
      description: `${w.name}${w.description && w.description !== w.name ? ` — ${w.description}` : ''}`,
      prompt:
        w.system_prompt?.trim() ||
        `You are "${w.name}". Help the orchestrator complete delegated subtasks autonomously and report results back.`,
      ...(w.model && w.model.trim() ? { model: w.model.trim() } : {}),
      ...(w.max_turns != null ? { maxTurns: w.max_turns } : {}),
    };
  }
  return out;
}

/** 解析 Agent 的 MCP 挂载为 SDK mcpServers 配置。 */
function resolveAgentMcpServers(userId: string, agentDefId: string): Record<string, unknown> {
  const mounts = listAgentMounts(agentDefId).filter((m) => m.resource_type === 'mcp_server');
  if (mounts.length === 0) return {};
  const userMcp = loadUserMcpServers(userId);
  const out: Record<string, unknown> = {};
  for (const m of mounts) {
    const cfg = userMcp[m.resource_id];
    if (!cfg) continue;
    out[m.resource_id] = {
      type: typeof cfg.type === 'string' ? cfg.type : 'stdio',
      ...(typeof cfg.command === 'string' ? { command: cfg.command } : {}),
      ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
      ...(cfg.env && typeof cfg.env === 'object' ? { env: cfg.env } : {}),
      ...(typeof cfg.url === 'string' ? { url: cfg.url } : {}),
    };
  }
  return out;
}

interface ResolvedAgent {
  def: {
    id: string;
    system_prompt: string;
    model: string | null;
    max_turns: number | null;
    temperature: number | null;
  };
  model: string;
  mcpServers: Record<string, unknown>;
  agents: Record<string, unknown>;
  /** Agent 的工作目录（SDK `Options.cwd`），见 resolveAgentWorkspaceDir。 */
  workspaceDir: string;
}

/**
 * Agent 的工作目录。与 Agent Studio「测试对话」同一间工作区（jid `web:agent-{id}`；
 * 改名前的历史工作区 jid 为 `web:agent-test-{id}`，folder 沿用注册时那个值）。
 *
 * 必须显式传给 SDK：`Options.cwd` 的默认值是 **`process.cwd()`**，而本服务从仓库根目录
 * 启动——不传就等于把平台源码树当成一个 bypassPermissions Agent 的工作目录，它既能改平台
 * 代码，写出来的产物（论文等）也会落进仓库。web / IM 路径的等价做法见
 * `container-runner.ts` 的 `cwd: groupDir`。
 *
 * 目录不存在时创建（用户没点过"测试对话"就不会有）；创建失败让它抛——宁可这次调用报错，
 * 也不要静默退回仓库根目录运行。
 */
function resolveAgentWorkspaceDir(agentId: string): string {
  const registered =
    getRegisteredGroup(`web:agent-${agentId}`) ?? getRegisteredGroup(`web:agent-test-${agentId}`);
  const dir = path.join(GROUPS_DIR, registered?.folder ?? `agent-${agentId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 解析 Agent 定义 + 权限。返回 {error,status} 或 ResolvedAgent。 */
export function resolveAgent(
  agentId: string,
  userId: string,
): { error: string; status: number } | { agent: ResolvedAgent } {
  const def = getAgentDefinitionById(agentId);
  if (!def) return { error: 'Agent not found', status: 404 };

  const user = getUserById(userId);
  const isAdmin = user?.role === 'admin';
  if (def.user_id !== userId && !isAdmin) {
    return { error: 'You do not have access to this agent', status: 403 };
  }
  if (def.enabled !== 1) {
    return { error: 'Agent is disabled', status: 400 };
  }

  const provider = getClaudeProviderConfig();
  const model = def.model?.trim() || provider.anthropicModel || undefined;

  return {
    agent: {
      def: {
        id: def.id,
        system_prompt: def.system_prompt,
        model: def.model,
        max_turns: def.max_turns,
        temperature: def.temperature,
      },
      model: model || '',
      mcpServers: resolveAgentMcpServers(def.user_id, agentId),
      agents: buildWorkerAgents(listAgentWorkers(agentId)),
      workspaceDir: resolveAgentWorkspaceDir(agentId),
    },
  };
}

/** 构造 SDK query options（非流式与流式共用）。 */
function buildQueryOptions(
  agent: ResolvedAgent,
  timeoutMs: number,
): { options: Record<string, unknown>; abortController: AbortController; timer: NodeJS.Timeout } {
  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  // unref 防止长任务把事件循环钉住；abort 时由 finally 清理。
  timer.unref?.();

  // 与 container-runner 同构的身份注入：SDK 会把用户级 CLAUDE.md（"你是
  // DeepThink"）作为 memory 加载，顺序在 systemPrompt 之后，覆盖自定义身份。
  // 用 <agent-definition> + identity-override 显式压回 Agent 人设。
  const systemPromptAppend = agent.def.system_prompt
    ? `<agent-definition>\n${agent.def.system_prompt}\n</agent-definition>\n<agent-identity-override>\n本会话正在运行用户在 Agent Studio 配置的自定义 Agent。其身份与行为由上方 <agent-definition> 定义，优先级高于 CLAUDE.md / 全局记忆中的平台默认身份断言。被问及身份（"你是谁" / "who are you" 等）时，必须按 <agent-definition> 中定义的角色身份作答，不得回答平台默认身份，即使其他 memory 文件要求如此。\n</agent-identity-override>`
    : undefined;

  const options: Record<string, unknown> = {
    cwd: agent.workspaceDir,
    ...(agent.model ? { model: agent.model } : {}),
    ...(systemPromptAppend
      ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend } }
      : {}),
    ...(agent.def.max_turns != null ? { maxTurns: agent.def.max_turns } : {}),
    ...(agent.def.temperature != null ? { temperature: agent.def.temperature } : {}),
    env,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // 让 SDK 产出 partial 文本增量（stream_event text_delta），否则只拿最终 result。
    includePartialMessages: true,
    abortController,
  };
  if (Object.keys(agent.mcpServers).length > 0) {
    options.mcpServers = agent.mcpServers;
  }
  if (Object.keys(agent.agents).length > 0) {
    options.agents = agent.agents;
  }

  return { options, abortController, timer };
}

/** 从 SDK result 事件提取用量并计费（source='open-platform'）。 */
function billAgentResult(
  userId: string,
  agentId: string,
  model: string,
  event: any,
): void {
  const usage = event.usage ?? {};
  billOpenPlatformUsage(userId, {
    model: model || 'agent',
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    costUSD: event.total_cost_usd ?? 0,
    agentId,
    durationMs: event.duration_ms ?? 0,
    numTurns: event.num_turns ?? 0,
  });
}

/** 同步执行 Agent，返回最终文本。 */
export async function runAgent(
  agentId: string,
  userId: string,
  userText: string,
): Promise<{ text: string }> {
  const resolved = resolveAgent(agentId, userId);
  if ('error' in resolved) {
    const err: any = new Error(resolved.error);
    err.status = resolved.status;
    throw err;
  }
  const timeoutMs = agentTimeoutMs();
  const { options, abortController, timer } = buildQueryOptions(resolved.agent, timeoutMs);
  const startedAt = Date.now();

  let result = '';
  try {
    const conversation = query({ prompt: userText, options: options as any });
    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        result = (event as any).result ?? '';
        billAgentResult(userId, agentId, resolved.agent.model || '', event as any);
      }
    }
    return { text: result.trim() };
  } catch (err) {
    const upstream = (err as Error)?.message || String(err);
    const elapsedMs = Date.now() - startedAt;
    // abortController 只有本函数的超时定时器会触发（finally 里的 abort 在
    // return/throw 之后才执行），所以信号已 abort ⇒ 就是超时，不是上游故障。
    if (abortController.signal.aborted) {
      logger.warn({ agentId, timeoutMs, elapsedMs }, 'runAgent timed out');
      const e: any = new Error(`Agent execution timed out after ${Math.round(elapsedMs / 1000)}s`);
      e.status = 504;
      throw e;
    }
    logger.warn({ agentId, elapsedMs, err: upstream.slice(0, 200) }, 'runAgent failed');
    // 保留上游原因：原实现把它换成通用的 "Agent execution failed"，日志里
    // 只剩一句无信息量的话，排查必须重新复现（见 docs/issues/2026-10-09-...）。
    const e: any = new Error(`Agent execution failed: ${upstream}`.slice(0, 300));
    e.status = 500;
    throw e;
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}

/**
 * 流式执行 Agent，产出 SSE `data:` 载荷字符串（OpenAI chunk 风格，不含前缀）。
 * 仅流主 Agent 文本（parent_tool_use_id == null），忽略子 Agent/工具内部增量。
 */
export async function* streamAgent(
  agentId: string,
  userId: string,
  userText: string,
): AsyncGenerator<string> {
  const resolved = resolveAgent(agentId, userId);
  if ('error' in resolved) {
    const err: any = new Error(resolved.error);
    err.status = resolved.status;
    throw err;
  }
  const timeoutMs = agentTimeoutMs();
  const { options, abortController, timer } = buildQueryOptions(resolved.agent, timeoutMs);
  const startedAt = Date.now();

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = resolved.agent.model || 'agent';
  let started = false;

  const emit = (delta: Record<string, unknown>, finish: string | null): string =>
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

  try {
    const conversation = query({ prompt: userText, options: options as any });
    for await (const event of conversation) {
      if (event.type === 'stream_event') {
        const evt = (event as any).event;
        const parent = (event as any).parent_tool_use_id;
        if (parent == null && evt?.type === 'content_block_delta' && evt?.delta?.type === 'text_delta') {
          const text = evt.delta.text;
          if (typeof text === 'string' && text.length > 0) {
            if (!started) {
              started = true;
              yield emit({ role: 'assistant' }, null);
            }
            yield emit({ content: text }, null);
          }
        }
      } else if (event.type === 'result' && event.subtype === 'success') {
        billAgentResult(userId, agentId, resolved.agent.model || '', event as any);
        // 终块
        yield emit({}, 'stop');
      }
    }
    if (!started) {
      yield emit({ role: 'assistant' }, null);
      yield emit({}, 'stop');
    }
  } catch (err) {
    const upstream = (err as Error)?.message || String(err);
    const elapsedMs = Date.now() - startedAt;
    const timedOut = abortController.signal.aborted;
    logger.warn(
      { agentId, elapsedMs, ...(timedOut ? { timeoutMs } : { err: upstream.slice(0, 200) }) },
      timedOut ? 'streamAgent timed out' : 'streamAgent failed',
    );
    yield JSON.stringify({
      error: {
        message: timedOut
          ? `Agent execution timed out after ${Math.round(elapsedMs / 1000)}s`
          : `Agent execution failed: ${upstream}`.slice(0, 300),
        type: 'agent_error',
      },
    });
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}
