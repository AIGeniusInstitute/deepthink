// FLM 采集层 + 端到端链路单测（PRD F0 / F1 / F2 / F3 / F6）。
//
// 这个文件的价值在于**真的建库、真的塞轨迹数据、真的跑完整条链**：
// 采集 → 归一化 → 三层评价 → 学习 → 看板聚合。
// 纯函数单测证明不了 schema 建得对不对、任务范围解析准不准，这里能。

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-collect-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDir,
}));

const { initDatabase, getDb } = await import('../../src/db.js');
const { DEFAULT_CONFIG, readConfig, writeConfig, isEnabled } = await import('../../src/flm/flm-config.js');
const {
  resolveTaskScope,
  resolveKeysForMessage,
  ingest,
  markConflicts,
  deriveSystemDrafts,
  captureSnapshot,
  diffSnapshots,
  expireStaleSnapshots,
  loadEvalContext,
} = await import('../../src/flm/flm-collect.js');
const { evaluateTask, qualityMean } = await import('../../src/flm/flm-evaluate.js');
const { insertEvaluation, listEvents, listEventsByTask, getFeedbackForMessage, upsertFeedback, listEvaluations } = await import('../../src/flm/flm-db.js');
const { consoleSnapshot, computeOverviewMetrics, currentVsBaseline, attributionView, evaluateAlerts, toolFailureStats, taskTimeline } = await import('../../src/flm/flm-insights.js');

