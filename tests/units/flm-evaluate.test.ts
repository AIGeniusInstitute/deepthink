// FLM 三层评价引擎单测 —— 纯函数，不碰数据库、不调 LLM。
// 覆盖 PRD F3 全部验收标准：三层产出 / 失败归因 / 可解释性 / 双轨比对。

import { describe, expect, test } from 'vitest';

const { evaluateTask, qualityMean, isQualityBelowBar } = await import('../../src/flm/flm-evaluate.js');
const { QUALITY_DIMENSIONS } = await import('../../src/flm/flm-types.js');

type Ctx = Parameters<typeof evaluateTask>[0];
type Ev = Ctx['events'][number];
type Nd = Ctx['nodes'][number];
type Tc = Ctx['toolCalls'][number];

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    taskId: 'turn:T1',
    traceId: 'tr-1',
    sessionId: 's-1',
    chatJid: 'web:test',
    events: [],
    nodes: [],
    toolCalls: [],
    ...over,
  };
}

function node(over: Partial<Nd> = {}): Nd {
  return {
    nodeType: 'tool',
    title: 'Bash',
    status: 'done',
    startedAt: 1000,
    endedAt: 1500,
    tokens: 100,
    ...over,
  };
}

function ev(over: Partial<Ev> = {}): Ev {
  return {
    eventId: 'e1',
    source: 'user',
    type: 'explicit_like',
    confidence: 0.9,
    weight: 1,
    payload: {},
    occurredAt: 1000,
    ...over,
  };
}

function tc(over: Partial<Tc> = {}): Tc {
  return { toolName: 'Bash', status: 'success', startedAt: 1000, endedAt: 1200, output: '', ...over };
}

// ── 结果层（AC-F3.1）─────────────────────────────────────────────────

describe('FLM F3 · 结果层 outcome', () => {
  test('用户点赞 + 全链路成功 → achieved', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_like' })], nodes: [node()] }));
    expect(r.outcome).toBe('achieved');
  });

  test('用户点踩 → failed', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_reject' })], nodes: [node()] }));
    expect(r.outcome).toBe('failed');
  });

  test('评分 ≤2 视为否决 → failed', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_rating', payload: { rating: 2 } })] }));
    expect(r.outcome).toBe('failed');
  });

  test('评分 ≥4 视为认可 → achieved', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_rating', payload: { rating: 5 } })], nodes: [node()] }));
    expect(r.outcome).toBe('achieved');
  });

  test('评分 3 既不否决也不认可 —— 无其他信号时按轨迹判定', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_rating', payload: { rating: 3 } })], nodes: [node()] }));
    expect(r.outcome).toBe('achieved');
  });

  test('环境 diff 未达成优先级高于用户点赞 → failed', () => {
    const r = evaluateTask(
      ctx({
        events: [ev({ type: 'explicit_like' }), ev({ eventId: 'e2', source: 'env', type: 'env_snapshot_diff', payload: { verdict: 'unmet' } })],
        nodes: [node()],
      }),
    );
    expect(r.outcome).toBe('failed');
    expect(r.outcomeReason).toContain('环境');
  });

  test('全链路失败 → failed', () => {
    const r = evaluateTask(ctx({ nodes: [node({ status: 'failed' }), node({ status: 'failed' })] }));
    expect(r.outcome).toBe('failed');
  });

  test('部分失败且用户未表态 → partial', () => {
    const r = evaluateTask(ctx({ nodes: [node({ status: 'done' }), node({ status: 'failed' })] }));
    expect(r.outcome).toBe('partial');
  });

  test('无轨迹无反馈 → partial（不假装达成）', () => {
    const r = evaluateTask(ctx({ nodes: [] }));
    expect(r.outcome).toBe('partial');
  });

  test('running 状态不计入成功也不计入失败（实盘 running 占比高）', () => {
    const r = evaluateTask(ctx({ nodes: [node({ status: 'running' }), node({ status: 'done' })] }));
    expect(r.outcome).toBe('achieved');
    expect(r.stepCount).toBe(2);
  });
});

// ── 过程层（AC-F3.2）─────────────────────────────────────────────────

