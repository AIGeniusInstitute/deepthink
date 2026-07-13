/**
 * QQ C2C Streaming Message Controller
 *
 * Implements typewriter-style progressive message delivery using
 * QQ Bot API v2's stream_messages endpoint (C2C only).
 *
 * Protocol:
 *   POST /v2/users/{openid}/stream_messages
 *   - input_mode: "replace" (each chunk replaces entire message)
 *   - input_state: 1 (GENERATING) / 10 (DONE)
 *   - First chunk returns stream_msg_id; subsequent chunks must include it
 *   - msg_seq: shared across all chunks in the same session
 *
 * Lifecycle: idle → streaming → completed / aborted
 * Fallback: if stream API fails, falls back to plain sendQQMessage()
 *
 * ─── Inactive aux-surface scaffolding (INTENTIONALLY UNUSED) ────
 *
 * The following members are reserved for a future auxiliary-display surface
 * (thinking stream / tool activity / recent events / system status) but are
 * currently NOT surfaced to the user during streaming:
 *
 *   - thinking / thinkingText
 *   - systemStatus
 *   - tools (Map) + purgeOldTools()
 *   - recentEvents
 *   - auxFlushTimer / lastAuxFlushTime / AUX_FLUSH_INTERVAL
 *   - buildAuxPrefix() / formatElapsed()
 *   - setThinking() / appendThinking() / setSystemStatus()
 *   - startTool() / endTool() / updateToolSummary() / pushRecentEvent()
 *
 * Rationale for keeping this dormant: QQ's stream_messages endpoint enforces
 * strict prefix stability across chunks — any mutation of an aux prefix
 * mid-stream would break the protocol. These hooks are preserved so that a
 * future out-of-band aux channel (e.g. a secondary message or sidebar card)
 * can be wired in without reconstructing the tracking logic. `scheduleAuxFlush`
 * is deliberately a no-op; see the comment at its definition.
 */

import { logger } from './logger.js';

// ─── Constants ───────────────────────────────────────────────

const STREAM_UPDATE_INTERVAL = 500; // ms — throttle between API calls
const MAX_STREAM_CONTENT = 4500; // QQ content_raw conservative upper bound (leave small buffer under ~5000)

// ─── Types ───────────────────────────────────────────────────

/** Callback to send a stream chunk via QQ API */
export type SendStreamChunkFn = (
  openid: string,
  params: {
    input_mode: string;
    input_state: number;
    content_type: string;
    content_raw: string;
    msg_seq: number;
    index: number;
    stream_msg_id?: string;
    msg_id?: string;
    event_id?: string;
  },
) => Promise<{ id?: string }>;

/** Callback to send a plain message (fallback) */
export type FallbackSendFn = (text: string) => Promise<void>;

type StreamingState =
  | 'idle'
  | 'streaming'
  | 'completing' // complete() in progress, awaiting in-flight flush
  | 'aborting' // abort() in progress, awaiting in-flight flush
  | 'completed'
  | 'aborted';

// ─── Controller ──────────────────────────────────────────────

export class QQStreamingController {
  private state: StreamingState = 'idle';
  private accumulatedText = '';

  // Stream session state
  private streamMsgId: string | null = null;
  private msgSeq: number;
  private streamIndex = 0;
  private sentChunkCount = 0;

  // Throttle
  private lastUpdateTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentFlushPromise: Promise<void> | null = null;
  private flushPending = false;

  // Dependencies
  private openid: string;
  private sendStreamChunk: SendStreamChunkFn;
  private fallbackSend: FallbackSendFn;
  private fallbackUsed = false;
  private passiveMsgId: string | undefined;

  // Auxiliary state (thinking, tools, status)
  private thinking = false;
  private thinkingText = '';
  private systemStatus: string | null = null;
  private tools = new Map<
    string,
    {
      name: string;
      status: 'running' | 'complete' | 'error';
      startTime: number;
      summary?: string;
    }
  >();
  private recentEvents: string[] = [];

  // Auxiliary flush throttle
  private auxFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAuxFlushTime = 0;
  private static readonly AUX_FLUSH_INTERVAL = 1500; // ms

  // Display limits
  private static readonly MAX_THINKING_CHARS = 500;
  private static readonly MAX_TOOLS_DISPLAY = 5;
  private static readonly MAX_TOOL_SUMMARY_CHARS = 60;
  private static readonly MAX_RECENT_EVENTS = 5;

  constructor(opts: {
    openid: string;
    msgSeq: number;
    sendStreamChunk: SendStreamChunkFn;
    fallbackSend: FallbackSendFn;
    /** Latest incoming msg_id from this openid. Required by QQ stream API. */
    passiveMsgId?: string;
  }) {
    this.openid = opts.openid;
    this.msgSeq = opts.msgSeq;
    this.sendStreamChunk = opts.sendStreamChunk;
    this.fallbackSend = opts.fallbackSend;
    this.passiveMsgId = opts.passiveMsgId;
  }

