// FLM 归一化层单测 —— 纯函数，不碰数据库。
// 覆盖 PRD F2 全部验收标准：实体对齐 / 时序 / 置信度 / 冲突 / 去重 / 脱敏。

import { describe, expect, test } from 'vitest';

const {
  deriveTaskId,
  applyDesensitize,
  desensitizeDeep,
  computeDedupKey,
  normalizeDraft,
  resolveConflicts,
  orderByTime,
} = await import('../../src/flm/flm-normalize.js');
const { DEFAULT_CONFIG, DEFAULT_DESENSITIZE_RULES } = await import('../../src/flm/flm-config.js');

type Draft = Parameters<typeof normalizeDraft>[0];
type Keys = Parameters<typeof normalizeDraft>[1];

const baseKeys: Keys = {
  taskId: 'turn:T1',
  traceId: 'trace-1',
  sessionId: 'sess-1',
  stepId: null,
  chatJid: 'web:test',
  alignment: 'direct',
};

function draft(over: Partial<Draft> = {}): Draft {
  return {
    source: 'user',
    type: 'explicit_like',
    taskId: 'turn:T1',
    traceId: 'trace-1',
    sessionId: 'sess-1',
    chatJid: 'web:test',
    userId: 'u1',
    rawPayload: {},
    occurredAt: 1_700_000_000_000,
    ...over,
  };
}

describe('FLM F2 · deriveTaskId（PRD AC-F1.1.4 绑定成功率 100%）', () => {
  test('优先用 turn_id', () => {
    expect(deriveTaskId({ turnId: 'T', sessionId: 'S', messageId: 'M', occurredAt: 0 })).toBe('turn:T');
  });

  test('无 turn_id 回退 session_id', () => {
    expect(deriveTaskId({ sessionId: 'S', messageId: 'M', occurredAt: 0 })).toBe('sess:S');
  });

  test('无 session_id 回退 message_id', () => {
    expect(deriveTaskId({ messageId: 'M', occurredAt: 0 })).toBe('msg:M');
  });

  test('三者皆无也要有值（chat + 小时桶兜底），永不返回空', () => {
    const id = deriveTaskId({ chatJid: 'web:x', occurredAt: 3_600_000 });
    expect(id).toBe('chat:web:x:1');
    expect(id.length).toBeGreaterThan(0);
  });

  test('连 chatJid 都没有也不返回空', () => {
    expect(deriveTaskId({ occurredAt: 0 })).toBe('chat:unknown:0');
  });

  test('同一小时内的事件落到同一个兜底任务单元', () => {
    const a = deriveTaskId({ chatJid: 'c', occurredAt: 3_600_000 });
    const b = deriveTaskId({ chatJid: 'c', occurredAt: 3_600_000 + 60_000 });
    expect(a).toBe(b);
  });
});

