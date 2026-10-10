// FLM 学习与自进化层单测（PRD F4）。
// 覆盖 AC-F4.1 ~ AC-F4.7 与 TC-FLM-16 ~ TC-FLM-20。
// 需要数据库（案例/策略/知识条目要落库），用临时目录隔离。

import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-learn-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDir,
}));

const { initDatabase } = await import('../../src/db.js');
const { DEFAULT_CONFIG } = await import('../../src/flm/flm-config.js');
const {
  planCorrection,
  executeCorrection,
  embed,
  cosine,
  lexicalOverlap,
  searchCases,
  buildCaseFromEvaluation,
  persistCases,
  suggestStrategies,
  materializeStrategy,
  persistStrategy,
  buildDataFeedback,
  toJsonl,
  buildKnowledgeCandidates,
  persistKnowledgeCandidates,
  learnFromEvaluations,
} = await import('../../src/flm/flm-learn.js');
const { listKnowledge, reviewKnowledge, insertEventIfNew, allCases } = await import('../../src/flm/flm-db.js');

type EvalRow = Parameters<typeof planCorrection>[0];

function evalRow(over: Partial<EvalRow> = {}): EvalRow {
  return {
    eval_id: 'ev-1',
    outcome: 'failed',
    attribution_stage: 'execution',
    duration_ms: 10_000,
    step_count: 10,
    ...over,
  } as EvalRow;
}

beforeAll(() => {
  initDatabase();
});

// ── F4.1 / F4.2 短期纠偏 ─────────────────────────────────────────────

describe('FLM F4 · 短期纠偏（AC-F4.1、AC-F4.2、TC-FLM-16）', () => {
  test('可重试环节在预算内生成重试计划', () => {
    const plan = planCorrection(evalRow(), DEFAULT_CONFIG);
    expect(plan.shouldRetry).toBe(true);
    expect(plan.maxRetries).toBeGreaterThanOrEqual(1);
    expect(plan.escalateToHuman).toBe(false);
  });

  test('重试次数不超过配置上限', () => {
    const plan = planCorrection(evalRow({ duration_ms: 1_000_000, step_count: 1000 }), DEFAULT_CONFIG);
    expect(plan.maxRetries).toBeLessThanOrEqual(DEFAULT_CONFIG.retryPolicy.maxRetries);
  });

  test('预计耗时不超过原任务 2 倍（AC-F4.2 硬闸门）', () => {
    const plan = planCorrection(evalRow(), DEFAULT_CONFIG);
    expect(plan.projectedMs).toBeLessThanOrEqual(plan.originalMs * DEFAULT_CONFIG.retryPolicy.maxDurationRatio);
  });

  test('短任务预算不足 → 不重试、降级人工', () => {
    // 单步 600ms、总 600ms，预算 600ms，一次重试加退避就超限。
    const plan = planCorrection(evalRow({ duration_ms: 600, step_count: 1 }), DEFAULT_CONFIG);
    expect(plan.shouldRetry).toBe(false);
    expect(plan.escalateToHuman).toBe(true);
    expect(plan.maxRetries).toBe(0);
    expect(plan.reason).toContain('超出');
  });

  test('不可重试环节（意图理解）直接降级人工', () => {
    const plan = planCorrection(evalRow({ attribution_stage: 'intent' }), DEFAULT_CONFIG);
    expect(plan.shouldRetry).toBe(false);
    expect(plan.escalateToHuman).toBe(true);
    expect(plan.reason).toContain('转人工');
  });

  test('规划环节同样不重试', () => {
    expect(planCorrection(evalRow({ attribution_stage: 'planning' }), DEFAULT_CONFIG).shouldRetry).toBe(false);
  });

  test('已达成任务无需纠偏', () => {
    const plan = planCorrection(evalRow({ outcome: 'achieved' }), DEFAULT_CONFIG);
    expect(plan.shouldRetry).toBe(false);
    expect(plan.reason).toContain('无需纠偏');
  });

  test('未定位归因环节 → 无法定向纠偏', () => {
    const plan = planCorrection(evalRow({ attribution_stage: null }), DEFAULT_CONFIG);
    expect(plan.shouldRetry).toBe(false);
    expect(plan.reason).toContain('未定位');
  });

  test('执行纠偏：首次成功即停止，不计满重试', async () => {
    const plan = planCorrection(evalRow(), DEFAULT_CONFIG);
    let calls = 0;
    const out = await executeCorrection(plan, async () => { calls++; return true; }, { sleep: async () => {} });
    expect(out.succeeded).toBe(true);
    expect(out.attempted).toBe(1);
    expect(calls).toBe(1);
    expect(out.escalated).toBe(false);
  });

  test('执行纠偏：全部失败 → 降级人工并留痕', async () => {
    const plan = planCorrection(evalRow(), DEFAULT_CONFIG);
    const out = await executeCorrection(plan, async () => false, { sleep: async () => {} });
    expect(out.succeeded).toBe(false);
    expect(out.escalated).toBe(true);
    expect(out.attempted).toBe(plan.maxRetries);
    expect(out.detail).toContain('人工');
  });

  test('执行纠偏：attempt 抛异常不提前放弃，用满额度', async () => {
    const plan = planCorrection(evalRow(), DEFAULT_CONFIG);
    const out = await executeCorrection(plan, async () => { throw new Error('boom'); }, { sleep: async () => {} });
    expect(out.attempted).toBe(plan.maxRetries);
    expect(out.escalated).toBe(true);
  });

  test('不可重试的计划不执行任何 attempt', async () => {
    const plan = planCorrection(evalRow({ attribution_stage: 'intent' }), DEFAULT_CONFIG);
    let calls = 0;
    await executeCorrection(plan, async () => { calls++; return true; }, { sleep: async () => {} });
    expect(calls).toBe(0);
  });
});

