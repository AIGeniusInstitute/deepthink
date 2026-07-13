/**
 * 飞书群聊 mention 守卫 — 纯函数实现。
 *
 * 决定一条**群聊**消息是否应当继续被 agent 处理。p2p 私聊不走这条路径
 * （由调用方上游判断），传入时直接放行。
 *
 * 之所以单独抽成纯函数：
 *   - 历史 bug：`botOpenId` 为空时旧实现"安全降级 = 默认放行"，
 *     导致 `require_mention=true` 在所有群静默失效（fail-open）。
 *   - 新行为：`botOpenId` 未知时 fail-closed（拒绝），由调用方决定如何提示运维。
 *   - 抽成纯函数是为了能用单测把 fail-closed 这条语义锁住，避免下次重构再被改回。
 *
 * 与调用方的边界：
 *   - 这里只输出一个三态决定（allow / 拒绝 + 原因），不做任何日志、副作用、配置回写。
 *   - warn 节流、lazy refetch 等观察 / 自愈策略由调用方实现。
 */

export interface MentionGateMention {
  id?: { open_id?: string };
}

export interface MentionGateInput {
  /** 飞书消息的会话类型，仅 'group' 会进入 mention 检查；其它（含 undefined）一律放行 */
  chatType: string | undefined;
  /** bot 的 open_id；空串 / undefined 视为"启动期拉取失败、当前未知" */
  botOpenId: string;
  /** 消息附带的 @mention 列表 */
  mentions: MentionGateMention[] | undefined;
  /** 群 jid（仅用于把上下文透传给两个回调） */
  chatJid: string;
  /** 发送者 open_id（用于 owner 判断） */
  senderOpenId?: string;
  /**
   * 来自 deepthink 主进程：根据该群 activation_mode / require_mention
   * 决定"是否允许免 @"。
   *   - 返回 true → always 模式，放行；
   *   - 返回 false → when_mentioned / owner_mentioned，必须确认 bot 被 @。
   */
  shouldProcessGroupMessage?: (chatJid: string, senderOpenId?: string) => boolean;
  /**
   * owner_mentioned 模式专用：判断 sender 是否为该群登记的 owner。
   * 仅在 bot 真的被 @ 的前提下才会被调用。
   */
  isGroupOwnerMessage?: (chatJid: string, senderOpenId?: string) => boolean;
}

export type MentionGateRejectReason =
  /** botOpenId 未知，fail-closed 拒绝（区别于 not_mentioned，调用方应做不同的告警 / 自愈） */
  | 'bot_open_id_missing'
  /** 该群配置要求 @bot 但本条消息没 @ */
  | 'not_mentioned'
  /** owner_mentioned 模式下 bot 被 @ 了但 sender 不是 owner */
  | 'not_owner';

export type MentionGateDecision =
  | { allow: true }
  | { allow: false; reason: MentionGateRejectReason };

const ALLOW: MentionGateDecision = { allow: true };

/**
 * 判断飞书消息的 mention 列表是否包含 bot 自身。空 botOpenId 永远返回 false
 * —— 调用方需自行决定无 botOpenId 时是 fail-closed 还是降级跳过。
 */
export function isBotMentioned(
  botOpenId: string | undefined,
  mentions: MentionGateMention[] | undefined,
): boolean {
  if (!botOpenId) return false;
  return mentions?.some((m) => m.id?.open_id === botOpenId) ?? false;
}

/**
 * 评估单条群聊消息是否通过 mention 门控。
 *
 * 行为表（仅当 chatType==='group' 且传入了 shouldProcessGroupMessage 时启用门控；
 * 其它情况直接放行）：
 *
 * | shouldProcessGroupMessage | botOpenId | bot 被 @ | sender 是 owner | 决定 |
 * |--------------------------|-----------|---------|---------------|------|
 * | true (always)            | -         | -       | -             | allow |
 * | false                    | ''        | -       | -             | reject:bot_open_id_missing |
 * | false                    | 有        | 否      | -             | reject:not_mentioned |
 * | false                    | 有        | 是      | 是 / 无 owner 检查 | allow |
 * | false                    | 有        | 是      | 否            | reject:not_owner |
 */
export function evaluateMentionGate(input: MentionGateInput): MentionGateDecision {
  if (input.chatType !== 'group' || !input.shouldProcessGroupMessage) {
    return ALLOW;
  }

  const mentionNotRequired = input.shouldProcessGroupMessage(
    input.chatJid,
    input.senderOpenId,
  );
  if (mentionNotRequired) {
    return ALLOW;
  }

  if (!input.botOpenId) {
    return { allow: false, reason: 'bot_open_id_missing' };
  }

  if (!isBotMentioned(input.botOpenId, input.mentions)) {
    return { allow: false, reason: 'not_mentioned' };
  }

  if (
    input.isGroupOwnerMessage &&
    !input.isGroupOwnerMessage(input.chatJid, input.senderOpenId)
  ) {
    return { allow: false, reason: 'not_owner' };
  }

  return ALLOW;
}
