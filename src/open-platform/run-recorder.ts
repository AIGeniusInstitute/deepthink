/**
 * 开放平台 AaaS 的运行记录器（Agent Runtime Monitor 的写入侧）。
 *
 * 背景：在此之前，`POST /v1/agents/:id/chat/completions` 每次调用只在
 * `usage_records` 落一行**计费**数据 —— 那是账本，不是运行记录：没有状态、
 * 没有错误、没有请求/响应摘要、也没有分步轨迹。结果是开放平台的 Agent 服务
 * 成了全平台唯一一个**完全不可监控**的运行路径。
 *
 * 本模块补上 `open_platform_runs`（运行记录）与 `trace_steps`（分步轨迹）。
 *
 * ## 铁律：监控是旁路，绝不影响 AaaS 主链路
 *
 * `runAgent` / `streamAgent` 是被外部 SDK 直接调用的付费接口。这里每一次写库都
 * 包在 try/catch 里，失败只 `logger.warn` —— 监控自己的存储坏了，不能变成客户
 * 的 500。（对应 PRD AC-F5.5，有单测覆盖。）
 *
 * 计费仍然只以 `usage_records` 为准；`open_platform_runs` 是同一份 SDK result
 * 数据驱动的**镜像**，两者数值天然一致，但没有任何一方依赖另一方。
 */

import crypto from 'node:crypto';
import { getDb, upsertTraceStep } from '../db.js';
import { logger } from '../logger.js';

/** 请求/响应摘要在表里只留摘要 —— 完整对话属于用户数据，监控表不该成为第二份副本。 */
const SUMMARY_MAX = 500;

export type RunChannel = 'api' | 'sse' | 'debug' | 'debug-sse';
export type RunTerminalStatus = 'completed' | 'failed';

/**
 * 调用方补充的运行元信息。没有它就无法区分"哪个入口触发的这次运行" ——
 * 同一个 agent 既可能被外部 API Key 调用，也可能被控制台调试页调用。
 */
export interface RunMeta {
  channel: RunChannel;
  keyId?: string | null;
}

export interface RunRecorderOptions {
  agentId: string;
  userId: string;
  keyId?: string | null;
  channel: RunChannel;
  model: string;
  userText: string;
}

export interface RunRecorder {
  readonly runId: string;
  readonly traceId: string;
  /** 插入 `status='running'` 的初始行。 */
  onCreate(): void;
  /** 消费一个 SDK 事件，采集成轨迹 span。 */
  onSdkEvent(event: unknown): void;
  /** SDK `result` 事件：提取用量与最终文本。 */
  onResult(event: unknown): void;
  /** 落终态。**幂等** —— 重复调用只有第一次生效。 */
  finish(status: RunTerminalStatus, err?: unknown, responseText?: string): void;
  /** 是否已落终态（SSE 的 finally 用它判断是否需要兜底收尾）。 */
  isFinished(): boolean;
}

interface PendingSpan {
  spanId: string;
  nodeType: string;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  tokens: number;
  status: string;
  inputSummary: string | null;
  outputSummary: string | null;
}

function truncate(s: string | null | undefined): string | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? 'unknown error');
}