  // ─── StreamingSession interface ─────────────────────────────

  isActive(): boolean {
    // Only idle/streaming accept new content. Once complete/abort starts,
    // late-arriving append()s are ignored to keep the QQ baseline monotonic.
    return this.state === 'idle' || this.state === 'streaming';
  }

  append(text: string): void {
    if (!this.isActive()) return;
    const isFirst = this.accumulatedText.length === 0;
    this.accumulatedText = text;
    this.thinkingText = '';
    this.thinking = false;
    if (isFirst) {
      logger.info(
        { openid: this.openid, textLen: text.length },
        'QQ streaming first append()',
      );
    }
    this.scheduleFlush();
  }

  async complete(finalText: string): Promise<void> {
    if (
      this.state === 'completed' ||
      this.state === 'aborted' ||
      this.state === 'completing' ||
      this.state === 'aborting'
    ) {
      return;
    }
    // Enter terminal-pending state IMMEDIATELY so any text_delta arriving
    // during the awaits below is dropped by isActive(). Otherwise it would
    // overwrite accumulatedText and schedule a flush that races the DONE
    // chunk, breaking QQ's strict prefix-stability requirement.
    this.state = 'completing';
    this.clearTimers();

    // Wait for any in-flight flush to settle so we don't race the DONE chunk
    if (this.currentFlushPromise) {
      await this.currentFlushPromise.catch(() => {});
    }

    // Now safe to set baseline. accumulatedText is whatever the last
    // successful flush sent (or finalText if none flushed yet).
    const baseline = this.accumulatedText;
    // DONE text must be an extension of the QQ baseline. If finalText
    // diverges from what we've already streamed, fall back to baseline
    // for the DONE chunk and let fallback path handle the difference.
    const safeFinal = finalText.startsWith(baseline) ? finalText : baseline;
    if (safeFinal !== finalText) {
      logger.warn(
        {
          openid: this.openid,
          baselineLen: baseline.length,
          finalLen: finalText.length,
        },
        'QQ streaming finalText diverges from streamed baseline, using baseline for DONE',
      );
    }
    this.accumulatedText = safeFinal;

    logger.info(
      {
        openid: this.openid,
        state: this.state,
        sentChunks: this.sentChunkCount,
        textLen: finalText.length,
      },
      'QQ streaming complete() entry',
    );

    if (!finalText.trim()) {
      this.state = 'completed';
      return;
    }

    // If we never managed to start a stream, use fallback for the full text
    if (this.sentChunkCount === 0) {
      await this.tryStartStream(safeFinal);
      if (!this.streamMsgId) {
        logger.warn(
          { openid: this.openid },
          'QQ streaming never started, falling back to plain message',
        );
        await this.tryFallback(finalText);
        this.state = 'completed';
        return;
      }
    }

    try {
      // Send DONE with the prefix-safe text. In the rare divergent case,
      // safeFinal is the streamed baseline (a prefix of what we'd ideally
      // send) — DONE succeeds and the user sees a slightly truncated final.
      // Logged above; investigate via logs if it ever appears in production.
      await this.doSendChunk(safeFinal, 10); // DONE
      this.state = 'completed';
      logger.info(
        { openid: this.openid, chunks: this.sentChunkCount },
        'QQ streaming completed',
      );
    } catch (err: any) {
      logger.warn(
        { err: err.message, openid: this.openid },
        'QQ streaming finalize failed, using fallback',
      );
      await this.tryFallback(finalText);
      this.state = 'completed';
    }
  }

  async abort(reason?: string): Promise<void> {
    if (
      this.state === 'completed' ||
      this.state === 'aborted' ||
      this.state === 'completing' ||
      this.state === 'aborting'
    ) {
      return;
    }
    // Same reasoning as complete(): block late append() during awaits below.
    this.state = 'aborting';
    this.clearTimers();

    if (this.currentFlushPromise) {
      await this.currentFlushPromise.catch(() => {});
    }

    if (this.streamMsgId) {
      // accumulatedText here reflects the last successfully-streamed baseline,
      // so appending the abort notice keeps prefix stability.
      const abortText = this.accumulatedText
        ? this.accumulatedText + `\n\n⚠️ 已中断: ${reason ?? '用户取消'}`
        : `⚠️ 已中断: ${reason ?? '用户取消'}`;
      try {
        await this.doSendChunk(abortText, 10); // DONE
      } catch (err: any) {
        logger.debug({ err: err.message }, 'QQ streaming abort chunk failed');
      }
    }
    this.state = 'aborted';
  }