describe('FLM F3 · 过程层 process', () => {
  test('路径符合度 = 成功步骤 / 已判定步骤', () => {
    const r = evaluateTask(
      ctx({ nodes: [node({ status: 'done' }), node({ status: 'done' }), node({ status: 'failed' }), node({ status: 'done' })] }),
    );
    expect(r.pathConformity).toBeCloseTo(0.75, 3);
  });

  test('统计步数、重试数、首异常点', () => {
    const r = evaluateTask(
      ctx({
        nodes: [
          node({ title: 'Bash', status: 'failed' }),
          node({ title: 'Bash', status: 'done' }),
          node({ title: 'Read', status: 'done' }),
        ],
      }),
    );
    expect(r.stepCount).toBe(3);
    expect(r.retryCount).toBe(1); // Bash 出现两次
    expect(r.firstAnomalyStep).toBe('Bash');
  });

  test('耗时按节点区间累加', () => {
    const r = evaluateTask(
      ctx({ nodes: [node({ startedAt: 0, endedAt: 1000 }), node({ startedAt: 2000, endedAt: 3500 })] }),
    );
    expect(r.durationMs).toBe(2500);
  });

  test('未结束节点不计入耗时且不崩', () => {
    const r = evaluateTask(ctx({ nodes: [node({ startedAt: 0, endedAt: null })] }));
    expect(r.durationMs).toBe(0);
  });

  test('过程分为 0–100 整数', () => {
    const r = evaluateTask(ctx({ nodes: [node()] }));
    expect(r.processScore).toBeGreaterThanOrEqual(0);
    expect(r.processScore).toBeLessThanOrEqual(100);
  });
});

// ── 质量层（AC-F3.3）─────────────────────────────────────────────────

describe('FLM F3 · 质量层 quality', () => {
  test('六维全部产出且均在 0–100', () => {
    const r = evaluateTask(ctx({ nodes: [node()] }));
    expect(Object.keys(r.qualityScores).sort()).toEqual([...QUALITY_DIMENSIONS].sort());
    for (const d of QUALITY_DIMENSIONS) {
      expect(r.qualityScores[d]).toBeGreaterThanOrEqual(0);
      expect(r.qualityScores[d]).toBeLessThanOrEqual(100);
    }
  });

  test('「事实错误」标签压低事实性', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_reject', payload: { reason_tags: ['事实错误'] } })] }));
    expect(r.qualityScores.factuality).toBe(30);
  });

  test('「格式不符」标签压低格式分', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_reject', payload: { reason_tags: ['格式不符'] } })] }));
    expect(r.qualityScores.format).toBe(30);
  });

  test('长耗时压低时延分', () => {
    const r = evaluateTask(ctx({ nodes: [node({ startedAt: 0, endedAt: 400_000 })] }));
    expect(r.qualityScores.latency).toBeLessThanOrEqual(40);
  });

  test('高 token 压低成本分', () => {
    const r = evaluateTask(ctx({ nodes: [node({ tokens: 600_000 })] }));
    expect(r.qualityScores.cost).toBeLessThanOrEqual(40);
  });

  test('无反馈时偏好匹配为中性 70（不惩罚沉默）', () => {
    const r = evaluateTask(ctx({ nodes: [node()] }));
    expect(r.qualityScores.preference).toBe(70);
  });

  test('正负反馈比例决定偏好分', () => {
    const r = evaluateTask(
      ctx({
        events: [
          ev({ eventId: 'a', type: 'explicit_like' }),
          ev({ eventId: 'b', type: 'explicit_like' }),
          ev({ eventId: 'c', type: 'explicit_reject' }),
          ev({ eventId: 'd', type: 'explicit_reject' }),
        ],
        nodes: [node()],
      }),
    );
    expect(r.qualityScores.preference).toBe(50);
  });

  test('qualityMean 为六维均分', () => {
    expect(qualityMean({ factuality: 100, format: 100, latency: 100, cost: 100, safety: 100, preference: 100 })).toBe(100);
    expect(qualityMean({ factuality: 0, format: 0, latency: 0, cost: 0, safety: 0, preference: 60 })).toBe(10);
  });

  test('isQualityBelowBar 任一维低于阈值即不达标', () => {
    const ok = { factuality: 100, format: 100, latency: 100, cost: 100, safety: 100, preference: 100 };
    expect(isQualityBelowBar(ok, 60)).toBe(false);
    expect(isQualityBelowBar({ ...ok, format: 59 }, 60)).toBe(true);
  });
});

// ── 归因（AC-F3.4）──────────────────────────────────────────────────