describe('FLM F2 · 脱敏（PRD AC-F2.6 五类规则）', () => {
  test('手机号被掩码', () => {
    const r = applyDesensitize('联系我 13812345678 谢谢', DEFAULT_DESENSITIZE_RULES);
    expect(r.hit).toBe(true);
    expect(r.text).not.toContain('13812345678');
    expect(r.text).toContain('***PHONE***');
  });

  test('身份证被掩码（长号码规则不能误伤为手机号）', () => {
    const r = applyDesensitize('身份证 110101199003071234', DEFAULT_DESENSITIZE_RULES);
    expect(r.text).toContain('***ID***');
  });

  test('邮箱与 Token 被掩码', () => {
    const r = applyDesensitize('a@b.com 和 sk-abcdefgh12345', DEFAULT_DESENSITIZE_RULES);
    expect(r.text).toContain('***EMAIL***');
    expect(r.text).toContain('***TOKEN***');
  });

  test('同一字符串多次调用结果一致（/g 正则 lastIndex 未泄漏）', () => {
    const s = '手机 13812345678';
    const a = applyDesensitize(s, DEFAULT_DESENSITIZE_RULES);
    const b = applyDesensitize(s, DEFAULT_DESENSITIZE_RULES);
    expect(a.text).toBe(b.text);
    expect(a.hit).toBe(true);
    expect(b.hit).toBe(true);
  });

  test('无敏感信息时不误报', () => {
    const r = applyDesensitize('这是一段普通文本', DEFAULT_DESENSITIZE_RULES);
    expect(r.hit).toBe(false);
    expect(r.text).toBe('这是一段普通文本');
  });

  test('非法正则被跳过且不抛异常，坏规则单独报告', () => {
    const rules = [
      { name: '坏规则', pattern: '([unclosed', flags: 'g', mask: 'X' },
      { name: '手机号', pattern: '\\b1[3-9]\\d{9}\\b', flags: 'g', mask: '***PHONE***' },
    ];
    const r = applyDesensitize('13812345678', rules);
    expect(r.invalidRules).toContain('坏规则');
    expect(r.text).toContain('***PHONE***'); // 坏规则不影响好规则生效
  });

  test('规则热更新立即生效（不缓存编译结果）', () => {
    const before = applyDesensitize('SECRET', DEFAULT_DESENSITIZE_RULES);
    expect(before.hit).toBe(false);
    const after = applyDesensitize('SECRET', [
      { name: '自定义', pattern: 'SECRET', flags: 'g', mask: '***X***' },
    ]);
    expect(after.text).toBe('***X***');
  });

  test('desensitizeDeep 递归处理嵌套结构并保留非字符串', () => {
    const r = desensitizeDeep(
      { a: '13812345678', b: ['x@y.com'], c: 42, d: null, e: { f: '普通' } },
      DEFAULT_DESENSITIZE_RULES,
    ) as { value: Record<string, unknown>; hit: boolean };
    const v = r.value as Record<string, unknown>;
    expect(r.hit).toBe(true);
    expect(v.a).toBe('***PHONE***');
    expect((v.b as string[])[0]).toBe('***EMAIL***');
    expect(v.c).toBe(42);
    expect(v.d).toBeNull();
    expect((v.e as Record<string, unknown>).f).toBe('普通');
  });
});

describe('FLM F2 · 去重（PRD AC-F2.5）', () => {
  test('同来源同类型同会话同步、同时间窗 → 同键', () => {
    const a = computeDedupKey(draft({ occurredAt: 1000 }), { chatJid: 'c', sessionId: 's', windowSec: 60 });
    const b = computeDedupKey(draft({ occurredAt: 30_000 }), { chatJid: 'c', sessionId: 's', windowSec: 60 });
    expect(a).toBe(b);
  });

  test('跨时间窗 → 不同键', () => {
    const a = computeDedupKey(draft({ occurredAt: 1000 }), { chatJid: 'c', sessionId: 's', windowSec: 60 });
    const b = computeDedupKey(draft({ occurredAt: 120_000 }), { chatJid: 'c', sessionId: 's', windowSec: 60 });
    expect(a).not.toBe(b);
  });

  test('不同来源 / 不同类型 → 不同键', () => {
    const base = computeDedupKey(draft(), { chatJid: 'c', sessionId: 's', windowSec: 60 });
    expect(computeDedupKey(draft({ source: 'system' }), { chatJid: 'c', sessionId: 's', windowSec: 60 })).not.toBe(base);
    expect(computeDedupKey(draft({ type: 'explicit_reject' }), { chatJid: 'c', sessionId: 's', windowSec: 60 })).not.toBe(base);
  });

  test('窗口为 0 被钳到最小 1 秒，不除零；同秒内收敛、跨秒分离', () => {
    const ctx = { chatJid: 'c', sessionId: 's', windowSec: 0 };
    // 同 1 秒桶内 → 同键
    expect(computeDedupKey(draft({ occurredAt: 1000 }), ctx)).toBe(
      computeDedupKey(draft({ occurredAt: 1001 }), ctx),
    );
    // 跨秒桶 → 不同键
    expect(computeDedupKey(draft({ occurredAt: 1000 }), ctx)).not.toBe(
      computeDedupKey(draft({ occurredAt: 2000 }), ctx),
    );
  });
});

