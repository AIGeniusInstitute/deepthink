/**
 * FLM 归一化层（PRD F2 统一分析框架）。
 *
 * 把三类异构来源（user / system / env）的反馈草稿归一化为同一 FeedbackEvent。
 * 本文件以**纯函数**为主 —— 唯一的例外是 `applyDesensitize` 会编译正则，但它
 * 不碰数据库也不做 IO，因此整条链路可离线单测。
 *
 * 职责边界：本文件不查库。实体对齐需要的 DB 查询由 flm-collect.ts 做完后，把
 * 结果当作 `ResolvedKeys` 传进来。这样「对齐策略」与「怎么查库」解耦。
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DesensitizeRule, FlmConfig } from './flm-config.js';
import type { FeedbackDraft, FeedbackSource, NormalizedEvent } from './flm-types.js';

/** 实体对齐所需的主键，由调用方查库后填入。 */
export interface ResolvedKeys {
  taskId: string | null;
  traceId: string | null;
  sessionId: string | null;
  stepId: string | null;
  chatJid: string | null;
  /** 'direct' = 四级主键命中；'fallback' = 仅时间/内容兜底。 */
  alignment: 'direct' | 'fallback';
}

/**
 * 来源基础置信度（PRD F2.4）。
 * 系统日志最客观（1.0），用户反馈主观但有业务意义（0.9），环境数据依赖采集质量（0.8）。
 */
const BASE_CONFIDENCE: Record<FeedbackSource, number> = {
  user: 0.9,
  system: 1.0,
  env: 0.8,
};

/** 对齐方式对置信度的折扣。兜底对齐的事件不可与直接对齐等量齐观。 */
const ALIGNMENT_DECAY = { direct: 1.0, fallback: 0.6 } as const;

/**
 * 推导任务单元 id。
 *
 * 背景：本平台的 `messages` 表**没有**可用的 `task_id`（实测 330 行全空），所以
 * FLM 必须自己定义「一个任务」是什么。取「一次助手交付」为单元 —— 这是用户实际
 * 会去评价的最小对象，也是 trace 能圈定范围的最小单位。
 *
 * 优先级：turn_id > session_id > message_id。三者至多一层回退，保证**永不为空**
 * （PRD AC-F1.1.4 要求绑定成功率 100%）。
 */
export function deriveTaskId(input: {
  turnId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  chatJid?: string | null;
  occurredAt: number;
}): string {
  if (input.turnId) return `turn:${input.turnId}`;
  if (input.sessionId) return `sess:${input.sessionId}`;
  if (input.messageId) return `msg:${input.messageId}`;
  // 最后兜底：会话 + 小时桶。系统/环境事件可能既无 turn 也无 session。
  const hourBucket = Math.floor(input.occurredAt / 3_600_000);
  return `chat:${input.chatJid ?? 'unknown'}:${hourBucket}`;
}

/**
 * 脱敏（PRD F2.6）。规则来自 admin 配置，热更新 —— 每次调用重新编译，
 * 不缓存，因此改配置立刻生效（PRD AC-F2.6）。
 *
 * 非法正则不能拖垮归一化：逐条 try/catch，坏规则跳过并计入 `invalidRules`。
 */