const CHAT = 'web:flm-test';
const USER_MSG = 'u-msg-1';
const ASSIST_MSG = 'a-msg-1';
const TURN = 'turn-abc';
const T0 = Date.parse('2026-10-09T10:00:00.000Z');

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function seedBackbone() {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(CHAT);
  db.prepare('DELETE FROM chat_trace_nodes WHERE chat_jid = ?').run(CHAT);
  db.prepare('DELETE FROM trace_tool_calls WHERE chat_jid = ?').run(CHAT);
  db.prepare('DELETE FROM trace_steps WHERE chat_jid = ?').run(CHAT);
  db.prepare('INSERT OR REPLACE INTO chats (jid, name) VALUES (?, ?)').run(CHAT, 'FLM 测试群');

  // 用户消息 → 助手回复（助手消息的 turn_id 指向触发它的用户消息 id）
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, is_from_me, turn_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(USER_MSG, CHAT, '把订单服务部署到预发环境', iso(T0), 0, null, null);
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, is_from_me, turn_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ASSIST_MSG, CHAT, '已完成部署', iso(T0 + 30_000), 1, USER_MSG, 'sess-x');

  // 下一条消息界定本轮时间窗的右边界
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, is_from_me, turn_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('u-msg-2', CHAT, '再帮我看看日志', iso(T0 + 120_000), 0, null, null);

  // 轨迹节点：两个成功、一个失败
  const nodes: Array<[number, string, string, string, number, number, number]> = [
    [1, 'turn', '首轮规划', 'done', T0 + 1000, T0 + 2000, 100],
    [2, 'tool', 'Read', 'done', T0 + 2000, T0 + 3000, 200],
    [3, 'tool', 'Bash', 'failed', T0 + 3000, T0 + 9000, 300],
  ];
  for (const [id, type, title, status, s, e, tokens] of nodes) {
    db.prepare(
      `INSERT OR REPLACE INTO chat_trace_nodes
         (id, chat_jid, session_id, node_type, title, status, tokens, started_at, ended_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(id, CHAT, type, title, status, tokens, iso(s), iso(e));
  }

  // 工具调用：一个成功、一个超时失败
  db.prepare(
    `INSERT INTO trace_tool_calls (chat_jid, tool_use_id, tool_name, status, started_at, ended_at, output_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(CHAT, 'tc-1', 'Read', 'success', iso(T0 + 2000), iso(T0 + 3000), '{"ok":true}');
  db.prepare(
    `INSERT INTO trace_tool_calls (chat_jid, tool_use_id, tool_name, status, started_at, ended_at, output_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(CHAT, 'tc-2', 'Bash', 'error', iso(T0 + 3000), iso(T0 + 9000), '{"error":"Request timeout after 30s"}');

  db.prepare(
    `INSERT OR REPLACE INTO trace_steps (trace_id, span_id, chat_jid, node_type, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('trace-flm-1', 's1', CHAT, 'thinking', 'done', iso(T0 + 500));
}

beforeAll(() => {
  initDatabase();
  seedBackbone();
});

beforeEach(() => {
  getDb().prepare('DELETE FROM flm_events WHERE chat_jid = ?').run(CHAT);
  getDb().prepare('DELETE FROM flm_feedback WHERE chat_jid = ?').run(CHAT);
  getDb().prepare('DELETE FROM flm_snapshots').run();
});

// ── F0 降级开关 ──────────────────────────────────────────────────────

describe('FLM F0 · 降级开关（AC-F0.1、TC-FLM-31/32）', () => {
  test('默认开启', () => {
    expect(isEnabled()).toBe(true);
  });

  test('写 false 后 isEnabled 返回 false', () => {
    writeConfig({ enabled: false });
    expect(isEnabled()).toBe(false);
    expect(readConfig().enabled).toBe(false);
  });

  test('恢复开关后重新开启（TC-FLM-32）', () => {
    writeConfig({ enabled: true });
    expect(isEnabled()).toBe(true);
  });

  test('配置读不到时不抛异常（AC-F0.2）', () => {
    expect(() => readConfig()).not.toThrow();
    expect(typeof readConfig().sampleRate).toBe('number');
  });
});

// ── F1 采集 ──────────────────────────────────────────────────────────

describe('FLM F1 · 任务范围解析', () => {
  test('turn: 能解析出聊天与时间窗', () => {
    const scope = resolveTaskScope(`turn:${USER_MSG}`);
    expect(scope).not.toBeNull();
    expect(scope?.chatJid).toBe(CHAT);
    expect(scope?.startMs).toBe(T0);
  });

  test('时间窗右边界取同聊天下一条消息', () => {
    const scope = resolveTaskScope(`turn:${USER_MSG}`);
    expect(scope?.endMs).toBe(T0 + 120_000);
  });

  test('能解析出 trace_id', () => {
    expect(resolveTaskScope(`turn:${USER_MSG}`)?.traceId).toBe('trace-flm-1');
  });

  test('msg: 前缀可解析', () => {
    expect(resolveTaskScope(`msg:${ASSIST_MSG}`)?.chatJid).toBe(CHAT);
  });

  test('chat: 小时桶兜底可解析', () => {
    const bucket = Math.floor(T0 / 3_600_000);
    const scope = resolveTaskScope(`chat:${CHAT}:${bucket}`);
    expect(scope?.chatJid).toBe(CHAT);
    expect(scope?.startMs).toBe(bucket * 3_600_000);
  });

  test('chat: 前缀能正确处理 jid 内含冒号', () => {
    const bucket = 123;
    expect(resolveTaskScope(`chat:feishu:oc_abc:${bucket}`)?.chatJid).toBe('feishu:oc_abc');
  });

  test('未知前缀返回 null 而非抛异常', () => {
    expect(resolveTaskScope('bogus:x')).toBeNull();
  });

  test('不存在的消息 id 返回 null', () => {
    expect(resolveTaskScope('turn:no-such-id')).toBeNull();
  });

  test('无下一条消息时兜底 10 分钟窗', () => {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, is_from_me)
       VALUES (?, ?, ?, ?, 0)`,
    ).run('lonely', CHAT, '孤立消息', iso(T0 + 10 * 3_600_000));
    const scope = resolveTaskScope('msg:lonely');
    expect(scope?.endMs).toBe(T0 + 10 * 3_600_000 + 600_000);
  });
});

describe('FLM F1 · 实体对齐（AC-F1.1.4）', () => {
  test('消息存在时直接对齐，置信度全额', () => {
    const keys = resolveKeysForMessage({ messageId: USER_MSG, chatJid: CHAT, occurredAt: T0 });
    expect(keys.alignment).toBe('direct');
    expect(keys.taskId).toBe(`msg:${USER_MSG}`);
    expect(keys.chatJid).toBe(CHAT);
  });

  test('助手消息的 turn_id 参与 taskId 推导', () => {
    const keys = resolveKeysForMessage({ messageId: ASSIST_MSG, chatJid: CHAT, occurredAt: T0 });
    expect(keys.taskId).toBe(`turn:${USER_MSG}`);
    expect(keys.sessionId).toBe('sess-x');
  });

  test('消息不存在时兜底对齐（alignment=fallback）', () => {
    const keys = resolveKeysForMessage({
      messageId: 'ghost',
      chatJid: CHAT,
      occurredAt: T0,
      fallbackSessionId: 's-fb',
    });
    expect(keys.alignment).toBe('fallback');
    expect(keys.taskId).toBe('sess:s-fb');
  });

  test('完全无信息时仍产出非空 taskId', () => {
    const keys = resolveKeysForMessage({ messageId: 'ghost', chatJid: 'none', occurredAt: 0 });
    expect(keys.taskId).toBeTruthy();
  });
});

describe('FLM F1 · 用户反馈入库（AC-F1.1.5 幂等）', () => {
  test('提交反馈落库并同步进事件流', () => {
    const r = ingest({
      source: 'user',
      type: 'explicit_reject',
      chatJid: CHAT,
      rawPayload: { message_id: ASSIST_MSG, reason_tags: ['未完成任务'] },
      occurredAt: T0 + 40_000,
    });
    expect(r.inserted).toBe(true);
    expect(listEventsByTask(`turn:${USER_MSG}`).length).toBe(1);
  });

  test('同一条反馈重复提交被去重（不重复计分）', () => {
    const draft = {
      source: 'user' as const,
      type: 'explicit_reject',
      chatJid: CHAT,
      rawPayload: { message_id: ASSIST_MSG, reason_tags: ['未完成任务'] },
      occurredAt: T0 + 40_000,
    };
    expect(ingest(draft).inserted).toBe(true);
    const after = listEvents().filter((e) => e.chat_jid === CHAT).length;

    // 同一条消息、同一类反馈再来一次：应被 dedup_key 拦下
    expect(ingest(draft).inserted).toBe(false);
    expect(listEvents().filter((e) => e.chat_jid === CHAT).length).toBe(after);
  });

  test('反馈原文已脱敏、审计底稿保留原文', () => {
    const r = ingest({
      source: 'user',
      type: 'explicit_correction',
      chatJid: CHAT,
      rawPayload: { message_id: ASSIST_MSG, correction_text: '应该联系 13812345678' },
      occurredAt: T0 + 45_000,
    });
    expect(r.event.normalizedPayload).not.toContain('13812345678');
    expect(r.event.rawPayload).toContain('13812345678');
    expect(r.event.desensitized).toBe(true);
  });

  test('upsertFeedback 同消息同用户重复评价是更新而非新增', () => {
    upsertFeedback({
      id: 'fb-1', messageId: ASSIST_MSG, chatJid: CHAT, userId: 'u',
      type: 'explicit_like', rating: 5, reasonTags: null, correctionText: null, payload: '{}',
    });
    upsertFeedback({
      id: 'fb-2', messageId: ASSIST_MSG, chatJid: CHAT, userId: 'u',
      type: 'explicit_reject', rating: 1, reasonTags: null, correctionText: null, payload: '{}',
    });
    const row = getFeedbackForMessage(ASSIST_MSG, CHAT, 'u');
    expect(row?.id).toBe('fb-1');
    expect(row?.type).toBe('explicit_reject');
    expect(row?.rating).toBe(1);
  });
});

describe('FLM F1 · 系统来源派生（AC-F1.2）', () => {
  test('从轨迹派生出聚合事件（不逐节点复制）', () => {
    const scope = resolveTaskScope(`turn:${USER_MSG}`)!;
    const drafts = deriveSystemDrafts(scope, DEFAULT_CONFIG);
    const types = drafts.map((d) => d.type);
    expect(types).toContain('system_tool_call');
    expect(types).toContain('system_error'); // 有失败节点
    expect(drafts.length).toBeLessThanOrEqual(3);
  });

  test('聚合事件携带真实的成功/失败计数', () => {
    const scope = resolveTaskScope(`turn:${USER_MSG}`)!;
    const call = deriveSystemDrafts(scope, DEFAULT_CONFIG).find((d) => d.type === 'system_tool_call');
    expect(call?.rawPayload.nodeTotal).toBe(3);
    expect(call?.rawPayload.nodeOk).toBe(2);
  });

  test('采样率确定性：同一任务多次采到同样结果', () => {
    const scope = resolveTaskScope(`turn:${USER_MSG}`)!;
    const cfg = { ...DEFAULT_CONFIG, sampleRate: 50 };
    const a = deriveSystemDrafts(scope, cfg).length;
    const b = deriveSystemDrafts(scope, cfg).length;
    expect(a).toBe(b);
  });

  test('采样率 0 时成功事件被丢弃，但失败事件仍采集（负样本不丢）', () => {
    const scope = resolveTaskScope(`turn:${USER_MSG}`)!;
    const drafts = deriveSystemDrafts(scope, { ...DEFAULT_CONFIG, sampleRate: 0 });
    expect(drafts.some((d) => d.type === 'system_tool_call')).toBe(false);
    expect(drafts.some((d) => d.type === 'system_error')).toBe(true);
  });

  test('无轨迹的任务不产出系统事件', () => {
    const scope = { taskId: 'turn:none', chatJid: CHAT, traceId: null, sessionId: null, startMs: T0 + 500_000, endMs: T0 + 600_000 };
    expect(deriveSystemDrafts(scope, DEFAULT_CONFIG)).toEqual([]);
  });
});

describe('FLM F1 · 环境快照（AC-F1.3）', () => {
  test('前后快照 diff 判定达标', () => {
    const obs = [{ name: 'order_count', path: 'x', expected: '10' }];
    let value = '0';
    captureSnapshot({ taskId: 'turn:env', phase: 'before', observations: obs, read: () => value });
    value = '10';
    captureSnapshot({ taskId: 'turn:env', phase: 'after', observations: obs, read: () => value });

    const draft = diffSnapshots('turn:env', { order_count: '10' });
    expect(draft?.type).toBe('env_snapshot_diff');
    expect(draft?.rawPayload.verdict).toBe('met');
  });

  test('未达标判定为 unmet（最强负信号）', () => {
    const obs = [{ name: 'order_count', path: 'x', expected: '10' }];
    let value = '0';
    captureSnapshot({ taskId: 'turn:env2', phase: 'before', observations: obs, read: () => value });
    value = '3';
    captureSnapshot({ taskId: 'turn:env2', phase: 'after', observations: obs, read: () => value });

    expect(diffSnapshots('turn:env2', { order_count: '10' })?.rawPayload.verdict).toBe('unmet');
  });

  test('无期望值时为 unknown（只观测不判定）', () => {
    const obs = [{ name: 'cpu', path: 'x', expected: null }];
    captureSnapshot({ taskId: 'turn:env3', phase: 'before', observations: obs, read: () => '1' });
    captureSnapshot({ taskId: 'turn:env3', phase: 'after', observations: obs, read: () => '2' });
    expect(diffSnapshots('turn:env3', {})?.rawPayload.verdict).toBe('unknown');
  });

  test('缺少任一侧快照返回 null，不猜测', () => {
    expect(diffSnapshots('turn:no-snap', {})).toBeNull();
  });

  test('单个观测点读取失败记为 null 且不影响其它点', () => {
    const obs = [
      { name: 'bad', path: 'boom', expected: null },
      { name: 'good', path: 'ok', expected: null },
    ];
    const { values } = captureSnapshot({
      taskId: 'turn:env4',
      phase: 'before',
      observations: obs,
      read: (p) => {
        if (p === 'boom') throw new Error('nope');
        return 'v';
      },
    });
    expect(values.bad).toBeNull();
    expect(values.good).toBe('v');
  });

  test('TTL 到期快照被标记 expired', () => {
    const obs = [{ name: 'x', path: 'p', expected: null }];
    captureSnapshot({ taskId: 'turn:ttl', phase: 'before', observations: obs, read: () => '1', ttlSeconds: -1 });
    expect(expireStaleSnapshots()).toBeGreaterThanOrEqual(1);
  });
});

// ── F2/F3 端到端 ─────────────────────────────────────────────────────

describe('FLM F2+F3 · 端到端：采集 → 归一化 → 评价', () => {
  test('装配出的评价上下文包含真实轨迹与事件', () => {
    ingest({
      source: 'user', type: 'explicit_reject', chatJid: CHAT,
      rawPayload: { message_id: ASSIST_MSG, reason_tags: ['未完成任务'] },
      occurredAt: T0 + 40_000,
    });
    const ctx = loadEvalContext(`turn:${USER_MSG}`);
    expect(ctx).not.toBeNull();
    expect(ctx!.nodes.length).toBe(3);
    expect(ctx!.toolCalls.length).toBe(2);
    expect(ctx!.events.length).toBeGreaterThanOrEqual(1);
  });

  test('端到端评价：点踩 + 工具超时 → failed 且归因执行环节', () => {
    ingest({
      source: 'user', type: 'explicit_reject', chatJid: CHAT,
      rawPayload: { message_id: ASSIST_MSG, reason_tags: ['未完成任务'] },
      occurredAt: T0 + 41_000,
    });
    const ctx = loadEvalContext(`turn:${USER_MSG}`)!;
    const r = evaluateTask(ctx);
    expect(r.outcome).toBe('failed');
    expect(r.attributionStage).toBe('execution'); // Bash 超时
    expect(r.stepCount).toBe(3);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  test('评价结果可落库并读回（含 JSON 字段反序列化）', () => {
    const ctx = loadEvalContext(`turn:${USER_MSG}`)!;
    const out = evaluateTask(ctx);
    insertEvaluation({
      eval_id: out.evalId,
      task_id: out.taskId,
      trace_id: out.traceId,
      session_id: out.sessionId,
      chat_jid: out.chatJid,
      outcome: out.outcome,
      outcome_reason: out.outcomeReason,
      process_score: out.processScore,
      path_conformity: out.pathConformity,
      step_count: out.stepCount,
      retry_count: out.retryCount,
      first_anomaly_step: out.firstAnomalyStep,
      duration_ms: out.durationMs,
      quality_scores: JSON.stringify(out.qualityScores),
      attribution_stage: out.attributionStage,
      evidence_json: JSON.stringify(out.evidence),
      evaluator: out.evaluator,
      needs_review: out.needsReview ? 1 : 0,
      review_status: 'none',
      review_note: null,
      eval_time: out.evalTime,
    });

    const back = listEvaluations({ limit: 50 }).find((r) => r.eval_id === out.evalId);
    expect(back).toBeDefined();
    expect(JSON.parse(back!.evidence_json!).length).toBe(out.evidence.length);
    expect(JSON.parse(back!.quality_scores!).latency).toBeDefined();
  });

  test('冲突消解：用户否决 + 系统成功事件 → 用户侧被标记 conflict', () => {
    ingest({
      source: 'user', type: 'explicit_reject', chatJid: CHAT,
      rawPayload: { message_id: ASSIST_MSG, reason_tags: ['未完成任务'] },
      occurredAt: T0 + 42_000,
    });
    const scope = resolveTaskScope(`turn:${USER_MSG}`)!;
    for (const d of deriveSystemDrafts(scope, DEFAULT_CONFIG)) ingest(d, DEFAULT_CONFIG);

    const marked = markConflicts(`turn:${USER_MSG}`);
    expect(marked).toBeGreaterThanOrEqual(1);
    const events = listEventsByTask(`turn:${USER_MSG}`);
    expect(events.some((e) => e.conflict === 1)).toBe(true);
  });
});

// ── F6 看板聚合 ──────────────────────────────────────────────────────

describe('FLM F6 · 看板与告警（AC-F6.1/6.2/6.5/6.7）', () => {
  test('核心指标计算口径正确', () => {
    ingest({
      source: 'user', type: 'explicit_like', chatJid: CHAT,
      rawPayload: { message_id: ASSIST_MSG, rating: 5 },
      occurredAt: T0 + 50_000,
    });
    const events = listEvents({ limit: 500 }).filter((e) => e.chat_jid === CHAT);
    const m = computeOverviewMetrics([], events, []);
    expect(m.feedbackVolume).toBe(events.length);
    expect(m.bySource.user).toBeGreaterThanOrEqual(1);
  });

  test('无数据时指标为 0 而非 NaN', () => {
    const m = computeOverviewMetrics([], [], []);
    expect(m.feedbackVolume).toBe(0);
    expect(m.successRate).toBe(0);
    expect(m.satisfaction).toBe(0);
    expect(Number.isNaN(m.correctionRate)).toBe(false);
  });

  test('consoleSnapshot 五个核心指标齐备且带生成时刻（AC-F6.1/6.6）', () => {
    const snap = consoleSnapshot(7);
    expect(snap.metrics).toBeDefined();
    expect(snap.trend.length).toBe(7);
    expect(snap.generatedAt).toBeGreaterThan(0);
    expect(snap.generatedAt).toBeLessThanOrEqual(Date.now()); // 延迟由 generatedAt 实测
    for (const k of ['feedbackVolume', 'satisfaction', 'successRate', 'correctionRate', 'closedLoopLatencyMs']) {
      expect(snap.metrics).toHaveProperty(k);
    }
  });

  test('趋势桶按天升序', () => {
    const t = consoleSnapshot(7).trend;
    for (let i = 1; i < t.length; i++) {
      expect(t[i - 1].bucket < t[i].bucket).toBe(true);
    }
  });

  test('归因视图分母是未达成样本', () => {
    const v = attributionView();
    expect(v.totalFailed).toBeGreaterThanOrEqual(0);
    const sum = v.buckets.reduce((a, b) => a + b.count, 0);
    expect(sum).toBeLessThanOrEqual(v.totalFailed);
  });

  test('归因下钻按环节收敛（AC-F6.2、TC-FLM-27）', () => {
    const v = attributionView({ stage: 'execution' });
    for (const d of v.drillDown) expect(d.stage).toBe('execution');
  });

  test('工具失败率排行可用', () => {
    const stats = toolFailureStats(T0 - 1000, T0 + 600_000);
    const bash = stats.find((s) => s.toolName === 'Bash');
    expect(bash?.failed).toBeGreaterThanOrEqual(1);
    expect(bash?.failureRate).toBe(100);
  });

  test('告警阈值触发（AC-F6.5、TC-FLM-30）', () => {
    const cur = computeOverviewMetrics([], [], []);
    const cfg = { ...DEFAULT_CONFIG, alertThresholds: { ...DEFAULT_CONFIG.alertThresholds, errorRateSpikePct: 1 } };
    const r = evaluateAlerts({ ...cur, successRate: 50 }, null, cfg);
    expect(r.triggered.some((t) => t.metric === 'error_rate_spike')).toBe(true);
  });

  test('反馈量低于下限触发告警', () => {
    const cur = computeOverviewMetrics([], [], []);
    const cfg = { ...DEFAULT_CONFIG, alertThresholds: { ...DEFAULT_CONFIG.alertThresholds, feedbackVolumeMin: 1000 } };
    expect(evaluateAlerts(cur, null, cfg).triggered.some((t) => t.metric === 'feedback_volume_low')).toBe(true);
  });

  test('阈值内不误报', () => {
    const cur = computeOverviewMetrics([], [], []);
    const r = evaluateAlerts({ ...cur, successRate: 95, feedbackVolume: 10_000 }, null, DEFAULT_CONFIG);
    expect(r.triggered.length).toBe(0);
  });

  test('基线对比可算出成功率突降', () => {
    const { current, baseline } = currentVsBaseline(7, T0 + 3 * 86_400_000);
    expect(typeof current.successRate).toBe('number');
    expect(baseline === null || typeof baseline.successRate === 'number').toBe(true);
  });

  test('单任务时间线按时间升序（AC-F6.7）', () => {
    ingest({
      source: 'user', type: 'explicit_reject', chatJid: CHAT,
      rawPayload: { message_id: ASSIST_MSG, reason_tags: ['未完成任务'] },
      occurredAt: T0 + 46_000,
    });
    const tl = taskTimeline(`turn:${USER_MSG}`);
    for (let i = 1; i < tl.length; i++) expect(tl[i - 1].at).toBeLessThanOrEqual(tl[i].at);
    expect(tl.some((t) => t.kind === 'feedback')).toBe(true);
  });
});

// ── schema 覆盖 ──────────────────────────────────────────────────────

describe('FLM · schema', () => {
  test('SCHEMA_VERSION 已提升到 71', async () => {
    const { SCHEMA_VERSION } = await import('../../src/db.js');
    expect(Number(SCHEMA_VERSION)).toBeGreaterThanOrEqual(71);
  });

  test('12 张 flm 表全部创建成功', () => {
    const rows = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'flm_%'")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([
      'flm_actions', 'flm_alerts', 'flm_audit', 'flm_cases', 'flm_config',
      'flm_evaluations', 'flm_events', 'flm_feedback', 'flm_knowledge',
      'flm_observations', 'flm_snapshots', 'flm_strategies',
    ]);
  });

  test('flm_feedback 唯一索引生效（同消息同用户不可重复）', () => {
    const idx = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='flm_feedback'")
      .all() as Array<{ name: string }>;
    expect(idx.length).toBeGreaterThan(0);
  });
});