// ── F4.3 / F4.4 经验记忆与检索 ───────────────────────────────────────

describe('FLM F4 · 嵌入与相似度', () => {
  test('嵌入确定性：同文本同向量', () => {
    expect(embed('修复登录接口的超时问题')).toEqual(embed('修复登录接口的超时问题'));
  });

  test('嵌入为 256 维且 L2 归一化', () => {
    const v = embed('一些中文文本');
    expect(v.length).toBe(256);
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  test('空文本返回零向量而不崩', () => {
    const v = embed('');
    expect(v.every((x) => x === 0)).toBe(true);
  });

  test('相同文本余弦相似度为 1', () => {
    expect(cosine(embed('abc'), embed('abc'))).toBeCloseTo(1, 6);
  });

  test('无关文本相似度低于相关文本', () => {
    const q = embed('数据库连接超时');
    const near = cosine(q, embed('数据库连接超时问题排查'));
    const far = cosine(q, embed('今天天气不错适合出门散步'));
    expect(near).toBeGreaterThan(far);
  });

  test('关键词重叠：完全一致为 1，无交集为 0', () => {
    expect(lexicalOverlap('部署流程', '部署流程')).toBeCloseTo(1, 6);
    expect(lexicalOverlap('abc', 'xyz')).toBe(0);
  });
});

describe('FLM F4 · 案例库与检索（AC-F4.3、AC-F4.4、TC-FLM-17）', () => {
  test('成功轨迹入 positive、失败入 negative', () => {
    const p = buildCaseFromEvaluation(
      { eval_id: 'e1', task_id: 't1', outcome: 'achieved', attribution_stage: null } as never,
      { goal: '写一份周报', summary: '完成' },
    );
    const n = buildCaseFromEvaluation(
      { eval_id: 'e2', task_id: 't2', outcome: 'failed', attribution_stage: 'execution' } as never,
      { goal: '写一份周报', summary: '超时' },
    );
    expect(p.sample_type).toBe('positive');
    expect(n.sample_type).toBe('negative');
  });

  test('部分达成归入 negative（不是 positive）', () => {
    const c = buildCaseFromEvaluation(
      { eval_id: 'e3', task_id: 't3', outcome: 'partial', attribution_stage: 'summary' } as never,
      { goal: 'x', summary: null },
    );
    expect(c.sample_type).toBe('negative');
  });

  test('案例落库后可按目标检索出 Top-K', () => {
    persistCases([
      buildCaseFromEvaluation({ eval_id: 'x1', task_id: 'T-部署', outcome: 'achieved', attribution_stage: null } as never, {
        goal: '把服务部署到生产环境并验证健康检查',
        summary: '部署成功',
      }),
      buildCaseFromEvaluation({ eval_id: 'x2', task_id: 'T-报表', outcome: 'failed', attribution_stage: 'execution' } as never, {
        goal: '生成季度财务报表并导出为 PDF',
        summary: '导出超时',
      }),
    ]);

    const { indexMode, hits } = searchCases('把服务部署到生产环境', 5);
    expect(indexMode).toBe('embedding');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].goal).toContain('部署');
    expect(hits[0].similarity).toBeGreaterThan(0);
  });

  test('检索结果按相似度降序', () => {
    const { hits } = searchCases('部署服务', 10);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].similarity).toBeGreaterThanOrEqual(hits[i].similarity);
    }
  });

  test('Top-K 生效：请求 1 条只返回 1 条', () => {
    expect(searchCases('部署', 1).hits.length).toBeLessThanOrEqual(1);
  });

  test('空查询不崩', () => {
    expect(searchCases('', 5).hits.length).toBe(0);
  });

  test('案例库为空时返回 keyword 模式与空结果', () => {
    const r = searchCases('任意', 5);
    expect(Array.isArray(r.hits)).toBe(true);
  });

  test('AC-F4.4：标注命中集合 Top-5 命中率 ≥ 80%', () => {
    // 标注集：8 个目标，每个用其真实目标串（含轻微改写）做查询，标注应命中的案例。
    const labeled: Array<{ goal: string; query: string }> = [
      { goal: '修复用户登录接口的 500 错误并补充回归测试', query: '修复用户登录接口的 500 错误' },
      { goal: '把订单服务部署到预发环境并跑一遍冒烟测试', query: '订单服务部署到预发环境' },
      { goal: '分析上周的接口错误日志并输出归因报告', query: '分析接口错误日志输出归因报告' },
      { goal: '给支付模块补充单元测试覆盖退款分支', query: '支付模块补充单元测试' },
      { goal: '排查数据库连接池耗尽的根因', query: '排查数据库连接池耗尽' },
      { goal: '重构消息队列消费者以支持并发处理', query: '重构消息队列消费者' },
      { goal: '为管理系统新增按角色划分的权限配置页', query: '新增按角色划分的权限配置页' },
      { goal: '优化大报表导出的内存占用', query: '优化大报表导出的内存占用问题' },
    ];
    persistCases(
      labeled.map((l, i) =>
        buildCaseFromEvaluation(
          { eval_id: `lab-${i}`, task_id: `task-${i}`, outcome: 'achieved', attribution_stage: null } as never,
          { goal: l.goal, summary: `案例 ${i}` },
        ),
      ),
    );

    let hitsCount = 0;
    for (const l of labeled) {
      const { hits } = searchCases(l.query, 5);
      if (hits.some((h) => h.goal === l.goal)) hitsCount++;
    }
    const rate = hitsCount / labeled.length;
    // 如实测量并断言：不足 80% 就是没达标，不允许放水。
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });

  test('Top-K 不返回同一目标的拷贝（回归，2026-10-10）', () => {
    // 案例是评价的派生物：同一目标被反复评价就会沉淀出多条内容相同的案例。
    // 实盘 137 条案例只对应 12 个不同目标，Top-5 曾返回 5 条一模一样的命中 ——
    // 那时 5 个坑位被同一条占满，AC-F4.4 的「Top5 命中率」根本无从度量。
    const goal = '把结算服务灰度发布到生产环境';
    persistCases(
      Array.from({ length: 5 }, (_, i) =>
        buildCaseFromEvaluation(
          { eval_id: `dupsed-${i}`, task_id: 'T-grayscale', outcome: 'achieved', attribution_stage: null } as never,
          { goal, summary: `第 ${i} 次沉淀` },
        ),
      ),
    );

    const { hits } = searchCases(goal, 5);
    // 同一条案例只允许出现一次
    expect(hits.filter((h) => h.goal === goal).length).toBe(1);
    // 且它仍应是相似度最高的那条（去重保优，不是随意丢弃）
    expect(hits[0].goal).toBe(goal);
    expect(hits[0].similarity).toBeGreaterThan(0.9);
  });

  test('同一评价重复沉淀不产生重复案例（幂等，回归 2026-10-10）', () => {
    const goal = '为审计日志新增按操作人检索';
    const goals = new Map([['T-idem', { goal, summary: '已完成' }]]);
    const evals = [
      { eval_id: 'idem-1', task_id: 'T-idem', outcome: 'achieved', attribution_stage: null },
      { eval_id: 'idem-2', task_id: 'T-idem', outcome: 'failed', attribution_stage: 'execution' },
    ] as never[];

    const first = learnFromEvaluations(evals, goals);
    expect(first.cases).toBe(2); // 两条评价各沉淀一条
    const second = learnFromEvaluations(evals, goals);
    expect(second.cases).toBe(0); // 原样再跑一次：一条都不新增

    // 库里该目标恰好 2 条（每条评价一条），而不是 4 条
    expect(allCases().filter((c) => c.goal === goal).length).toBe(2);
  });
});

