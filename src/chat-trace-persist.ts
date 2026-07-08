/**
 * Persist traceNode metadata from stream events to the chat_trace_nodes table.
 *
 * Called from src/index.ts on every stream event that carries a traceNode
 * field. The upsert is idempotent on (chat_jid, id) so replays (e.g. on page
 * refresh) are safe. Failures are logged but do not block the stream —
 * DAG visualization is a best-effort side channel, not a critical path.
 */

import type { StreamEvent } from './stream-event.types.js';
import { upsertChatTraceNode } from './db.js';
import { logger } from './logger.js';

export function persistTraceNodeFromStreamEvent(
  chatJid: string,
  event: StreamEvent,
): void {
  if (!event.traceNode) return;
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
    });
  } catch (err) {
    logger.warn({ err, chatJid, nodeId: tn.nodeId }, 'persistTraceNode failed');
  }
}
