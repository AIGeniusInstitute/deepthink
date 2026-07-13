/**
 * DingTalk quoted/replied message parser.
 *
 * When a user long-presses a message → "Reply" → @ the bot, DingTalk sends a
 * `text` payload whose `text.isReplyMsg === true` and `text.repliedMsg` carries
 * the original message. Content shape varies by the replied message's msgType:
 *
 * - file:    { fileName, downloadCode, spaceId, fileId }
 * - picture: { downloadCode | pictureDownloadCode }
 * - text:    a string (or `{ text: string }` in some versions)
 * - other:   arbitrary JSON — we fall back to a truncated summary.
 *
 * This module exposes a pure parser so the handler can stay thin and tests can
 * cover edge cases without a live stream connection.
 */

export interface RepliedMsgContent {
  fileName?: string;
  downloadCode?: string;
  pictureDownloadCode?: string;
  spaceId?: string;
  fileId?: string;
  text?: string;
}

export interface RepliedMsg {
  createdAt?: number;
  senderId?: string;
  msgType: string;
  msgId?: string;
  content?: RepliedMsgContent | string;
}

export type ExtractedReplyKind = 'file' | 'picture' | 'text' | 'other';

export interface ExtractedReply {
  kind: ExtractedReplyKind;
  /** Original message ID (useful for logging / fallback lookups) */
  originalMsgId?: string;
  /** File name for file replies. */
  fileName?: string;
  /** Preferred download code (file / picture). */
  downloadCode?: string;
  /** Some picture payloads use `pictureDownloadCode` instead of `downloadCode`. */
  pictureDownloadCode?: string;
  /** Replied text body (text or fallback JSON summary). */
  textContent?: string;
}

const MAX_REPLIED_SUMMARY = 500;

/**
 * Parse a DingTalk `text.repliedMsg` block into a normalized shape.
 * Returns null if no reply metadata is present.
 */
export function extractRepliedMsg(
  repliedMsg: RepliedMsg | undefined,
  originalMsgId?: string,
): ExtractedReply | null {
  if (!repliedMsg || !repliedMsg.msgType) {
    return null;
  }

  const content = repliedMsg.content;
  const base = { originalMsgId: originalMsgId ?? repliedMsg.msgId };

  switch (repliedMsg.msgType) {
    case 'file': {
      if (typeof content === 'object' && content) {
        return {
          ...base,
          kind: 'file',
          fileName: content.fileName || 'file',
          downloadCode: content.downloadCode,
        };
      }
      return { ...base, kind: 'file', fileName: 'file' };
    }

    case 'picture': {
      if (typeof content === 'object' && content) {
        return {
          ...base,
          kind: 'picture',
          downloadCode: content.downloadCode,
          pictureDownloadCode: content.pictureDownloadCode,
        };
      }
      return { ...base, kind: 'picture' };
    }

    case 'text': {
      const text =
        typeof content === 'string'
          ? content
          : content && typeof content === 'object'
            ? content.text
            : undefined;
      return {
        ...base,
        kind: 'text',
        textContent: text ? text.slice(0, MAX_REPLIED_SUMMARY) : undefined,
      };
    }

    default: {
      const summary =
        typeof content === 'string'
          ? content
          : JSON.stringify(content ?? {});
      return {
        ...base,
        kind: 'other',
        textContent: summary.slice(0, MAX_REPLIED_SUMMARY),
      };
    }
  }
}