  dispose(): void {
    this.clearTimers();
  }

  // ─── Auxiliary display methods ──────────────────────────────

  setThinking(): void {
    this.thinking = true;
  }

  appendThinking(text: string): void {
    this.thinkingText += text;
    if (this.thinkingText.length > QQStreamingController.MAX_THINKING_CHARS) {
      this.thinkingText =
        '...' +
        this.thinkingText.slice(-(QQStreamingController.MAX_THINKING_CHARS - 3));
    }
    this.thinking = true;

    // Show thinking state via streaming if already active
    if (this.state === 'streaming') {
      this.scheduleAuxFlush();
    }
  }

  setSystemStatus(status: string | null): void {
    this.systemStatus = status;
    if (this.state === 'streaming') this.scheduleAuxFlush();
  }

  setHook(_hook: { hookName: string; hookEvent: string } | null): void {
    // Not meaningful for QQ plain text
  }

  setTodos(
    _todos: Array<{ id: string; content: string; status: string }>,
  ): void {
    // Too verbose for plain text
  }

  pushRecentEvent(text: string): void {
    this.recentEvents.push(text);
    if (this.recentEvents.length > QQStreamingController.MAX_RECENT_EVENTS) {
      this.recentEvents = this.recentEvents.slice(
        -QQStreamingController.MAX_RECENT_EVENTS,
      );
    }
  }

  startTool(toolId: string, toolName: string): void {
    this.tools.set(toolId, {
      name: toolName,
      status: 'running',
      startTime: Date.now(),
    });
    if (this.state === 'streaming') this.scheduleAuxFlush();
  }

  endTool(toolId: string, isError: boolean): void {
    const tc = this.tools.get(toolId);
    if (tc) {
      tc.status = isError ? 'error' : 'complete';
      this.purgeOldTools();
      if (this.state === 'streaming') this.scheduleAuxFlush();
    }
  }

  updateToolSummary(toolId: string, summary: string): void {
    const tc = this.tools.get(toolId);
    if (tc) {
      tc.summary = summary;
      if (this.state === 'streaming') this.scheduleAuxFlush();
    }
  }

  getToolInfo(toolId: string): { name: string } | undefined {
    return this.tools.get(toolId);
  }

  async patchUsageNote(_usage: {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
  }): Promise<void> {}

  getAllMessageIds(): string[] {
    return [];
  }

  // ─── Internal: auxiliary prefix ─────────────────────────────

  private buildAuxPrefix(): string {
    const parts: string[] = [];

    if (this.systemStatus) {
      parts.push(`⏳ ${this.systemStatus}`);
    }

    if (this.thinkingText) {
      const label = this.thinking ? '💭 思考中...' : '💭 思考完成';
      const truncated =
        this.thinkingText.length > QQStreamingController.MAX_THINKING_CHARS
          ? '...' +
            this.thinkingText.slice(-(QQStreamingController.MAX_THINKING_CHARS - 3))
          : this.thinkingText;
      parts.push(`${label}\n${truncated}`);
    } else if (this.thinking) {
      parts.push('💭 思考中...');
    }

    const now = Date.now();
    const display: string[] = [];
    for (const [, tc] of this.tools) {
      if (display.length >= QQStreamingController.MAX_TOOLS_DISPLAY) break;
      const elapsed = QQStreamingController.formatElapsed(now - tc.startTime);
      const icon =
        tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
      const summary = tc.summary
        ? `  ${tc.summary.length > QQStreamingController.MAX_TOOL_SUMMARY_CHARS ? tc.summary.slice(0, QQStreamingController.MAX_TOOL_SUMMARY_CHARS) + '...' : tc.summary}`
        : '';
      display.push(`${icon} ${tc.name} (${elapsed})${summary}`);
    }
    if (display.length > 0) {
      parts.push(display.join('\n'));
    }

    return parts.length > 0 ? parts.join('\n\n') + '\n\n---\n\n' : '';
  }

