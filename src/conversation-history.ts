import { getMessagesPage } from './db.js';

/**
 * Build a `<system_context>` block of recent persisted DeepThink chat history
 * to prepend to a prompt when the underlying Claude SDK session is fresh
 * (recovery after a crash, or after switching provider/model so the old
 * thinking-block-bearing session was cleared). Without this the new model sees
 * an empty conversation and loses context the user already established.
 *
 * Shared by the orchestration layer (index.ts: recovery + agent fresh-session)
 * and the container/host runner (proactive provider switch that clears the
 * session). Keeping a single implementation ensures the injected framing — and
 * the lone-surrogate / closing-tag sanitisation — stays byte-for-byte
 * consistent across every path that feeds the same Anthropic API.
 */
export function buildRecentConversationHistoryContext(
  chatJid: string,
  pendingMessageIds: Set<string>,
  opts: {
    limit?: number;
    maxMessageLength?: number;
    intro: string;
  },
): { context: string; count: number } | null {
  const recentHistory = getMessagesPage(chatJid, undefined, opts.limit ?? 30);
  const historyMsgs = recentHistory
    .reverse()
    .filter((m) => !pendingMessageIds.has(m.id))
    .filter((m) => m.content.trim().length > 0);

  if (historyMsgs.length === 0) return null;

  const maxLen = opts.maxMessageLength ?? 700;
  const historyLines = historyMsgs.map((m) => {
    const role = m.is_from_me ? 'assistant' : m.sender_name;
    const truncated =
      m.content.length > maxLen ? m.content.slice(0, maxLen) + '…' : m.content;
    // Strip lone (unpaired) surrogates while preserving valid surrogate pairs
    // such as emoji. Must stay byte-for-byte aligned with the matching regex in
    // container/agent-runner/src/index.ts:extractSessionHistory — both sides
    // feed the same Anthropic API and must produce identical strings.
    let cleaned = truncated.replace(
      /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g,
      '',
    );
    // Defense in depth: strip the closing tag we use to fence this block so a
    // user message containing "</system_context>" can't escape early.
    cleaned = cleaned.replace(/<\/system_context>/gi, '</system_context_>');
    return `[${role}] ${cleaned}`;
  });

  return {
    count: historyMsgs.length,
    context:
      '<system_context>\n' +
      opts.intro +
      '\n重要：这些只是 DeepThink 持久化的历史聊天记录，用来在新模型/新 session 中恢复上下文。回答当前用户消息时，请优先依据当前消息和当前文件状态；如果历史与当前问题无关，请直接忽略。\n\n' +
      historyLines.join('\n') +
      '\n</system_context>\n\n',
  };
}