// ── F4.5 策略建议 ────────────────────────────────────────────────────

describe('FLM F4 · 策略建议（AC-F4.5、TC-FLM-18）', () => {
  const failed = (stage: string): EvalRow => ({ eval_id: `e-${stage}`, outcome: 'failed', attribution_stage: stage } as EvalRow);

  test('从归因分布产出对应策略类型', () => {
    const s = suggestStrategies([
      failed('execution'), failed('execution'), failed('execution'),
      failed('tool_selection'), failed('param_gen'),
    ] as never);
    const exec = s.find((x) => x.attributionTag === 'execution');
    expect(exec?.strategyType).toBe('param');
    expect(s.find((x) => x.attributionTag === 'tool_selection')?.strategyType).toBe('routing');
  });

  test('建议按失败占比降序', () => {
    const s = suggestStrategies([
      failed('execution'), failed('execution'), failed('execution'),
      failed('intent'), failed('planning'), failed('summary'), failed('param_gen'),
    ] as never);
    for (let i = 1; i < s.length; i++) expect(s[i - 1].failRatio).toBeGreaterThanOrEqual(s[i].failRatio);
  });

  test('长尾（占比 <10%）不出建议', () => {
    const rows = [failed('execution'), ...Array.from({ length: 20 }, () => failed('execution'))];
    rows.push(failed('summary')); // 1/22 ≈ 4.5%
    const s = suggestStrategies(rows as never);
    expect(s.find((x) => x.attributionTag === 'summary')).toBeUndefined();
  });

  test('全部达成时不出建议', () => {
    expect(suggestStrategies([{ eval_id: 'a', outcome: 'achieved', attribution_stage: null }] as never)).toEqual([]);
  });

  test('意图环节的建议要求人工审核（安全兜底）', () => {
    const s = suggestStrategies([failed('intent')] as never);
    expect(s[0].requiresHumanReview).toBe(true);
  });

  test('生成 draft 版本并关联归因标签', () => {
    const [s] = suggestStrategies([failed('execution')] as never);
    const v = materializeStrategy(s, 'strat-parent');
    expect(v.status).toBe('draft');
    expect(v.attribution_tag).toBe('execution');
    expect(v.parent_version).toBe('strat-parent');
    expect(v.trigger_source).toBe('auto');
    expect(v.gate_status).toBe('na');
    expect(persistStrategy(v)).toBe(v.version_id);
  });

  test('四类策略类型都能被产出', () => {
    const stages = ['intent', 'planning', 'param_gen', 'summary'];
    const types = stages.map((st) => materializeStrategy(suggestStrategies([failed(st)] as never)[0], null).strategy_type);
    expect(new Set(types).size).toBeGreaterThanOrEqual(3);
    for (const t of types) expect(['prompt', 'routing', 'param', 'fewshot']).toContain(t);
  });
});

