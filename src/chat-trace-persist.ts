/**
 * Persist traceNode metadata from stream events to the chat_trace_nodes table,
 * plus tool-call input/output to trace_tool_calls (Super Agent Team).
 *
 * Called from src/index.ts on every stream event that carries a traceNode
 * field (for the trace node) or tool input/result fields (for the tool call).
 * The upserts are idempotent (chat_trace_nodes on (chat_jid, id);
 * trace_tool_calls on (graph_run_id, tool_use_id)) so replays are safe.
 * Failures are logged but do not block the stream — DAG visualization is a
 * best-effort side channel, not a critical path.
 */

import type { StreamEvent } from './stream-event.types.js';
import { upsertChatTraceNode, upsertTraceToolCall } from './db.js';
import { logger } from './logger.js';

const TOOL_IO_MAX = 64 * 1024; // 64KB per input/output JSON — trace volume guard

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function persistTraceNodeFromStreamEvent(
  chatJid: string,
  event: StreamEvent,
): void {
  // 1. Trace node (turn/tool/subagent) → chat_trace_nodes, with graph linkage.
  if (event.traceNode) {
    const tn = event.traceNode;
    const startedAt = new Date().toISOString();
    try {
      upsertChatTraceNode({
        id: tn.nodeId,
        chat_jid: chatJid,
        node_type: tn.nodeType,
        parent_node_id: tn.parentNodeId ?? null,
        title: tn.title ?? null,
        input_summary: tn.inputSummary ?? null,
        output_summary: tn.outputSummary ?? null,
        tokens: tn.tokens ?? 0,
        status: tn.status ?? null,
        started_at: startedAt,
        ended_at: tn.status === 'done' || tn.status === 'failed' ? startedAt : null,
        graph_run_id: tn.graphRunId ?? null,
        graph_node_id: tn.graphNodeId ?? null,
        tool_name: tn.toolName ?? null,
        tool_use_id: tn.toolUseId ?? null,
      });
    } catch (err) {
      logger.warn({ err, chatJid, nodeId: tn.nodeId }, 'persistTraceNode failed');
    }
  }

  // 2. Tool-call raw I/O → trace_tool_calls (Super Agent Team). Captures the
  //    toolInput (on tool_use_start) and toolResult (on tool_result) fields that
  //    previously only streamed to the UI and were not persisted. Idempotent on
  //    (graph_run_id, tool_use_id) so the input and output halves merge.
  const toolUseId = event.toolUseId;
  if (toolUseId) {
    const graphRunId = event.traceNode?.graphRunId ?? null;
    const graphNodeId = event.traceNode?.graphNodeId ?? null;
    try {
      if (event.toolInput) {
        upsertTraceToolCall({
          graph_run_id: graphRunId,
          graph_node_id: graphNodeId,
          chat_jid: chatJid,
          tool_use_id: toolUseId,
          tool_name: event.toolName ?? 'unknown',
          input_json: truncate(JSON.stringify(event.toolInput), TOOL_IO_MAX),
          status: 'running',
          started_at: new Date().toISOString(),
        });
      }
      if (event.toolResult !== undefined) {
        upsertTraceToolCall({
          graph_run_id: graphRunId,
          graph_node_id: graphNodeId,
          chat_jid: chatJid,
          tool_use_id: toolUseId,
          tool_name: event.toolName ?? 'unknown',
          output_json: truncate(event.toolResult, TOOL_IO_MAX),
          status: event.permissionDenied ? 'denied' : 'success',
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.warn({ err, chatJid, toolUseId }, 'persistTraceToolCall failed');
    }
  }
}
