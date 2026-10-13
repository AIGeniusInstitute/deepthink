// Agent Runtime Monitor — 时间归一工具。
//
// 这个模块存在的原因只有一个：8 个运行来源里 `sandbox_executions.created_at`
// 是 epoch 毫秒，其余都是 ISO 字符串。UNION 后按字符串排序，epoch 数字会排到
// 所有 ISO 字符串前面 —— 静默、且错得不明显。这里的用例锁住换算与桶枚举的边界。

import { describe, expect, test } from 'vitest';
import {
  ageMs,
  durationMsBetween,
  enumerateBuckets,
  epochMsToIso,
  floorToBucket,
  parseIso,
} from '../../src/runtime-monitor/time.js';

describe('parseIso', () => {
  test('解析合法 ISO；空值/垃圾值返回 null', () => {
    expect(parseIso('2026-10-13T12:00:00.000Z')).toBe(Date.parse('2026-10-13T12:00:00.000Z'));
    expect(parseIso(null)).toBeNull();
    expect(parseIso(undefined)).toBeNull();
    expect(parseIso('')).toBeNull();
    expect(parseIso('not-a-date')).toBeNull();
  });
});

describe('durationMsBetween', () => {
  test('正常区间取差', () => {
    expect(durationMsBetween('2026-10-13T12:00:00.000Z', '2026-10-13T12:00:30.000Z')).toBe(30_000);
  });

  test('任一缺失 → null（而不是 0）', () => {
    // 0 会被 UI 渲染成"瞬时完成"，与"未结束"是两回事
    expect(durationMsBetween('2026-10-13T12:00:00.000Z', null)).toBeNull();
    expect(durationMsBetween(null, '2026-10-13T12:00:00.000Z')).toBeNull();
    expect(durationMsBetween(null, null)).toBeNull();
  });

  test('结束早于开始（时钟回拨）→ 夹到 0，不产生负数', () => {
    expect(durationMsBetween('2026-10-13T12:00:30.000Z', '2026-10-13T12:00:00.000Z')).toBe(0);
  });
});

describe('ageMs', () => {
  test('距今毫秒，且不为负', () => {
    const now = Date.parse('2026-10-13T12:00:00.000Z');
    expect(ageMs('2026-10-13T11:00:00.000Z', now)).toBe(3_600_000);
    // 未来时间 → 0，而不是负数（负数会让 stale 判定失效）
    expect(ageMs('2026-10-13T13:00:00.000Z', now)).toBe(0);
    expect(ageMs(null, now)).toBeNull();
  });
});

describe('floorToBucket / enumerateBuckets', () => {
  test('桶边界取整', () => {
    expect(floorToBucket('2026-10-13T12:34:56.000Z', 'hour')).toBe('2026-10-13T12');
    expect(floorToBucket('2026-10-13T12:34:56.000Z', 'day')).toBe('2026-10-13');
  });

  test('小时桶枚举含首桶、不含 to 所在桶', () => {
    const buckets = enumerateBuckets('2026-10-13T10:30:00.000Z', '2026-10-13T13:00:00.000Z', 'hour');
    expect(buckets).toEqual(['2026-10-13T10', '2026-10-13T11', '2026-10-13T12']);
  });

  test('**空桶也要枚举出来** —— 否则趋势图会把两段安静期画成相邻点', () => {
    const buckets = enumerateBuckets('2026-10-13T00:00:00.000Z', '2026-10-13T04:00:00.000Z', 'hour');
    expect(buckets).toHaveLength(4);
  });

  test('天桶枚举：首尾两个**部分覆盖**的桶都要算进来', () => {
    // 10-11T05:00 → 10-13T05:00 横跨 10-11（半天）/ 10-12（整天）/ 10-13（半天），
    // 三个桶里都有数据，漏掉首尾任意一个都会让趋势图少画柱子。
    const buckets = enumerateBuckets('2026-10-11T05:00:00.000Z', '2026-10-13T05:00:00.000Z', 'day');
    expect(buckets).toEqual(['2026-10-11', '2026-10-12', '2026-10-13']);
  });

  test('恰好落在桶边界上的 to 不产生空桶', () => {
    // to=10-13T00:00 是 10-13 桶的起点，该桶内没有任何时刻 < to
    const buckets = enumerateBuckets('2026-10-11T05:00:00.000Z', '2026-10-13T00:00:00.000Z', 'day');
    expect(buckets).toEqual(['2026-10-11', '2026-10-12']);
  });

  test('区间非法（to <= from / 无法解析）→ 空数组，不抛', () => {
    expect(enumerateBuckets('2026-10-13T12:00:00.000Z', '2026-10-13T12:00:00.000Z', 'hour')).toEqual([]);
    expect(enumerateBuckets('garbage', '2026-10-13T12:00:00.000Z', 'hour')).toEqual([]);
  });
});

describe('epochMsToIso', () => {
  test('SQLite 分支产出与 chat_trace_nodes.started_at 同格式的表达式', () => {
    const expr = epochMsToIso('created_at');
    expect(expr).toContain('strftime');
    expect(expr).toContain('created_at');
    expect(expr).toContain('unixepoch');
  });

  test('**算术表达式必须被括号包住** —— `/` 优先级高于 `+`', () => {
    // 回归：曾经生成 `created_at + duration_ms / 1000.0`，等价于
    // `created_at + (duration_ms/1000)`，算出的 epoch 超出 strftime 范围 → 静默 NULL。
    const expr = epochMsToIso('created_at + duration_ms');
    expect(expr).toContain('(created_at + duration_ms) / 1000.0');
    expect(expr).not.toContain('created_at + duration_ms / 1000.0');
  });

  test('PG 分支锁定 UTC，避免同一行在不同部署渲染成不同字符串', () => {
    // 直接断言方言分支不可行（isPostgresBackend 在模块加载时求值），
    // 改为锁住 SQLite 分支的格式字符串，PG 分支由 TECH_SOLUTION §6.3 说明。
    expect(epochMsToIso('c')).toMatch(/%Y-%m-%dT%H:%M:%fZ/);
  });
});
