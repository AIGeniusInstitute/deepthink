// Agent Runtime Monitor — 统一运行视图的查询层。
//
// 这个模块存在的意义是把平台里 8 条互不相通的运行记录链路归一成一个视图。
// 用例按"一个来源一条断言 + 跨来源聚合一条断言"组织：这样任何一条链路被改坏
// （表改名、状态词表变化、时间列换成 epoch）都会有一条具名的用例红掉，
// 而不是所有用例一起红。
//
// 夹具直接写库（而非走各来源的写入函数）：本模块是**读侧**归一化，用真表真数据
// 才能证明确实读得通；走写入函数会把测试变成写入侧的镜像，读侧改坏了它也照样绿。

import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-monitor-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const { initDatabase, getDb } = await import('../src/db.js');
const { listRuns, getRunDetail, getOverview, parseRunId } = await import(
  '../src/runtime-monitor/queries.js'
);
const { buildUnionSubquery, SOURCES } = await import('../src/runtime-monitor/sources.js');
const { RUN_SOURCES, STALE_AFTER_MS } = await import('../src/runtime-monitor/types.js');

/** 固定"现在"，让 stale 判定与时间窗口可复现（不给 now 的话查询会读系统时钟）。 */
const NOW = '2026-10-13T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const AGO = (ms: number) => new Date(NOW_MS - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * 「admin 视角」= 不限制可见范围。
 *
 * 必须**显式**写 `allowedWorkspaces: null`：该字段是 fail-closed 的，省略它等于
 * 「什么都看不到」而不是「看全部」（见 RunFilter.allowedWorkspaces 的说明）。
 * 用例里统一展开这个常量，免得每条断言都要重复一遍。
 */
const ALL = { now: NOW, allowedWorkspaces: null };

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

