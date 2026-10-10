// FLM 控制台出口路由单测（AC-F6.2 / AC-F4.6、TC-FLM-04/05/13/19/27、TC-FLM-06）。
//
// 这一组用例的存在理由和 flm-strategy-routes 同源：这些接口原先**后端实现了但没人调用**。
// 控制台上的「批量评价」传空数组、来源筛选没有出口、数据回流没有导出、工具/智能体
// 维度只能在库里算却拿不出来 —— 功能看着齐了，运营一个都用不上。
//
// 所以这里真的挂 Hono、真的建库塞数据、真的发请求，把"接口通不通 + 数据对不对"一起钉住。

import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-console-routes-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDir,
}));

vi.mock('../../src/middleware/auth.js', async () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: 'u-admin', username: 'admin', role: 'admin' });
    await next();
  },
  adminRoleMiddleware: async (_c: any, next: any) => {
    await next();
  },
}));

const { initDatabase, getDb } = await import('../../src/db.js');
const { default: flmRoutes } = await import('../../src/routes/flm.js');
const { writeConfig, readConfig } = await import('../../src/flm/flm-config.js');
const { insertEventIfNew, insertEvaluation, insertStrategy } = await import('../../src/flm/flm-db.js');
const { taskGoalText } = await import('../../src/flm/flm-collect.js');

const app = new Hono();
app.route('/api/flm', flmRoutes);

const CHAT = 'web:flm-console';
const GOAL = '把订单服务部署到预发环境并跑通冒烟';
const T0 = Date.parse('2026-10-09T10:00:00.000Z');
// 任务 id 就是 turn:<触发本回合的用户消息 id> —— 不是随便造的名，必须真的能在
// messages 里解析出范围，否则 taskGoalText 会退化成 taskId（那正是本文件要防的回归）。
const TASK_OK = 'turn:c-u1';
const TASK_BAD = 'turn:c-u2';

const iso = (ms: number) => new Date(ms).toISOString();