export function createRunRecorder(opts: RunRecorderOptions): RunRecorder {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const spans: PendingSpan[] = [];
  let spanSeq = 0;
  let finished = false;
  let responseText = '';
  let usage: { input: number; output: number; cost: number; turns: number } | null = null;

  const nextSpanId = () => `s${++spanSeq}`;

  return {
    runId,
    traceId: runId,

    onCreate(): void {
      try {
        getDb()
          .prepare(
            `INSERT INTO open_platform_runs
               (id, agent_id, user_id, key_id, channel, model, status, started_at,
                trace_id, request_summary)
             VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
          )
          .run(
            runId,
            opts.agentId,
            opts.userId,
            opts.keyId ?? null,
            opts.channel,
            opts.model || 'agent',
            startedAt,
            runId,
            truncate(opts.userText),
          );
      } catch (err) {
        logger.warn({ err, agentId: opts.agentId }, 'open_platform_runs insert failed (ignored)');
      }
    },

    onSdkEvent(event: unknown): void {
      const e = event as {
        type?: string;
        event?: { type?: string; content_block?: { type?: string; name?: string }; delta?: { type?: string; text?: string } };
      };
      try {
        if (e?.type !== 'stream_event') return;
        const inner = e.event;
        if (!inner) return;

        // 工具调用开始。两条路径（runAgent / streamAgent）共用 buildQueryOptions，
        // 其中 includePartialMessages 恒为 true，所以这里两条路径都能收到流式事件。
        // 只拿到"开始"——SDK 的 partial 流不带工具结果配对，故 span 的结束时刻由
        // finish() 统一收口（见下）。
        if (inner.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
          spans.push({
            spanId: nextSpanId(),
            nodeType: 'tool',
            title: inner.content_block.name ?? 'tool',
            startedAt: new Date().toISOString(),
            endedAt: null,
            tokens: 0,
            status: 'running',
            inputSummary: null,
            outputSummary: null,
          });
          return;
        }

        // 主 Agent 的文本增量，用于响应摘要
        if (
          inner.type === 'content_block_delta' &&
          inner.delta?.type === 'text_delta' &&
          typeof inner.delta.text === 'string'
        ) {
          if (responseText.length < SUMMARY_MAX * 2) responseText += inner.delta.text;
        }
      } catch (err) {
        logger.warn({ err }, 'run recorder onSdkEvent failed (ignored)');
      }
    },

    onResult(event: unknown): void {
      try {
        const e = event as {
          result?: string;
          total_cost_usd?: number;
          duration_ms?: number;
          num_turns?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (typeof e?.result === 'string' && e.result.length > 0) responseText = e.result;
        usage = {
          input: e?.usage?.input_tokens ?? 0,
          output: e?.usage?.output_tokens ?? 0,
          cost: e?.total_cost_usd ?? 0,
          turns: e?.num_turns ?? 0,
        };
      } catch (err) {
        logger.warn({ err }, 'run recorder onResult failed (ignored)');
      }
    },

    isFinished(): boolean {
      return finished;
    },

    finish(status: RunTerminalStatus, err?: unknown, text?: string): void {
      if (finished) return;
      finished = true;
      if (typeof text === 'string' && text.length > 0) responseText = text;
      const endedAt = new Date().toISOString();
      const durationMs = Date.now() - startedMs;

      // 1) 轨迹 —— 先把还没收尾的 tool span 闭合，再补一条覆盖整次运行的 turn span
      try {
        for (const s of spans) {
          const end = s.endedAt ?? endedAt;
          upsertTraceStep({
            trace_id: runId,
            span_id: s.spanId,
            node_type: s.nodeType,
            title: s.title,
            input_summary: s.inputSummary,
            output_summary: s.outputSummary,
            tokens: s.tokens,
            status: status === 'failed' ? 'failed' : 'done',
            started_at: s.startedAt,
            ended_at: end,
          });
        }
        upsertTraceStep({
          trace_id: runId,
          span_id: nextSpanId(),
          node_type: 'turn',
          title: `AaaS · ${opts.channel}`,
          input_summary: truncate(opts.userText),
          output_summary: truncate(status === 'failed' ? errorText(err) : responseText),
          tokens: usage ? usage.input + usage.output : 0,
          status: status === 'failed' ? 'failed' : 'done',
          started_at: startedAt,
          ended_at: endedAt,
        });
      } catch (e2) {
        logger.warn({ err: e2, runId }, 'open_platform trace_steps write failed (ignored)');
      }

      // 2) 运行记录终态
      try {
        getDb()
          .prepare(
            `UPDATE open_platform_runs SET
               status = ?, ended_at = ?, duration_ms = ?,
               input_tokens = ?, output_tokens = ?, cost_usd = ?, num_turns = ?,
               error = ?, response_summary = ?
             WHERE id = ?`,
          )
          .run(
            status,
            endedAt,
            durationMs,
            usage?.input ?? 0,
            usage?.output ?? 0,
            usage?.cost ?? 0,
            usage?.turns ?? 0,
            status === 'failed' ? errorText(err).slice(0, SUMMARY_MAX) : null,
            truncate(responseText),
            runId,
          );
      } catch (e2) {
        logger.warn({ err: e2, runId }, 'open_platform_runs update failed (ignored)');
      }
    },
  };
}