// ── F4.6 数据回流 ────────────────────────────────────────────────────

describe('FLM F4 · 数据回流（AC-F4.6、TC-FLM-19）', () => {
  const rows = [
    { eval_id: 'p1', task_id: 'g1', outcome: 'achieved', attribution_stage: null },
    { eval_id: 'n1', task_id: 'g2', outcome: 'failed', attribution_stage: 'execution' },
    { eval_id: 'p2', task_id: 'g3', outcome: 'achieved', attribution_stage: null },
  ] as never[];

  const goals = new Map([
    ['g1', { goal: '把服务部署到生产环境', summary: '部署完成' }],
    ['g2', { goal: '把服务部署到生产环境', summary: '超时未完成' }],
    ['g3', { goal: '生成季度报表', summary: '报表已生成' }],
  ]);

  test('同目标的成功/失败配对成偏好对', () => {
    const a = buildDataFeedback(rows, goals);
    expect(a.preferencePairs.length).toBe(1);
    expect(a.preferencePairs[0].chosen.outcome).toBe('achieved');
    expect(a.preferencePairs[0].rejected.outcome).toBe('failed');
  });

  test('偏好对必须带 similarity，且它就是配对判据本身（回归，2026-10-10）', () => {
    // 控制台的「相似度」列读的就是这个字段。它此前被算出来又丢掉，
    // 前端拿到 undefined → `p.similarity.toFixed(2)` 抛 TypeError →
    // 整个控制台 7 个页签一起白屏。契约字段缺失必须在这里拦住。
    const a = buildDataFeedback(rows, goals);
    expect(a.preferencePairs.length).toBe(1);
    const sim = a.preferencePairs[0].similarity;
    expect(typeof sim).toBe('number');
    expect(Number.isFinite(sim)).toBe(true);
    // 能配成对，说明它必然过了 minSimilarity 这道闸 —— 值与判据同源。
    expect(sim).toBeGreaterThanOrEqual(0.5);
    expect(sim).toBeLessThanOrEqual(1);
  });

  test('similarity 反映真实相似度：同目标高、异目标不配对', () => {
    // 同目标下再加一条失败轨迹，配上来的应当是高相似度那一组。
    const same = buildDataFeedback(rows, goals);
    expect(same.preferencePairs[0].similarity).toBeGreaterThan(0.8);
  });

  test('SFT 语料只取成功轨迹', () => {
    const a = buildDataFeedback(rows, goals);
    expect(a.sftSamples.length).toBe(2);
    for (const s of a.sftSamples) expect(s.outcome).toBe('achieved');
  });

  test('每条产物带来源与生成时间（AC-F4.6 硬要求）', () => {
    const a = buildDataFeedback(rows, goals);
    for (const p of a.preferencePairs) expect(p.generatedAt).toBeGreaterThan(0);
    for (const s of a.sftSamples) {
      expect(s.source).toContain('task:');
      expect(s.generatedAt).toBeGreaterThan(0);
    }
  });

  test('目标不同的轨迹不配对', () => {
    const a = buildDataFeedback(rows, new Map([
      ['g1', { goal: '写代码', summary: 'ok' }],
      ['g2', { goal: '做财务报表', summary: 'no' }],
    ]));
    expect(a.preferencePairs.length).toBe(0);
  });

  test('统计口径正确', () => {
    const a = buildDataFeedback(rows, goals);
    expect(a.stats.sft).toBe(2);
    expect(a.stats.positiveTasks).toBe(2);
    expect(a.stats.negativeTasks).toBe(1);
  });

  test('可导出为 JSONL，每行是合法 JSON', () => {
    const { pairs, sft } = toJsonl(buildDataFeedback(rows, goals));
    for (const line of pairs.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    for (const line of sft.split('\n').filter(Boolean)) {
      const o = JSON.parse(line);
      expect(o.source).toBeDefined();
      expect(o.generatedAt).toBeDefined();
    }
  });

  test('记忆化不改变相似度数值：与朴素重算逐位一致（回归，2026-10-10）', () => {
    // 配对循环改成了按目标文本缓存向量与 bigram 集合（原因见 buildDataFeedback 注释）。
    // 这是纯优化，**输出必须逐位不变** —— 否则"更快"就变成"算错了也没人发现"。
    // 判据直接照抄原始公式，与实现互为独立来源。
    const a = buildDataFeedback(rows, goals);
    const p = a.preferencePairs[0];
    const pg = goals.get('g1')!.goal;
    const ng = goals.get('g2')!.goal; // 同目标（成功 vs 失败）
    const naive = 0.7 * cosine(embed(pg), embed(ng)) + 0.3 * lexicalOverlap(pg, ng);
    expect(p.similarity).toBe(Number(naive.toFixed(4)));
  });

  test('大输入下仍是线性量级：不因正×负双重循环退化（性能结构保证）', () => {
    // 这条钉住的不变量是"每个目标只向量化一次"。
    //
    // 原来 80 正 × 80 负 = 6400 次比较，每次现场重算两侧的 embed 与 bigrams
    // （目标文本最长 300 字 → 每次 600 次 sha1 + 600 次子串切分），量级已是数秒；
    // 而这是同步计算，会把 Node 事件循环一起冻住（实盘同进程内 1.5ms 的
    // /api/flm/health 排队 3.5 秒），表现为整站随机超时、连接被重置 —— 排查成本极高。
    //
    // 阈值 500ms：修复后实测约 60ms（差 8 倍），不修复约 2 秒（差 4 倍）。
    // 两个方向都有余量，所以既不依赖机器快慢，也不会把回归放过去。
    const heavy = 80;
    const long = '把使用手册，提交push。'.repeat(20).slice(0, 300); // 与 taskGoalText 的 300 字上限对齐
    const bigRows = [] as unknown[];
    const bigGoals = new Map<string, { goal: string; summary: string | null }>();
    for (let i = 0; i < heavy; i += 1) {
      // 正负同目标（相似度需过 minSimilarity 才配得上对），但每个 i 的目标互不相同，
      // 这样"不同目标数"= 2 × heavy，记忆化的收益才有意义。
      bigRows.push({ eval_id: `e_p${i}`, task_id: `tp${i}`, outcome: 'achieved', attribution_stage: null });
      bigGoals.set(`tp${i}`, { goal: `${long}#${i}`, summary: 'ok' });
      bigRows.push({ eval_id: `e_n${i}`, task_id: `tn${i}`, outcome: 'failed', attribution_stage: null });
      bigGoals.set(`tn${i}`, { goal: `${long}#${i}`, summary: 'no' });
    }
    const t0 = Date.now();
    const out = buildDataFeedback(bigRows as never[], bigGoals);
    const elapsed = Date.now() - t0;
    expect(out.preferencePairs.length).toBe(heavy);
    expect(elapsed).toBeLessThan(500);
  });
});

// ── F4.7 知识库自更新 ────────────────────────────────────────────────

describe('FLM F4 · 知识条目候选（AC-F4.7、TC-FLM-20）', () => {
  const TASK = 'turn:knowledge-test';

  function seedCorrection(note: string, eventId: string) {
    insertEventIfNew({
      event_id: eventId,
      source: 'user',
      type: 'explicit_correction',
      task_id: TASK,
      trace_id: null,
      session_id: 's',
      step_id: null,
      chat_jid: 'web:test',
      user_id: 'u1',
      raw_payload: '{}',
      normalized_payload: JSON.stringify({ correction_text: note }),
      confidence: 0.9,
      weight: 1,
      alignment: 'direct',
      dedup_key: `dk-${eventId}`,
      desensitized: 0,
      conflict: 0,
      tenant_id: 'default',
      occurred_at: Date.now(),
      created_at: Date.now(),
    });
  }

  test('纠错反馈生成候选，状态为 pending（不直接入知识库）', () => {
    seedCorrection('查询订单时应该先按用户维度过滤再聚合', 'kn-e1');
    const c = buildKnowledgeCandidates(TASK);
    expect(c.length).toBe(1);
    expect(c[0].status).toBe('pending');
    expect(c[0].content).toContain('按用户维度过滤');
  });

  test('过短的纠错文本不生成候选（无信息量）', () => {
    seedCorrection('不对', 'kn-e2');
    const c = buildKnowledgeCandidates(TASK).filter((x) => x.sourceEventId === 'kn-e2');
    expect(c.length).toBe(0);
  });

  test('非纠错类反馈不生成候选', () => {
    insertEventIfNew({
      event_id: 'kn-like', source: 'user', type: 'explicit_like', task_id: TASK,
      trace_id: null, session_id: 's', step_id: null, chat_jid: 'web:test', user_id: 'u1',
      raw_payload: '{}', normalized_payload: '{}', confidence: 0.9, weight: 1,
      alignment: 'direct', dedup_key: 'dk-kn-like', desensitized: 0, conflict: 0,
      tenant_id: 'default', occurred_at: Date.now(), created_at: Date.now(),
    });
    expect(buildKnowledgeCandidates(TASK).some((x) => x.sourceEventId === 'kn-like')).toBe(false);
  });

  test('审核通过后状态变为 accepted', () => {
    seedCorrection('导出报表时需要固定表头并冻结首行', 'kn-e3');
    const [c] = persistKnowledgeCandidates(buildKnowledgeCandidates(TASK).filter((x) => x.sourceEventId === 'kn-e3')) === 1
      ? buildKnowledgeCandidates(TASK).filter((x) => x.sourceEventId === 'kn-e3')
      : [];
    expect(c).toBeDefined();
    persistKnowledgeCandidates([c]);

    expect(reviewKnowledge(c.id, 'accepted', 'admin', '已验证')).toBe(true);
    const row = listKnowledge('accepted').find((k) => k.id === c.id);
    expect(row).toBeDefined();
    expect(row?.reviewer).toBe('admin');
    expect(row?.reviewed_at).toBeGreaterThan(0);
  });

  test('已裁决的条目不可重复裁决（审计线不可翻转）', () => {
    const pending = listKnowledge('pending');
    if (pending.length === 0) return;
    const id = pending[0].id;
    expect(reviewKnowledge(id, 'rejected', 'admin', '不合适')).toBe(true);
    expect(reviewKnowledge(id, 'accepted', 'admin', '反悔')).toBe(false);
  });
});