/** 塞一整套最小骨架：消息 + 两类事件 + 一正一负两条评价。 */
function seed() {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(CHAT);
  db.prepare('DELETE FROM flm_events').run();
  db.prepare('DELETE FROM flm_evaluations').run();
  db.prepare('INSERT OR REPLACE INTO chats (jid, name) VALUES (?, ?)').run(CHAT, 'FLM 控制台测试群');

  // 两条用户消息各自开启一个任务窗（下一条消息界定上一条的右边界）。
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, is_from_me, turn_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('c-u1', CHAT, GOAL, iso(T0), 0, null, null);
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, is_from_me, turn_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('c-a1', CHAT, '部署完成', iso(T0 + 30_000), 1, 'c-u1', 'sess-a');
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, is_from_me, turn_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('c-u2', CHAT, GOAL, iso(T0 + 3_600_000), 0, null, null);
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, is_from_me, turn_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('c-a2', CHAT, '部署失败', iso(T0 + 3_630_000), 1, 'c-u2', 'sess-a');
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, is_from_me, turn_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('c-u3', CHAT, '先不用了', iso(T0 + 7_200_000), 0, null, null);

  // 一条系统事件（供来源筛选与工具维度下钻）+ 一条环境事件（供冲突/来源计数）。
  insertEventIfNew({
    event_id: 'ev-console-1', source: 'system', type: 'implicit_abandon',
    task_id: TASK_BAD, trace_id: null, session_id: null, step_id: null,
    chat_jid: CHAT, user_id: null, raw_payload: null, normalized_payload: null,
    confidence: 1, weight: 1.5, alignment: 'direct', dedup_key: 'dk-console-1',
    desensitized: 0, conflict: 0, tenant_id: 'default',
    occurred_at: T0 + 3_600_000, created_at: T0 + 3_600_000,
  } as never);
  insertEventIfNew({
    event_id: 'ev-console-2', source: 'user', type: 'explicit_like',
    task_id: TASK_OK, trace_id: null, session_id: null, step_id: null,
    chat_jid: CHAT, user_id: 'u1', raw_payload: null, normalized_payload: null,
    confidence: 0.9, weight: 1, alignment: 'direct', dedup_key: 'dk-console-2',
    desensitized: 0, conflict: 1, tenant_id: 'default',
    occurred_at: T0 + 30_000, created_at: T0 + 30_000,
  } as never);

  // 一正一负两条评价：同目标下的成败差异才配得出偏好对。
  const mkEval = (evalId: string, taskId: string, outcome: string, stage: string | null) =>
    insertEvaluation({
      eval_id: evalId, task_id: taskId, trace_id: null, session_id: null, chat_jid: CHAT,
      outcome, outcome_reason: outcome === 'achieved' ? '部署成功且冒烟通过' : '部署脚本超时',
      process_score: outcome === 'achieved' ? 90 : 40,
      path_conformity: 0.9, step_count: 12, retry_count: 0,
      first_anomaly_step: outcome === 'achieved' ? null : 'tool:Bash',
      duration_ms: 30_000, quality_scores: JSON.stringify({ correctness: 88 }),
      attribution_stage: stage, evidence_json: JSON.stringify([{ kind: 'tool_call', ref: 'Bash' }]),
      evaluator: 'rule', needs_review: 0, review_status: 'pending', review_note: null,
      eval_time: T0 + 60_000,
    } as never);
  mkEval('eval-console-ok', TASK_OK, 'achieved', null);
  mkEval('eval-console-bad', TASK_BAD, 'failed', 'execution');

  // 工具调用记录，供 /admin/insights/tools 聚合。
  db.prepare('DELETE FROM trace_tool_calls WHERE chat_jid = ?').run(CHAT);
  db.prepare(
    `INSERT INTO trace_tool_calls (chat_jid, tool_use_id, tool_name, status, started_at, ended_at, output_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(CHAT, 'ct-1', 'Bash', 'error', iso(T0 + 3_600_000), iso(T0 + 3_660_000), '{"error":"timeout"}');
  db.prepare(
    `INSERT INTO trace_tool_calls (chat_jid, tool_use_id, tool_name, status, started_at, ended_at, output_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(CHAT, 'ct-2', 'Bash', 'success', iso(T0 + 30_000), iso(T0 + 40_000), '{"ok":true}');
}

beforeAll(() => {
  initDatabase();
  seed();
  writeConfig({ ...readConfig(), enabled: true }, 'test');
});

const get = (url: string) => app.request(url);

const post = (url: string, body?: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('FLM 近期任务出口（TC-FLM-13 批量评价的输入）', () => {
  test('任务列表带真实目标文本，而不是 taskId 本身', async () => {
    const res = await get('/api/flm/admin/tasks/recent?limit=50');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ taskId: string; goal: string; evaluated: boolean }> };

    const bad = body.tasks.find((t) => t.taskId === TASK_BAD);
    expect(bad).toBeTruthy();
    // 这条是本次修复的核心：拿 taskId（turn:xxx）当目标文本，两条任务的"目标"
    // 永远不可能相似，偏好配对与案例检索会全空 —— 功能在跑但结果是零。
    expect(bad!.goal).toBe(GOAL);
    expect(bad!.goal).not.toContain('turn:');
  });

  test('evaluated 标记区分已评/未评，避免重复消耗模型额度', async () => {
    const body = (await (await get('/api/flm/admin/tasks/recent?limit=50')).json()) as {
      tasks: Array<{ taskId: string; evaluated: boolean }>;
    };
    expect(body.tasks.find((t) => t.taskId === TASK_BAD)!.evaluated).toBe(true);
  });

  test('没有对应消息的任务退化为 taskId，而不是空串', async () => {
    // 空串参与相似度计算会污染配对，所以宁可退化成 taskId。
    expect(taskGoalText('turn:不存在的任务')).toBe('turn:不存在的任务');
  });
});

// ── 评价必须落库（AC-F3.1，2026-10-10 回归）────────────────────────────
//
// 曾经的缺陷：`POST /admin/evaluate` 调 `evaluateTask` 拿到结果就直接塞进响应返回，
// **从不调用 insertEvaluation**。接口返回 evaluated=4，flm_evaluations 却是 0 行。
// 后果是整条 F3→F6 在运行实例上全空：评价记录、复核队列、案例库、策略、偏好对、
// 看板成功率、归因分布、自动回滚巡检，全部恒为空。
//
// 单测之所以一直绿，是因为用例自己调了 insertEvaluation —— 等于把生产代码漏掉的
// 接线在测试里补上了。所以这条用例必须**只打 HTTP 接口**，再去库里核对。
describe('FLM 评价落库（AC-F3.1）', () => {
  test('POST /admin/evaluate 的评价真的写进 flm_evaluations 并能被列表接口读到', async () => {
    const db = getDb();
    db.prepare("DELETE FROM flm_evaluations WHERE task_id = ?").run(TASK_OK);

    const res = await post('/api/flm/admin/evaluate', { taskIds: [TASK_OK], useLlm: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evaluated: number; results: Array<{ evalId: string }> };
    expect(body.evaluated).toBe(1);

    const persisted = db.prepare('SELECT * FROM flm_evaluations WHERE task_id = ?').get(TASK_OK) as
      | { eval_id: string; outcome: string; evidence_json: string; quality_scores: string; review_status: string }
      | undefined;
    expect(persisted).toBeTruthy();
    expect(persisted!.eval_id).toBe(body.results[0].evalId);
    // 证据链与质量分必须一并落库，否则「评价可解释」只在响应里成立、控制台上拿不到。
    expect(JSON.parse(persisted!.evidence_json).length).toBeGreaterThan(0);
    expect(Object.keys(JSON.parse(persisted!.quality_scores)).length).toBeGreaterThan(0);
    expect(persisted!.review_status).toBe('pending');

    // 控制台读的是列表接口，它读不到就等于没落库。
    const list = (await (await get('/api/flm/admin/evaluations?limit=100')).json()) as {
      evaluations: Array<{ eval_id: string }>;
    };
    expect(list.evaluations.some((e) => e.eval_id === body.results[0].evalId)).toBe(true);

    // 本文件共用一套种子数据，改完必须还原，否则后续断言「恰好 2 条评价」的用例会被污染。
    seed();
  });

  test('评价落库后 learn 才有输入：案例数 > 0', async () => {
    await post('/api/flm/admin/evaluate', { taskIds: [TASK_OK, TASK_BAD], useLlm: false });
    const res = await post('/api/flm/admin/learn', { limit: 200 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cases: number };
    // 评价不落库时 learn 读到的是空表 → cases 恒为 0，案例库/策略生成整条链死掉。
    expect(body.cases).toBeGreaterThan(0);

    getDb().prepare('DELETE FROM flm_cases').run();
    seed();
  });
});

describe('FLM 归一化事件流出口（TC-FLM-04/05）', () => {
  test('事件流带来源 / 置信度 / 权重 / 对齐 / 冲突标记', async () => {
    const res = await get('/api/flm/admin/events?limit=50');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ event_id: string; source: string; confidence: number; weight: number; alignment: string; conflict: number }>;
    };
    const ev = body.events.find((e) => e.event_id === 'ev-console-2');
    expect(ev).toBeTruthy();
    expect(ev!.source).toBe('user');
    expect(ev!.confidence).toBeCloseTo(0.9, 3);
    expect(ev!.alignment).toBe('direct');
    // 冲突标记必须出得来：运营靠它判断"这条反馈算没算数"。
    expect(ev!.conflict).toBe(1);
  });

  test('按来源筛选只返回该来源的事件（AC-F6.2）', async () => {
    const body = (await (await get('/api/flm/admin/events?source=system&limit=50')).json()) as {
      events: Array<{ source: string }>;
    };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.source === 'system')).toBe(true);
  });

  test('非法来源值被忽略（退回全量）而不是返回空集', async () => {
    const body = (await (await get('/api/flm/admin/events?source=不存在的来源&limit=50')).json()) as {
      events: unknown[];
    };
    expect(body.events.length).toBeGreaterThan(1);
  });
});