  private static formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    return `${min}m ${Math.floor(sec % 60)}s`;
  }

  private purgeOldTools(): void {
    const cutoff = Date.now() - 30_000;
    for (const [id, tc] of this.tools) {
      if (tc.status !== 'running' && tc.startTime < cutoff) {
        this.tools.delete(id);
      }
    }
  }

  // ─── Internal: streaming ────────────────────────────────────

  private scheduleFlush(): void {
    this.flushPending = true;
    // Serialize: only one flush in-flight at a time.
    // If another is running or scheduled, mark pending and let it reschedule itself.
    if (this.flushTimer || this.currentFlushPromise) return;
    const elapsed = Date.now() - this.lastUpdateTime;
    const delay = Math.max(0, STREAM_UPDATE_INTERVAL - elapsed);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending = false;
      this.currentFlushPromise = this.doFlush()
        .catch((err: any) => {
          logger.debug({ err: err.message }, 'QQ streaming flush failed');
        })
        .finally(() => {
          this.currentFlushPromise = null;
          if (this.flushPending && this.isActive()) {
            this.scheduleFlush();
          }
        });
    }, delay);
  }

  private scheduleAuxFlush(): void {
    // intentionally no-op: aux surface disabled to protect prefix stability invariant; see comments at top of file.
    // Aux state (thinking/tools/recentEvents/systemStatus) is still tracked
    // internally via setThinking/startTool/etc so a future out-of-band surface
    // can consume it without reconstructing tracking logic.
  }

  private async doFlush(): Promise<void> {
    const rawText = this.accumulatedText;
    if (!rawText.trim()) return;

    // Length guard: QQ stream_messages caps content_raw (~5000 chars). Once we
    // cross the conservative threshold, every subsequent chunk would hit the
    // same upper-bound and fail in a tight loop. Switch to fallback once and
    // stop streaming — fallbackUsed guard ensures only one plain message is
    // sent even if this path is hit repeatedly before complete() fires.
    if (rawText.length > MAX_STREAM_CONTENT) {
      logger.warn(
        {
          openid: this.openid,
          contentLen: rawText.length,
          limit: MAX_STREAM_CONTENT,
        },
        'QQ streaming accumulated text exceeds per-chunk cap, switching to fallback',
      );
      this.clearTimers();
      this.flushPending = false;
      // Aborted (not completed) so complete() early-returns without sending DONE.
      this.state = 'aborted';
      await this.tryFallback(rawText);
      return;
    }

    // CRITICAL: QQ stream API requires strict prefix stability across chunks.
    // - Never transform markdown (markdownToPlainText is non-monotonic:
    //   incomplete `**bold` stays literal, later completed `**bold**` gets stripped).
    // - Never prepend aux info (thinking/tools state changes during stream).
    // Send raw text as-is; QQ renders content_type: markdown natively.
    if (!this.streamMsgId) {
      await this.tryStartStream(rawText);
      if (!this.streamMsgId) return; // Failed, will retry next flush
    } else {
      try {
        await this.doSendChunk(rawText, 1); // GENERATING
        this.lastUpdateTime = Date.now();
      } catch (err: any) {
        logger.warn({ err: err.message, contentLen: rawText.length }, 'QQ streaming chunk failed');
      }
    }
  }

  private async tryStartStream(content: string): Promise<void> {
    try {
      // Raw content only — no transformation. Prefix must stay stable across chunks.
      const displayContent = content.trim() || '💭 思考中...';
      const resp = await this.sendStreamChunk(this.openid, {
        input_mode: 'replace',
        input_state: 1, // GENERATING
        content_type: 'markdown',
        content_raw: displayContent,
        msg_seq: this.msgSeq,
        index: this.streamIndex++,
        msg_id: this.passiveMsgId,
        event_id: this.passiveMsgId,
      });

      if (resp.id) {
        this.streamMsgId = resp.id;
        // Only transition to 'streaming' from idle. If we're already in a
        // terminal-pending state (completing/aborting), preserve it so late
        // append() events stay blocked.
        if (this.state === 'idle') {
          this.state = 'streaming';
        }
        this.sentChunkCount++;
        this.lastUpdateTime = Date.now();
        logger.info(
          { openid: this.openid, streamMsgId: resp.id },
          'QQ streaming started',
        );
      } else {
        logger.warn(
          { openid: this.openid, resp },
          'QQ stream API returned no id',
        );
      }
    } catch (err: any) {
      logger.warn(
        { err: err.message, openid: this.openid },
        'QQ streaming start failed',
      );
      // Stay in idle, will retry or fallback
    }
  }

  private async doSendChunk(
    content: string,
    inputState: number,
  ): Promise<void> {
    await this.sendStreamChunk(this.openid, {
      input_mode: 'replace',
      input_state: inputState,
      content_type: 'markdown',
      content_raw: content,
      msg_seq: this.msgSeq,
      index: this.streamIndex++,
      stream_msg_id: this.streamMsgId ?? undefined,
      msg_id: this.passiveMsgId,
      event_id: this.passiveMsgId,
    });
    this.sentChunkCount++;
  }

  private async tryFallback(text: string): Promise<void> {
    if (this.fallbackUsed) return;
    this.fallbackUsed = true;
    try {
      await this.fallbackSend(text);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'QQ streaming fallback send also failed');
    }
  }

  private clearTimers(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.auxFlushTimer) {
      clearTimeout(this.auxFlushTimer);
      this.auxFlushTimer = null;
    }
  }
}