describe('FLM F2 · 置信度（PRD AC-F2.4）', () => {
  test('system 来源置信度最高，env 最低', () => {
    const u = normalizeDraft(draft({ source: 'user' }), baseKeys, DEFAULT_CONFIG);
    const s = normalizeDraft(draft({ source: 'system' }), baseKeys, DEFAULT_CONFIG);
    const e = normalizeDraft(draft({ source: 'env' }), baseKeys, DEFAULT_CONFIG);
    expect(s.confidence).toBeGreaterThan(u.confidence);
    expect(u.confidence).toBeGreaterThan(e.confidence);
  });

  test('兜底对齐打 0.6 折', () => {
    const direct = normalizeDraft(draft(), baseKeys, DEFAULT_CONFIG);
    const fallback = normalizeDraft(draft(), { ...baseKeys, alignment: 'fallback' }, DEFAULT_CONFIG);
    expect(fallback.confidence).toBeCloseTo(direct.confidence * 0.6, 3);
  });

  test('权重来自配置', () => {
    const s = normalizeDraft(draft({ source: 'system' }), baseKeys, DEFAULT_CONFIG);
    expect(s.weight).toBe(DEFAULT_CONFIG.sourceWeights.system);
  });
});

describe('FLM F2 · normalizeDraft 顺序正确性', () => {
  test('normalized_payload 已脱敏，raw_payload 保留原文（审计底稿）', () => {
    const evt = normalizeDraft(
      draft({ rawPayload: { note: '电话 13812345678' } }),
      baseKeys,
      DEFAULT_CONFIG,
    );
    expect(evt.normalizedPayload).not.toContain('13812345678');
    expect(evt.normalizedPayload).toContain('***PHONE***');
    expect(evt.rawPayload).toContain('13812345678');
    expect(evt.desensitized).toBe(true);
  });

  test('未命中脱敏时 desensitized=false', () => {
    const evt = normalizeDraft(draft({ rawPayload: { note: '普通内容' } }), baseKeys, DEFAULT_CONFIG);
    expect(evt.desensitized).toBe(false);
  });

  test('eventId 唯一', () => {
    const a = normalizeDraft(draft(), baseKeys, DEFAULT_CONFIG);
    const b = normalizeDraft(draft(), baseKeys, DEFAULT_CONFIG);
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe('FLM F2 · 冲突消解（PRD AC-F2.4）', () => {
  test('用户说失败、系统说成功 → 权重低者被标记 conflict', () => {
    const conflicted = resolveConflicts([
      { eventId: 'u1', source: 'user', type: 'explicit_reject', confidence: 0.9, weight: 1.0 },
      { eventId: 's1', source: 'system', type: 'system_tool_call', confidence: 1.0, weight: 1.5 },
    ]);
    expect(conflicted.has('u1')).toBe(true);
    expect(conflicted.has('s1')).toBe(false);
  });

  test('无矛盾对时不标记任何事件', () => {
    expect(
      resolveConflicts([
        { eventId: 'u1', source: 'user', type: 'explicit_like', confidence: 0.9, weight: 1.0 },
        { eventId: 's1', source: 'system', type: 'system_tool_call', confidence: 1.0, weight: 1.5 },
      ]).size,
    ).toBe(0);
  });

  test('只有单边时无冲突', () => {
    expect(
      resolveConflicts([{ eventId: 'u1', source: 'user', type: 'explicit_reject', confidence: 0.9, weight: 1 }]).size,
    ).toBe(0);
  });
});

describe('FLM F2 · 时序对齐（PRD AC-F2.3）', () => {
  test('乱序输入被修正为时间序', () => {
    const ordered = orderByTime([{ occurredAt: 300 }, { occurredAt: 100 }, { occurredAt: 200 }]);
    expect(ordered.map((e) => e.occurredAt)).toEqual([100, 200, 300]);
  });

  test('不修改原数组', () => {
    const input = [{ occurredAt: 2 }, { occurredAt: 1 }];
    orderByTime(input);
    expect(input.map((e) => e.occurredAt)).toEqual([2, 1]);
  });
});