describe('FLM 下钻维度出口（AC-F6.2 / TC-FLM-27）', () => {
  test('工具失败率排行可读，且失败率按调用总数计算', async () => {
    const res = await get('/api/flm/admin/insights/tools?days=3650&limit=20');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: Array<{ toolName: string; total: number; failed: number; failureRate: number }>;
    };
    const bash = body.tools.find((t) => t.toolName === 'Bash');
    expect(bash).toBeTruthy();
    expect(bash!.total).toBe(2);
    expect(bash!.failed).toBe(1);
    expect(bash!.failureRate).toBeCloseTo(50, 1);
  });

  test('智能体维度按 chat_jid 聚合成功率', async () => {
    const res = await get('/api/flm/admin/insights/agents?limit=20');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{ chatJid: string; evaluations: number; achieved: number; successRate: number }>;
    };
    const me = body.agents.find((a) => a.chatJid === CHAT);
    expect(me).toBeTruthy();
    expect(me!.evaluations).toBe(2);
    expect(me!.achieved).toBe(1);
    expect(me!.successRate).toBeCloseTo(50, 1);
  });

  test('归因下钻按环节收敛，且带首异常步骤与原因文案', async () => {
    const res = await get('/api/flm/admin/attribution?stage=execution&limit=50');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      drillDown: Array<{ taskId: string; stage: string | null; firstAnomalyStep: string | null; outcomeReason: string | null }>;
    };
    expect(body.drillDown.length).toBeGreaterThan(0);
    expect(body.drillDown.every((d) => d.stage === 'execution')).toBe(true);
    const bad = body.drillDown.find((d) => d.taskId === TASK_BAD);
    expect(bad!.firstAnomalyStep).toBe('tool:Bash');
    expect(bad!.outcomeReason).toBe('部署脚本超时');
  });
});