function seed(): void {
  const db = getDb();

  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
     VALUES ('u1', 'admin', 'x', '管理员', 'admin', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
     VALUES ('u2', 'alice', 'x', 'Alice', 'member', ?, ?)`,
  ).run(NOW, NOW);

  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, added_at, is_home)
     VALUES ('web:main', '主工作区', 'main', ?, 1)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, added_at, is_home)
     VALUES ('web:alice', 'Alice 工作区', 'home-u2', ?, 1)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO chats (jid, name, last_message_time) VALUES ('web:main', '主对话', ?)`,
  ).run(NOW);

  // ---- chat：两个 turn 根 + 一个子节点；#2 是长时间 running 的卡住样本 ----
  const chatNode = db.prepare(
    `INSERT INTO chat_trace_nodes
       (id, chat_jid, parent_node_id, node_type, title, tokens, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  chatNode.run(1, 'web:main', null, 'turn', '写一篇论文', 1000, 'done', AGO(2 * HOUR), AGO(2 * HOUR - 30 * MIN));
  chatNode.run(2, 'web:main', null, 'turn', '卡住的对话', 0, 'running', AGO(3 * HOUR), null);
  chatNode.run(3, 'web:main', 1, 'tool', 'web_search', 0, 'done', AGO(2 * HOUR - MIN), AGO(2 * HOUR - 30 * MIN + 10_000));
  chatNode.run(4, 'web:alice', null, 'turn', 'Alice 的失败对话', 500, 'failed', AGO(5 * HOUR), AGO(5 * HOUR - MIN));

  // 原始工具 I/O：turn#1 时间窗内的一条
  db.prepare(
    `INSERT INTO trace_tool_calls (chat_jid, tool_use_id, tool_name, input_json, output_json, status, started_at, ended_at)
     VALUES ('web:main', 'tu_1', 'web_search', '{"q":"AGI"}', 'ok', 'done', ?, ?)`,
  ).run(AGO(2 * HOUR - MIN), AGO(2 * HOUR - MIN + 5_000));

  // ---- graph：一条 completed（含两个 node run）----
  db.prepare(
    `INSERT INTO graph_definitions (id, version, name, nodes_json, edges_json, manifest_hash, created_at)
     VALUES ('def-1', 1, '示例图', '[]', '[]', 'h', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO graph_runs
       (id, definition_id, definition_version, owner_user_id, group_folder, chat_jid,
        goal_text, status, total_input_tokens, total_output_tokens, total_cost_usd, started_at, ended_at)
     VALUES ('graph-1', 'def-1', 1, 'u1', 'main', 'web:main', '图运行目标', 'completed', 200, 300, 0.5, ?, ?)`,
  ).run(AGO(4 * HOUR), AGO(4 * HOUR - 10 * MIN));
  const graphNode = db.prepare(
    `INSERT INTO graph_node_runs
       (id, graph_run_id, node_id, node_type, status, input_tokens, output_tokens, started_at, ended_at)
     VALUES (?, 'graph-1', ?, ?, ?, ?, ?, ?, ?)`,
  );
  graphNode.run('gn-1', 'n1', 'agent', 'completed', 100, 150, AGO(4 * HOUR), AGO(4 * HOUR - 6 * MIN));
  graphNode.run('gn-2', 'n2', 'agent', 'completed', 100, 150, AGO(4 * HOUR - 6 * MIN), AGO(4 * HOUR - 10 * MIN));

  // ---- open-platform：一条长时间 running（v72 新表）----
  // Agent 定义也要落一行：AaaS 没有工作区，页面上它靠 Agent 名标识（见下方
  // 「开放平台按 Agent 而不是哨兵分组」两条用例）。
  db.prepare(
    `INSERT INTO agent_definitions (id, user_id, name, system_prompt, created_at, updated_at)
     VALUES ('agent-1', 'u1', '周报助手', '', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO open_platform_runs
       (id, agent_id, user_id, key_id, channel, model, status, started_at, trace_id, request_summary)
     VALUES ('opr-1', 'agent-1', 'u1', 'key-1', 'api', 'claude-x', 'running', ?, 'opr-1', '拿一份周报')`,
  ).run(AGO(2 * HOUR));
  db.prepare(
    `INSERT INTO trace_steps (trace_id, span_id, node_type, title, status, started_at, ended_at, tokens)
     VALUES ('opr-1', 's1', 'turn', 'AaaS · api', 'done', ?, ?, 42)`,
  ).run(AGO(2 * HOUR), AGO(2 * HOUR - MIN));

  // ---- loop：一条 cancelled ----
  db.prepare(
    `INSERT INTO loop_runs
       (id, owner_user_id, group_folder, chat_jid, kind, goal_text, status,
        total_input_tokens, total_output_tokens, total_cost_usd, started_at, ended_at, cancel_reason)
     VALUES ('loop-1', 'u1', 'main', 'web:main', 'goal', 'Loop 目标', 'cancelled', 10, 20, 0.01, ?, ?, '用户取消')`,
  ).run(AGO(6 * HOUR), AGO(6 * HOUR - 2 * MIN));

  // ---- supervisor：长驻会话，长时间 running 但**不应**被判为卡住 ----
  db.prepare(
    `INSERT INTO supervisor_sessions
       (id, group_folder, chat_jid, owner_user_id, goal_text, success_criteria,
        status, started_at, created_at)
     VALUES ('sup-1', 'main', 'web:main', 'u1', '监督目标', '通过全部用例', 'active', ?, ?)`,
  ).run(AGO(30 * HOUR), AGO(30 * HOUR));

  // ---- task：一条成功日志 ----
  db.prepare(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, created_at, created_by)
     VALUES ('task-1', 'main', 'web:main', '每天汇总日报', 'cron', '0 9 * * *', ?, 'u1')`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result)
     VALUES ('task-1', ?, 1200, 'success', 'ok')`,
  ).run(AGO(7 * HOUR));

  // ---- sandbox：created_at 是 epoch 毫秒（唯一一个非 ISO 的时间列）----
  const sandboxAt = NOW_MS - 8 * HOUR;
  db.prepare(
    `INSERT INTO sandbox_sessions (id, user_id, container_name, language, status, created_at, last_active_at)
     VALUES ('sess-1', 'u2', 'sbx', 'python', 'active', ?, ?)`,
  ).run(sandboxAt, sandboxAt);
  db.prepare(
    `INSERT INTO sandbox_executions (id, session_id, user_id, language, code_hash, status, exit_code, duration_ms, created_at)
     VALUES ('sbx-1', 'sess-1', 'u2', 'python', 'h', 'success', 0, 2000, ?)`,
  ).run(sandboxAt);

  // ---- harness-eval：需要 harness_versions 外键 ----
  db.prepare(
    `INSERT INTO harness_versions (id, hash, manifest_json, status, created_at)
     VALUES ('hv-1', 'h', '{}', 'experimental', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO harness_eval_runs (id, version_id, case_id, status, pass, started_at, finished_at)
     VALUES ('her-1', 'hv-1', 'case-1', 'completed', 1, ?, ?)`,
  ).run(AGO(9 * HOUR), AGO(9 * HOUR - 30_000));
}

beforeAll(() => {
  initDatabase();
  seed();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('来源注册表', () => {
  test('每个声明的来源都真的拼进 UNION，且列数一致', () => {
    const union = buildUnionSubquery();
    for (const key of RUN_SOURCES) {
      expect(SOURCES[key], `缺少来源声明: ${key}`).toBeDefined();
      expect(union).toContain(`'${key}' AS source`);
    }
    // 8 个分支、7 个 UNION ALL
    expect(union.split('UNION ALL')).toHaveLength(8);
  });

  test('来源筛选在分支级下推 —— 只拼选中的来源', () => {
    const union = buildUnionSubquery(['graph']);
    expect(union).toContain("'graph' AS source");
    expect(union).not.toContain("'chat' AS source");
  });
});

describe('RUN_SOURCES 与 SOURCES 保持同步', () => {
  test('两个清单的 key 集合完全相同', () => {
    expect(new Set(Object.keys(SOURCES))).toEqual(new Set(RUN_SOURCES));
  });

  // `GET /api/runtime-monitor/sources` 会把这些 label 直接吐给前端当筛选 chip 的文字，
  // 空 label 会让 chip 变成一个点不动的空白按钮，重名则让用户分不清点的是哪个。
  test('每个来源都有非空且互不相同的展示名', () => {
    const labels = RUN_SOURCES.map((key) => SOURCES[key].label);
    for (const [i, l] of labels.entries()) {
      expect(l, `来源 ${RUN_SOURCES[i]} 的 label 为空`).toBeTruthy();
      expect(l.trim()).toBe(l);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('统一运行列表', () => {
  test('八个来源的运行都出现在同一个列表里', () => {
    const page = listRuns({ ...ALL }, 100, 0);
    const sources = new Set(page.runs.map((r) => r.source));
    for (const key of RUN_SOURCES) {
      expect(sources, `来源 ${key} 没有出现在统一列表里`).toContain(key);
    }
  });

  test('runId 是 `{source}:{nativeId}`，chat 的 nativeId 保留了 jid 里的冒号', () => {
    const page = listRuns({ ...ALL, sources: ['chat'] }, 100, 0);
    const ids = page.runs.map((r) => r.runId).sort();
    expect(ids).toEqual(['chat:web:alice#4', 'chat:web:main#1', 'chat:web:main#2']);
    // 反解必须能拿回 jid 与节点号（`web:main#1` 本身含冒号）
    expect(parseRunId('chat:web:main#1')).toEqual({ source: 'chat', nativeId: 'web:main#1' });
  });

  test('**只取 turn 根节点** —— 子节点不是一次独立运行', () => {
    const page = listRuns({ ...ALL, sources: ['chat'] }, 100, 0);
    // 夹具里有 4 条 chat_trace_nodes，其中 1 条是 turn#1 的子节点
    expect(page.total).toBe(3);
    expect(page.runs.every((r) => !r.runId.endsWith('#3'))).toBe(true);
  });

  test('按 started_at 倒序', () => {
    const page = listRuns({ ...ALL }, 100, 0);
    const times = page.runs.map((r) => Date.parse(r.startedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test('limit / offset 分页，total 是过滤后的总数而不是本页条数', () => {
    const all = listRuns({ ...ALL }, 100, 0);
    const first = listRuns({ ...ALL }, 3, 0);
    const second = listRuns({ ...ALL }, 3, 3);
    expect(first.runs).toHaveLength(3);
    expect(first.total).toBe(all.total);
    expect(second.total).toBe(all.total);
    expect(first.runs.map((r) => r.runId)).not.toEqual(second.runs.map((r) => r.runId));
  });
});

describe('状态归一化', () => {
  const byId = (id: string) => {
    const page = listRuns({ ...ALL }, 200, 0);
    const run = page.runs.find((r) => r.runId === id);
    expect(run, `找不到运行 ${id}`).toBeDefined();
    return run!;
  };

  test('chat done → success，raw_status 保留原值', () => {
    const r = byId('chat:web:main#1');
    expect(r.status).toBe('success');
    expect(r.rawStatus).toBe('done');
  });

  test('chat failed → failed', () => {
    expect(byId('chat:web:alice#4').status).toBe('failed');
  });

  test('graph completed → success', () => {
    const r = byId('graph:graph-1');
    expect(r.status).toBe('success');
    expect(r.rawStatus).toBe('completed');
  });

  test('loop cancelled → cancelled（不是 failed）', () => {
    const r = byId('loop:loop-1');
    expect(r.status).toBe('cancelled');
    expect(r.rawStatus).toBe('cancelled');
  });

  test('supervisor active → running', () => {
    expect(byId('supervisor:sup-1').status).toBe('running');
  });

  test('open-platform running → running', () => {
    expect(byId('open-platform:opr-1').status).toBe('running');
  });

  test('sandbox success → success；harness-eval completed → success', () => {
    expect(byId('sandbox:sbx-1').status).toBe('success');
    expect(byId('harness-eval:her-1').status).toBe('success');
  });

  test('task success → success', () => {
    expect(byId('task:1').status).toBe('success');
  });
});

describe('疑似卡住（stale）', () => {
  const byId = (id: string) => listRuns({ ...ALL }, 200, 0).runs.find((r) => r.runId === id)!;

  test('长时间 running 的对话运行被判为卡住', () => {
    const r = byId('chat:web:main#2');
    expect(r.status).toBe('running');
    expect(r.stale).toBe(true);
  });

  test('**监督者不参与卡住判定** —— 它是设计上的长驻会话', () => {
    const r = byId('supervisor:sup-1');
    expect(r.status).toBe('running');
    expect(r.stale).toBe(false);
  });

  test('已结束的运行永远不是卡住（哪怕耗时超过阈值）', () => {
    expect(byId('graph:graph-1').stale).toBe(false);
  });

  test('staleOnly 过滤只留卡住的，且排除不参与判定的来源', () => {
    const page = listRuns({ ...ALL, staleOnly: true }, 100, 0);
    const ids = page.runs.map((r) => r.runId).sort();
    // chat#2（3 小时前）与 open-platform opr-1（2 小时前）都是卡住的
    expect(ids).toEqual(['chat:web:main#2', 'open-platform:opr-1']);
    expect(ids).not.toContain('supervisor:sup-1');
  });

  test('阈值边界：刚好 STALE_AFTER_MS 之内不算卡住，超过才算', () => {
    // 靠调整 `now` 而不是插新行来测边界：插入会把行永久留在库里，污染后面
    // 依赖精确计数的用例（第一版就是这么写的，结果 4 条用例连带变红）。
    const startedAt = Date.parse(byId('chat:web:main#2').startedAt);
    const at = (now: string) =>
      listRuns({ ...ALL, now, sources: ['chat'] }, 100, 0).runs.find(
        (r) => r.runId === 'chat:web:main#2',
      )!;
    expect(at(new Date(startedAt + STALE_AFTER_MS - MIN).toISOString()).stale).toBe(false);
    expect(at(new Date(startedAt + STALE_AFTER_MS + MIN).toISOString()).stale).toBe(true);
  });
});

describe('筛选', () => {
  test('来源筛选', () => {
    const page = listRuns({ ...ALL, sources: ['graph', 'loop'] }, 100, 0);
    expect(page.runs.length).toBeGreaterThan(0);
    expect(new Set(page.runs.map((r) => r.source))).toEqual(new Set(['graph', 'loop']));
  });

  test('状态筛选（按归一化后的状态）', () => {
    const page = listRuns({ ...ALL, statuses: ['success'] }, 100, 0);
    expect(page.runs.length).toBeGreaterThan(0);
    expect(page.runs.every((r) => r.status === 'success')).toBe(true);
  });

  test('时间窗口 from 生效', () => {
    // 夹具里对话运行最早也在 2 小时前，最近 1 小时内一条都没有
    expect(listRuns({ ...ALL, sources: ['chat'], from: AGO(HOUR) }, 100, 0).total).toBe(0);
    expect(listRuns({ ...ALL, sources: ['chat'], from: AGO(3 * HOUR) }, 100, 0).total).toBeGreaterThan(0);
  });

  test('关键词在 title 上匹配', () => {
    const page = listRuns({ ...ALL, q: '论文' }, 100, 0);
    expect(page.runs.map((r) => r.runId)).toEqual(['chat:web:main#1']);
  });

  test('关键词在工作区上匹配', () => {
    const page = listRuns({ ...ALL, q: 'web:alice' }, 100, 0);
    expect(page.runs.map((r) => r.runId)).toEqual(['chat:web:alice#4']);
  });

  test('筛选组合是与关系', () => {
    const page = listRuns({ ...ALL, sources: ['chat'], statuses: ['failed'] }, 100, 0);
    expect(page.runs.map((r) => r.runId)).toEqual(['chat:web:alice#4']);
  });
});

describe('可见范围（非 admin 用户）', () => {
  test('工作区白名单生效：只能看到自己有权限的工作区', () => {
    const page = listRuns({ ...ALL, allowedWorkspaces: ['main'] }, 100, 0);
    expect(page.total).toBeGreaterThan(0);
    expect(page.runs.every((r) => r.workspace === 'main')).toBe(true);
  });

  test('白名单为空 + 有 viewerUserId：只放行自己名下的运行', () => {
    const page = listRuns({ ...ALL, allowedWorkspaces: [], viewerUserId: 'u1' }, 100, 0);
    const ids = page.runs.map((r) => r.runId);
    expect(ids.length).toBeGreaterThan(0);
    expect(page.runs.every((r) => r.ownerUserId === 'u1')).toBe(true);
    // 沙箱那条属于 u2，不该出现
    expect(ids).not.toContain('sandbox:sbx-1');
    expect(ids).toContain('open-platform:opr-1');
  });

  test('白名单为空且无 viewerUserId：什么也看不到（而不是看到全部）', () => {
    expect(listRuns({ ...ALL, allowedWorkspaces: [] }, 100, 0).total).toBe(0);
  });

  test('**fail-closed**：字段未指定（undefined）也按"什么都看不到"处理', () => {
    // 这条断言是刻意的设计约束，不是意外行为：授权过滤误放宽会静默泄露跨租户
    // 数据，误收紧只会让页面空白 —— 前者看不见，后者一眼就能发现。
    // 未来若把默认值改成"不限范围"，这条用例会红，提醒改动者重新权衡。
    expect(listRuns({ now: NOW }, 100, 0).total).toBe(0);
    expect(listRuns({ now: NOW }, 100, 0).runs).toEqual([]);
  });

  test('显式 null 才表示不限制', () => {
    expect(listRuns({ ...ALL }, 100, 0).total).toBeGreaterThan(0);
  });
});

describe('单次运行详情与轨迹', () => {
  test('chat：轨迹含 turn 根 + 子节点 + 时间窗内的原始工具 I/O', () => {
    const detail = getRunDetail('chat:web:main#1', { ...ALL });
    expect(detail).not.toBeNull();
    const types = detail!.trace.map((t) => t.nodeType);
    expect(types).toContain('turn');
    expect(types).toContain('tool');
    expect(types).toContain('tool_io');
    expect(detail!.run.runId).toBe('chat:web:main#1');
  });

  test('chat：卡住的运行（无 ended_at）轨迹仍然可读，不抛错', () => {
    const detail = getRunDetail('chat:web:main#2', { ...ALL });
    expect(detail).not.toBeNull();
    expect(detail!.trace.length).toBeGreaterThan(0);
  });

  test('graph：轨迹来自 graph_node_runs', () => {
    const detail = getRunDetail('graph:graph-1', { ...ALL });
    expect(detail!.trace.map((t) => t.spanId).sort()).toEqual(['gn-1', 'gn-2']);
  });

  test('open-platform：轨迹来自 trace_steps(trace_id = run_id)', () => {
    const detail = getRunDetail('open-platform:opr-1', { ...ALL });
    expect(detail!.trace.map((t) => t.spanId)).toEqual(['s1']);
  });

  test('task：没有分步轨迹，给出一条原子记录 + 说明文案', () => {
    const detail = getRunDetail('task:1', { ...ALL });
    expect(detail!.trace).toHaveLength(1);
    expect(detail!.traceNote).toBeTruthy();
  });

  test('不存在的运行 → null', () => {
    expect(getRunDetail('graph:no-such-run', { ...ALL })).toBeNull();
  });

  test('非法 runId → null（无冒号 / 未知来源），不抛错', () => {
    expect(parseRunId('nocolon')).toBeNull();
    expect(parseRunId(':leading')).toBeNull();
    expect(parseRunId('nosuchsource:abc')).toBeNull();
    expect(getRunDetail('nosuchsource:abc', { ...ALL })).toBeNull();
    expect(getRunDetail('nocolon', { ...ALL })).toBeNull();
  });

  test('详情同样受可见范围约束 —— 越权返回 null（路由层据此回 404）', () => {
    // 这条属于 web:main，给一个不包含它的白名单
    expect(getRunDetail('chat:web:main#1', { ...ALL, allowedWorkspaces: ['web:alice'] })).toBeNull();
    expect(getRunDetail('chat:web:main#1', { ...ALL, allowedWorkspaces: ['web:main'] })).not.toBeNull();
  });
});

describe('时间归一（跨来源可比）', () => {
  test('沙箱的 epoch 毫秒被换算成 ISO，能与其他来源一起排序', () => {
    const page = listRuns({ ...ALL, sources: ['sandbox'] }, 10, 0);
    const run = page.runs[0];
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // 夹具里 created_at = NOW - 8h
    expect(Date.parse(run.startedAt)).toBe(NOW_MS - 8 * HOUR);
    // ended_at = created_at + duration_ms
    expect(Date.parse(run.endedAt!)).toBe(NOW_MS - 8 * HOUR + 2000);
  });

  test('沙箱的耗时与其他来源口径一致（毫秒差）', () => {
    const run = listRuns({ ...ALL, sources: ['sandbox'] }, 10, 0).runs[0];
    expect(run.durationMs).toBe(2000);
  });
});

describe('总览（KPI / 分布 / 趋势）', () => {
  test('KPI 的总数与同时刻的列表 total 一致', () => {
    const overview = getOverview('all', { ...ALL });
    const page = listRuns({ ...ALL }, 200, 0);
    expect(overview.kpis.total).toBe(page.total);
  });

  test('KPI 的成功/失败/运行中与列表按状态数出来的一致', () => {
    const overview = getOverview('all', { ...ALL });
    const runs = listRuns({ ...ALL }, 200, 0).runs;
    const count = (s: string) => runs.filter((r) => r.status === s).length;
    expect(overview.kpis.running).toBe(count('running'));
    expect(overview.kpis.success).toBe(count('success'));
    expect(overview.kpis.failed).toBe(count('failed'));
  });

  test('疑似卡住数与本页 stale 标记数一致', () => {
    const overview = getOverview('all', { ...ALL });
    const runs = listRuns({ ...ALL }, 200, 0).runs;
    expect(overview.kpis.stale).toBe(runs.filter((r) => r.stale).length);
    expect(overview.kpis.stale).toBeGreaterThan(0);
  });

  test('成功率 = 成功 / (成功 + 失败)，未结束的运行不进分母', () => {
    const { kpis } = getOverview('all', { ...ALL });
    const concluded = kpis.success + kpis.failed;
    expect(kpis.successRate).toBeCloseTo(kpis.success / concluded, 6);
  });

  test('按来源分布：每个来源一行，total 之和等于总运行数', () => {
    const { bySource, kpis } = getOverview('all', { ...ALL });
    expect(bySource.length).toBeGreaterThan(0);
    expect(bySource.reduce((a, b) => a + b.total, 0)).toBe(kpis.total);
    for (const item of bySource) {
      expect(item.sourceLabel).toBeTruthy();
      expect(item.sourceLabel).not.toBe(item.source); // 必须是中文标签而不是原样回显
    }
  });

  test('按工作区分布带上可读名', () => {
    const { byWorkspace } = getOverview('all', { ...ALL });
    const main = byWorkspace.find((w) => w.workspace === 'main');
    expect(main?.workspaceLabel).toBe('主工作区');
  });

  test('**开放平台按 Agent 而不是哨兵分组** —— 否则多 Agent 全被压成一行', () => {
    const { byWorkspace } = getOverview('all', { ...ALL });
    // 分组键是 agent_id，标签是 Agent 名
    const aas = byWorkspace.find((w) => w.workspace === 'agent-1');
    expect(aas).toBeDefined();
    expect(aas!.workspaceLabel).toBe('周报助手');
    expect(aas!.total).toBe(1);
    // 常量哨兵不该作为分组键出现
    expect(byWorkspace.map((w) => w.workspace)).not.toContain('open-platform');
  });

  test('**分布与运行列表对同一条运行给出同一个名字** —— 否则页面上对不上账', () => {
    const { byWorkspace } = getOverview('all', { ...ALL });
    const { runs } = listRuns({ ...ALL, sources: ['open-platform'] }, 10, 0);
    expect(runs).toHaveLength(1);
    const fromList = runs[0].workspaceLabel;
    // 关联键是 agentId：AaaS 的分布键 = agent_id，而 RunSummary.workspace 仍是源表里的
    // 哨兵常量（`workspaceLabel` 才是给人看的那个名字）。
    const fromOverview = byWorkspace.find((w) => w.workspace === runs[0].agentId)?.workspaceLabel;
    expect(fromOverview).toBe(fromList);
    expect(fromOverview).toBe('周报助手');
  });

  test('已知取舍：Agent 定义被硬删后，历史运行的分布键回落成裸 agent_id', () => {
    // Agent 定义是硬删除（db.ts 的 deleteAgentDefinition 走 DELETE），历史运行会留下
    // 悬空 agent_id。这里**故意**锁定"显示裸 id"这一行为，而不是假装已优雅处理：
    // 裸 id 至少是真实归属、可排查；要换成来源名就得让后端认一种合成键格式，不划算。
    const db = getDb();
    db.prepare(
      `INSERT INTO open_platform_runs (id, agent_id, user_id, channel, model, status, started_at, trace_id)
       VALUES ('opr-orphan', 'agent-ghost', 'u1', 'api', 'm', 'completed', ?, 'opr-orphan')`,
    ).run(AGO(3 * HOUR));
    try {
      const { byWorkspace } = getOverview('all', { ...ALL });
      const orphan = byWorkspace.find((w) => w.workspace === 'agent-ghost');
      expect(orphan).toBeDefined();
      expect(orphan!.workspaceLabel).toBe('agent-ghost');
    } finally {
      db.prepare(`DELETE FROM open_platform_runs WHERE id = 'opr-orphan'`).run();
    }
  });

  test('趋势桶 key 连续，相邻桶相差恰好一天', () => {
    const { trend, trendBucket } = getOverview('all', { ...ALL });
    expect(trendBucket).toBe('day');
    expect(trend.length).toBeGreaterThan(1);
    for (let i = 1; i < trend.length; i++) {
      const prev = Date.parse(`${trend[i - 1].bucket}T00:00:00.000Z`);
      const cur = Date.parse(`${trend[i].bucket}T00:00:00.000Z`);
      expect(cur - prev).toBe(24 * 3600 * 1000);
    }
  });

  test('**空桶补 0** —— 否则趋势图会把两段安静期画成相邻的柱子', () => {
    // 临时插一条 5 天前的运行制造空档，用完即删，避免污染其它用例的精确计数
    const db = getDb();
    const gapAt = new Date(NOW_MS - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO loop_runs (id, owner_user_id, group_folder, chat_jid, kind, goal_text, status, started_at)
       VALUES ('loop-gap', 'u1', 'main', 'web:main', 'goal', '五天前的运行', 'completed', ?)`,
    ).run(gapAt);
    try {
      const { trend } = getOverview('all', { ...ALL });
      const empty = trend.filter((b) => b.total === 0);
      expect(empty.length).toBeGreaterThan(0);
      // 空桶确实是中间那几天，且都在首尾之间
      const days = trend.map((b) => b.bucket);
      expect(days[0]).toBe('2026-10-08');
      expect(days[days.length - 1]).toBe('2026-10-13');
      expect(empty.map((b) => b.bucket)).not.toContain('2026-10-08');
    } finally {
      db.prepare(`DELETE FROM loop_runs WHERE id = 'loop-gap'`).run();
    }
  });

  test('趋势桶的 total 之和等于总运行数', () => {
    const { trend, kpis } = getOverview('all', { ...ALL });
    expect(trend.reduce((a, b) => a + b.total, 0)).toBe(kpis.total);
  });

  test('窗口 1h 内没有运行 → 各项归零，不抛错', () => {
    const overview = getOverview('1h', { ...ALL });
    expect(overview.kpis.total).toBe(0);
    expect(overview.bySource).toEqual([]);
    expect(overview.kpis.successRate).toBeNull();
    expect(overview.kpis.p95DurationMs).toBeNull();
  });

  test('P95 只看已结束的终态运行（未收尾的混进来会把 P95 拉爆）', () => {
    const overview = getOverview('all', { ...ALL });
    // 夹具里最长的一条是 30 小时的监督者会话（仍在 running），
    // 它没有 ended_at，绝不该进入时长样本
    expect(overview.kpis.p95DurationMs).not.toBeNull();
    expect(overview.kpis.p95DurationMs!).toBeLessThan(30 * 3600 * 1000);
    expect(overview.kpis.durationSampleSize).toBeGreaterThan(0);
  });

  test('总览同样受可见范围约束（fail-closed）', () => {
    expect(getOverview('all', { now: NOW }).kpis.total).toBe(0);
    const scoped = getOverview('all', { ...ALL, allowedWorkspaces: ['web:main'] });
    expect(scoped.kpis.total).toBeGreaterThan(0);
    expect(scoped.kpis.total).toBeLessThan(getOverview('all', { ...ALL }).kpis.total);
  });
});

describe('可读名补全', () => {
  test('chat 的 workspaceLabel 用群组名', () => {
    const run = listRuns({ ...ALL, sources: ['chat'] }, 10, 0).runs.find((r) => r.workspace === 'web:main')!;
    expect(run.workspaceLabel).toBe('主工作区');
  });

  test('归属用户解析成用户名', () => {
    const run = listRuns({ ...ALL, sources: ['open-platform'] }, 10, 0).runs[0];
    expect(run.ownerUserId).toBe('u1');
    expect(run.ownerUsername).toBe('admin');
  });

  test('开放平台没有工作区 → 不显示常量 open-platform 占位', () => {
    const run = listRuns({ ...ALL, sources: ['open-platform'] }, 10, 0).runs[0];
    expect(run.workspaceLabel).not.toBe('open-platform');
  });
});