export function applyDesensitize(
  input: string,
  rules: DesensitizeRule[],
): { text: string; hit: boolean; invalidRules: string[] } {
  let text = input;
  let hit = false;
  const invalidRules: string[] = [];
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`);
      if (re.test(text)) {
        hit = true;
        re.lastIndex = 0; // test() 在 /g 下会推进 lastIndex，必须重置
        text = text.replace(re, rule.mask);
      }
    } catch {
      invalidRules.push(rule.name);
    }
  }
  return { text, hit, invalidRules };
}

/** 递归脱敏一个 JSON 结构里的所有字符串值。 */
export function desensitizeDeep(
  value: unknown,
  rules: DesensitizeRule[],
): { value: unknown; hit: boolean; invalidRules: string[] } {
  let hit = false;
  const invalid = new Set<string>();

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = applyDesensitize(v, rules);
      if (r.hit) hit = true;
      r.invalidRules.forEach((n) => invalid.add(n));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };

  return { value: walk(value), hit, invalidRules: [...invalid] };
}

/**
 * 去重键（PRD F2.5）。
 *
 * 口径：同来源 + 同类型 + 同会话 + 同步 + 同时间窗 → 同一键。
 * 时间窗从配置读（默认 60s）。用 floored 时间而非精确时间戳，是为了让「同一行为
 * 被上报两次」和「两次真实但雷同的行为在同一分钟内」都收敛为一条 —— 后者丢失的
 * 信息量远小于前者造成的重复计分。
 */
export function computeDedupKey(
  draft: Pick<FeedbackDraft, 'source' | 'type' | 'stepId' | 'occurredAt'>,
  ctx: { chatJid: string | null; sessionId: string | null; windowSec: number },
): string {
  const bucket = Math.floor(draft.occurredAt / (Math.max(1, ctx.windowSec) * 1000));
  const raw = [
    draft.source,
    draft.type,
    ctx.chatJid ?? '',
    ctx.sessionId ?? '',
    draft.stepId ?? '',
    String(bucket),
  ].join('|');
  return createHash('sha1').update(raw).digest('hex');
}

/**
 * 归一化一条草稿。
 *
 * 顺序有意义：**先脱敏再序列化**。反过来会把掩码前的原文写进 normalized_payload，
 * 等于脱敏白做。raw_payload 保留**未脱敏**原文 —— 它是审计底稿，且 flm_events
 * 的读取接口全部是 admin-only。
 */
export function normalizeDraft(
  draft: FeedbackDraft,
  keys: ResolvedKeys,
  config: FlmConfig,
): NormalizedEvent {
  const desensitized = desensitizeDeep(draft.rawPayload, config.desensitizeRules);

  const confidence = Number(
    (BASE_CONFIDENCE[draft.source] * ALIGNMENT_DECAY[keys.alignment]).toFixed(3),
  );

  return {
    eventId: `evt_${randomUUID()}`,
    source: draft.source,
    type: draft.type,
    taskId: keys.taskId,
    traceId: keys.traceId,
    sessionId: keys.sessionId,
    stepId: keys.stepId,
    chatJid: keys.chatJid,
    userId: draft.userId ?? null,
    rawPayload: JSON.stringify(draft.rawPayload),
    normalizedPayload: JSON.stringify(desensitized.value),
    confidence,
    weight: config.sourceWeights[draft.source] ?? 1,
    alignment: keys.alignment,
    dedupKey: computeDedupKey(draft, {
      chatJid: keys.chatJid,
      sessionId: keys.sessionId,
      windowSec: config.dedupWindowSec,
    }),
    desensitized: desensitized.hit,
    conflict: false,
    tenantId: 'default',
    occurredAt: draft.occurredAt,
  };
}

/** 归一化结果附带的诊断信息（供 API 回显，便于验收观察脱敏是否真的生效）。 */
export interface NormalizeOutcome {
  event: NormalizedEvent;
  /** false = 命中去重键，未新增。 */
  inserted: boolean;
  invalidRules: string[];
}

/**
 * 冲突消解（PRD F2.4）。
 *
 * 场景：同一任务下，用户说"没完成"，但系统日志显示全链路成功 —— 两者矛盾。
 * 策略：按 `weight × confidence` 取高者为主导结论，被压制的标记 `conflict=true`
 * 并保留在事件流里（不删除：压制 ≠ 不存在，看板上仍需可见）。
 *
 * 返回被标记为 conflict 的 eventId 集合。
 */
export function resolveConflicts(
  events: Array<{ eventId: string; source: FeedbackSource; confidence: number; weight: number; type: string }>,
): Set<string> {
  const conflicted = new Set<string>();

  // 用户侧负向信号 vs 系统侧全成功信号 —— 唯一会被消解的矛盾对。
  const userNegative = events.filter(
    (e) => e.source === 'user' && (e.type === 'explicit_reject' || e.type === 'explicit_rating'),
  );
  const systemOk = events.filter((e) => e.source === 'system' && e.type === 'system_tool_call');
  if (userNegative.length === 0 || systemOk.length === 0) return conflicted;

  const score = (e: { confidence: number; weight: number }) => e.confidence * e.weight;
  const userTop = userNegative.reduce((a, b) => (score(a) >= score(b) ? a : b));
  const sysTop = systemOk.reduce((a, b) => (score(a) >= score(b) ? a : b));

  // 系统侧权重高（1.5）通常压过用户侧（1.0）。被压制的记 conflict。
  if (score(sysTop) > score(userTop)) conflicted.add(userTop.eventId);
  else conflicted.add(sysTop.eventId);

  return conflicted;
}

/**
 * 时序对齐（PRD F2.3）：按发生时间重建时间线，乱序输入在此修正。
 * 纯排序，但抽成函数是为了让"乱序修正"这件事在代码里可见、可测。
 */
export function orderByTime<T extends { occurredAt: number }>(events: T[]): T[] {
  return [...events].sort((a, b) => a.occurredAt - b.occurredAt);
}