describe('FLM 数据回流出口（AC-F4.6 / TC-FLM-19）', () => {
  test('同目标下的成功与失败配成偏好对，并给出可直接导出的 JSONL', async () => {
    const res = await get('/api/flm/admin/data-feedback');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      preferencePairs: Array<{ goal: string; chosen: { taskId: string | null }; rejected: { taskId: string | null } }>;
      stats: { pairs: number; positiveTasks: number; negativeTasks: number };
      jsonl: { pairs: string; sft: string };
    };

    expect(body.stats.pairs).toBeGreaterThan(0);
    const pair = body.preferencePairs[0];
    expect(pair.goal).toBe(GOAL);
    expect(pair.chosen.taskId).toBe(TASK_OK);
    expect(pair.rejected.taskId).toBe(TASK_BAD);

    // JSONL 必须是后端生成的原文：前端二次拼装会让导出内容与落库内容可能不一致。
    const lines = body.jsonl.pairs.split('\n').filter(Boolean);
    expect(lines.length).toBe(body.preferencePairs.length);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  test('没有同目标成败对照时不编造偏好对（空数组 + 空 JSONL）', async () => {
    getDb().prepare("DELETE FROM flm_evaluations WHERE task_id = ?").run(TASK_OK);
    const body = (await (await get('/api/flm/admin/data-feedback')).json()) as {
      preferencePairs: unknown[]; jsonl: { pairs: string };
    };
    expect(body.preferencePairs).toEqual([]);
    expect(body.jsonl.pairs).toBe('');
    seed();
  });
});

// ── 灰度劣化自动回滚（AC-F5.4）───────────────────────────────────────
//
// `checkCanaryRegression` / `autoRollback` 在 closedloop 单测里已经覆盖，但那些用例
// **直接调用函数**。真正的风险是"运行时没有任何调用点" —— 自动回滚只活在单测里，
// 线上永远不会触发。所以这里从 HTTP 打进去，证明巡检真的挂在看板上。
describe('FLM 看板巡检触发自动回滚（AC-F5.4）', () => {
  const DAY = 24 * 60 * 60 * 1000;

  test('当前窗口成功率暴跌 + 存在灰度版本 → 看板拉取即回滚', async () => {
    const now = Date.now();
    const db = getDb();
    insertStrategy({
      version_id: 'strat_canary_console', strategy_type: 'prompt', name: '巡检用灰度版本',
      content: JSON.stringify({ systemPrompt: 'v-canary' }), parent_version: null,
      trigger_source: 'manual', attribution_tag: 'execution', eval_report: null,
      gate_status: 'passed', gray_ratio: 20, status: 'canary', requires_human_review: 0,
      reviewed_by: null, publisher: null, publish_time: now - 60_000,
      created_at: now - 120_000, updated_at: now - 120_000,
    });

    // 基线窗口 [now-7d, now-3.5d) 全成功；当前窗口 [now-3.5d, now) 全失败。
    db.prepare('DELETE FROM flm_evaluations').run();
    const put = (id: string, outcome: string, t: number) =>
      insertEvaluation({
        eval_id: id, task_id: `${TASK_OK}-${id}`, trace_id: null, session_id: null, chat_jid: CHAT,
        outcome, outcome_reason: null, process_score: 50, path_conformity: 1, step_count: 1,
        retry_count: 0, first_anomaly_step: null, duration_ms: 1000, quality_scores: '{}',
        attribution_stage: null, evidence_json: '[]', evaluator: 'rule',
        needs_review: 0, review_status: 'pending', review_note: null, eval_time: t,
      } as never);

    for (let i = 0; i < 4; i++) put(`base-${i}`, 'achieved', now - 6 * DAY + i * 1000);
    for (let i = 0; i < 4; i++) put(`cur-${i}`, 'failed', now - 1 * DAY + i * 1000);

    const res = await get('/api/flm/admin/overview?days=7');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rollbacks: Array<{ fromVersion: string | null; reason: string }>;
      metrics: { successRate: number };
    };

    expect(body.rollbacks.length).toBeGreaterThan(0);
    expect(body.rollbacks[0].fromVersion).toBe('strat_canary_console');
    // 回滚后状态必须是 rolled_back，否则"回滚"只是返回了个消息。
    const after = getDb().prepare('SELECT status FROM flm_strategies WHERE version_id = ?')
      .get('strat_canary_console') as { status: string };
    expect(after.status).toBe('rolled_back');

    db.prepare('DELETE FROM flm_evaluations').run();
    db.prepare('DELETE FROM flm_strategies WHERE version_id = ?').run('strat_canary_console');
    seed();
  });
});