describe('FLM F3 · 失败归因', () => {
  test('achieved 不产生归因', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_like' })], nodes: [node()] }));
    expect(r.attributionStage).toBeNull();
  });

  test('「答非所问」→ 意图理解', () => {
    const r = evaluateTask(
      ctx({ events: [ev({ type: 'explicit_reject', payload: { reason_tags: ['答非所问'] } })] }),
    );
    expect(r.attributionStage).toBe('intent');
  });

  test('首个 turn 节点失败 → 意图理解', () => {
    const r = evaluateTask(
      ctx({ nodes: [node({ nodeType: 'turn', status: 'failed', title: '首轮' })] }),
    );
    expect(r.attributionStage).toBe('intent');
  });

  test('工具超时 → 执行环节', () => {
    const r = evaluateTask(
      ctx({
        nodes: [node({ status: 'failed' })],
        toolCalls: [tc({ status: 'error', output: 'Request timeout after 30s' })],
      }),
    );
    expect(r.attributionStage).toBe('execution');
  });

  test('工具入参不合法 → 参数生成', () => {
    const r = evaluateTask(
      ctx({
        nodes: [node({ status: 'failed' })],
        toolCalls: [tc({ status: 'failed', output: 'invalid argument: required field missing' })],
      }),
    );
    expect(r.attributionStage).toBe('param_gen');
  });

  test('工具失败但无线索 → 工具选择', () => {
    const r = evaluateTask(
      ctx({
        nodes: [node({ status: 'failed' })],
        toolCalls: [tc({ status: 'failed', output: 'unexpected result shape' })],
      }),
    );
    expect(r.attributionStage).toBe('tool_selection');
  });

  test('步骤异常膨胀且无工具报错 → 规划', () => {
    const nodes = Array.from({ length: 45 }, (_, i) => node({ title: `step-${i}`, status: 'done' }));
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_reject' })], nodes }));
    expect(r.attributionStage).toBe('planning');
  });

  test('全链路成功但结果未达成 → 总结', () => {
    const r = evaluateTask(
      ctx({ events: [ev({ type: 'explicit_reject', payload: { reason_tags: ['过于冗长'] } })], nodes: [node()] }),
    );
    expect(r.attributionStage).toBe('summary');
  });
});

// ── 可解释性（AC-F3.5/AC-F3.6）───────────────────────────────────────

describe('FLM F3 · 可解释性与证据', () => {
  test('任何结论都至少带一条证据（可解释率 100%）', () => {
    const cases = [
      ctx({}),
      ctx({ nodes: [node()] }),
      ctx({ events: [ev({ type: 'explicit_reject' })] }),
      ctx({ events: [ev({ source: 'env', type: 'env_snapshot_diff', payload: { verdict: 'unmet' } })] }),
    ];
    for (const c of cases) {
      const r = evaluateTask(c);
      expect(r.evidence.length).toBeGreaterThanOrEqual(1);
      for (const e of r.evidence) {
        expect(['feedback', 'log', 'env', 'trace']).toContain(e.kind);
        expect(e.excerpt.length).toBeGreaterThan(0);
      }
    }
  });

  test('归因结论附带证据片段', () => {
    const r = evaluateTask(
      ctx({
        nodes: [node({ status: 'failed' })],
        toolCalls: [tc({ status: 'error', output: 'rate limit exceeded' })],
      }),
    );
    expect(r.evidence.some((e) => e.kind === 'log')).toBe(true);
  });

  test('结果层给出可读结论文案', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_reject' })] }));
    expect(r.outcomeReason.length).toBeGreaterThan(0);
    expect(r.outcomeReason).toContain('用户');
  });
});

// ── 双轨比对（AC-F3.2、TC-FLM-15）───────────────────────────────────

describe('FLM F3 · 规则轨与 LLM 轨', () => {
  test('默认只跑规则轨', () => {
    const r = evaluateTask(ctx({ nodes: [node()] }));
    expect(r.evaluator).toBe('rule');
    expect(r.needsReview).toBe(false);
  });

  test('两轨一致时不进复核队列', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_reject' })], nodes: [node()] }), {
      useLlm: true,
      llmVerdict: { outcome: 'failed', reason: '用户不满' },
    });
    expect(r.needsReview).toBe(false);
    expect(r.evaluator).toBe('both');
  });

  test('两轨不一致 → 标记复核且理由里说明分歧', () => {
    const r = evaluateTask(ctx({ events: [ev({ type: 'explicit_reject' })], nodes: [node()] }), {
      useLlm: true,
      llmVerdict: { outcome: 'achieved', reason: '实际已完成' },
    });
    expect(r.needsReview).toBe(true);
    expect(r.outcomeReason).toContain('LLM');
  });

  test('useLlm=true 但未给 LLM 判定时不误报复核', () => {
    const r = evaluateTask(ctx({ nodes: [node()] }), { useLlm: true, llmVerdict: null });
    expect(r.needsReview).toBe(false);
    expect(r.evaluator).toBe('rule');
  });
});

// ── 性能结构保证（PRD 非功能：单任务三层评价 ≤ 10 秒）────────────────

describe('FLM F3 · 性能结构保证', () => {
  test('千节点规模评价仍在 10 秒内（纯计算，无 IO）', () => {
    const nodes = Array.from({ length: 1000 }, (_, i) =>
      node({ title: `step-${i % 50}`, status: i % 20 === 0 ? 'failed' : 'done' }),
    );
    const calls = Array.from({ length: 1000 }, (_, i) => tc({ toolName: `tool-${i % 30}` }));
    const started = Date.now();
    const r = evaluateTask(ctx({ nodes, toolCalls: calls }));
    const elapsed = Date.now() - started;
    expect(r.stepCount).toBe(1000);
    expect(elapsed).toBeLessThan(10_000);
  });
});
