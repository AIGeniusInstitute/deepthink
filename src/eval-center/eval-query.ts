// DeepThink Eval Center — SDK query() wrapper that captures the full event
// stream into PostgreSQL trace_span rows (satisfies "全部中间数据存 PG").
// sdkQuery discards intermediate events; this wrapper intercepts them.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildClaudeEnvLines, getClaudeProviderConfig } from '../runtime-config.js';
import { logger } from '../logger.js';
import { createTraceSpan } from './eval-db.js';

export interface EvalQueryOptions {
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  traceId: string;          // PG agent_trace.id
}

export interface EvalQueryResult {
  output: string | null;    // final assistant text
  hadError: boolean;
  totalTokens: number;
  totalLatencyMs: number;
  spanCount: number;
}

interface OpenSpan {
  spanId?: string;          // PG uuid (set after createTraceSpan)
  toolUseId?: string;
  startedAt: string;
}

export async function evalQuery(prompt: string, opts: EvalQueryOptions): Promise<EvalQueryResult> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), opts.timeoutMs ?? 90_000);
  const model = opts.model || config.anthropicModel || undefined;
  const maxTurns = opts.maxTurns ?? 1;

  let output = '';
  let hadError = false;
  let totalTokens = 0;
  let seq = 0;
  const openSpans = new Map<string, OpenSpan>(); // toolUseId -> span
  let rootAssistantSpan: string | undefined; // parent for tool calls in current turn

  try {
    const conversation = query({
      prompt,
      options: {
        ...(model && { model }),
        ...(opts.systemPrompt && { systemPrompt: opts.systemPrompt }),
        env,
        maxTurns,
        allowedTools: [],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        abortController,
      },
    });

    for await (const event of conversation) {
      try {
        const et = (event as any).type as string | undefined;
        if (et === 'assistant') {
          // Assistant message — content blocks
          const msg = (event as any).message;
          const content = msg?.content ?? (event as any).content ?? [];
          // Root llm_call span for this assistant message
          const rootStart = new Date().toISOString();
          const span = await createTraceSpan({
            traceId: opts.traceId, parentSpanId: rootAssistantSpan ?? null,
            spanType: 'llm_call', sequenceOrder: seq++,
            name: model ?? 'llm_call', inputData: { prompt: prompt.slice(0, 2000) },
            status: 'ok', startedAt: rootStart, endedAt: rootStart,
          });
          rootAssistantSpan = span.id;
          let textOut = '';
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              textOut += block.text;
            } else if (block?.type === 'tool_use') {
              const toolSpan = await createTraceSpan({
                traceId: opts.traceId, parentSpanId: span.id, spanType: 'tool_call',
                sequenceOrder: seq++, name: block.name,
                inputData: block.input, status: 'ok',
                startedAt: rootStart, endedAt: rootStart,
              });
              openSpans.set(block.id, { spanId: toolSpan.id, toolUseId: block.id, startedAt: rootStart });
            } else if (block?.type === 'thinking' && block.thinking) {
              await createTraceSpan({
                traceId: opts.traceId, parentSpanId: span.id, spanType: 'decision',
                sequenceOrder: seq++, name: 'thinking', outputData: { thinking: block.thinking.slice(0, 1000) },
                status: 'ok', startedAt: rootStart, endedAt: rootStart,
              });
            }
          }
          // Update root span with output + tokens
          const usage = msg?.usage;
          const tok = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : 0;
          totalTokens += tok;
          await createTraceSpan({
            traceId: opts.traceId, parentSpanId: span.id, spanType: 'llm_call',
            sequenceOrder: seq++, name: 'output',
            outputData: { text: textOut.slice(0, 8000) },
            tokenUsage: usage ?? {}, model, latencyMs: 0, status: 'ok',
            startedAt: rootStart, endedAt: rootStart,
          }).then(() => {});
          output = textOut;
        } else if (et === 'user') {
          // Tool results come back as user messages with tool_result content
          const content = (event as any).message?.content ?? (event as any).content ?? [];
          for (const block of content) {
            if (block?.type === 'tool_result' && block.tool_use_id) {
              const open = openSpans.get(block.tool_use_id);
              if (open?.spanId) {
                // close the tool_call span with its output
                await createTraceSpan({
                  traceId: opts.traceId, parentSpanId: open.spanId, spanType: 'tool_call',
                  sequenceOrder: seq++, name: 'tool_result',
                  outputData: { content: typeof block.content === 'string' ? block.content.slice(0, 4000) : block.content, is_error: block.is_error },
                  status: block.is_error ? 'error' : 'ok',
                  startedAt: open.startedAt, endedAt: new Date().toISOString(),
                });
                openSpans.delete(block.tool_use_id);
              }
            }
          }
        } else if (et === 'result') {
          const sub = (event as any).subtype;
          if (sub === 'success') {
            const r = (event as any).result;
            if (typeof r === 'string' && r.trim()) output = r;
          } else {
            hadError = true;
          }
        } else if (et === 'system' && (event as any).subtype === 'error') {
          hadError = true;
        }
      } catch (spanErr) {
        // trace capture must never break the query
        logger.warn({ err: (spanErr as Error).message?.slice(0, 200) }, 'eval trace span capture failed');
      }
    }
  } catch (err) {
    hadError = true;
    logger.warn({ err: (err as Error).message?.slice(0, 200) }, 'evalQuery failed');
  } finally {
    clearTimeout(timer);
  }

  const totalLatencyMs = Date.now() - t0;
  return {
    output: output.trim() || null, hadError,
    totalTokens, totalLatencyMs, spanCount: seq,
  };
}
