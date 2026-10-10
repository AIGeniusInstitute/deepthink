// FLM 闭环执行与安全机制单测（PRD F5）。
// 覆盖 AC-F5.1 ~ AC-F5.6 与 TC-FLM-21 ~ TC-FLM-25。

import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-loop-test-'));
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
const {
  runRegressionGate,
  submitForGate,
  setCanary,
  autoRollback,
  approveHumanReview,
  compareVersions,
  isInCanary,
  checkCanaryRegression,
  audit,
  MIN_GRAY_RATIO,
} = await import('../../src/flm/flm-closedloop.js');
const { materializeStrategy, persistStrategy, suggestStrategies } = await import('../../src/flm/flm-learn.js');
const { getStrategy, listAudit, listAlerts, listActions, updateStrategyStatus } = await import('../../src/flm/flm-db.js');

type Metrics = Parameters<typeof runRegressionGate>[0];

const base: Metrics = {
  successRate: 90,
  satisfaction: 85,
  qualityMean: 88,
  correctionRate: 70,
  avgLatencyMs: 5000,
  avgCostTokens: 20_000,
};

function metrics(over: Partial<Metrics> = {}): Metrics {
  return { ...base, ...over };
}

/** 造一个已过门禁的 draft 版本，用于灰度测试。 */
function readyVersion(name: string, requiresReview = false): string {
  const v = materializeStrategy(
    {
      strategyType: 'prompt',
      name,
      content: `内容-${name}`,
      attributionTag: 'intent',
      triggerSource: 'auto',
      requiresHumanReview: requiresReview,
      failCount: 5,
      failRatio: 0.5,
      rationale: 'test',
    },
    null,
  );
  v.version_id = `strat_${name}`;
  persistStrategy(v);
  updateStrategyStatus(v.version_id, { gateStatus: 'passed' });
  return v.version_id;
}

beforeAll(() => {
  initDatabase();
});

// ── 门禁（AC-F5.2、TC-FLM-21）───────────────────────────────────────

describe('FLM F5 · 回归门禁', () => {
  test('指标全面改善 → 通过', () => {
    const r = runRegressionGate(base, metrics({ successRate: 95, satisfaction: 90, avgLatencyMs: 4000 }));
    expect(r.gateStatus).toBe('passed');
    expect(r.blockedBy).toEqual([]);
  });

  test('成功率下降 6 个百分点（超 5 阈值）→ 拦截', () => {
    const r = runRegressionGate(base, metrics({ successRate: 84 }));
    expect(r.gateStatus).toBe('blocked');
    expect(r.blockedBy).toContain('任务成功率');
  });

  test('劣化恰好等于阈值 → 不拦截（边界不冤杀）', () => {
    const r = runRegressionGate(base, metrics({ successRate: 85 }));
    expect(r.gateStatus).toBe('passed');
  });

  test('时延劣化按相对比例判定（100% 涨幅 → 拦截）', () => {
    const r = runRegressionGate(base, metrics({ avgLatencyMs: 10_000 }));
    expect(r.blockedBy).toContain('平均时延');
  });

  test('时延小幅波动（4%）不拦截', () => {
    const r = runRegressionGate(base, metrics({ avgLatencyMs: 5200 }));
    expect(r.blockedBy).not.toContain('平均时延');
  });

  test('多项同时劣化时全部列出（不只报第一项）', () => {
    const r = runRegressionGate(base, metrics({ successRate: 70, satisfaction: 60, avgCostTokens: 60_000 }));
    expect(r.blockedBy.length).toBeGreaterThanOrEqual(3);
    expect(r.degradations.filter((d) => d.breached).length).toBe(r.blockedBy.length);
  });

  test('基线为 0 时不因除零而误判', () => {
    const r = runRegressionGate(metrics({ avgLatencyMs: 0 }), metrics({ avgLatencyMs: 9999 }));
    expect(r.degradations.find((d) => d.key === 'avgLatencyMs')?.breached).toBe(false);
  });

  test('报告含每项指标的双侧数值与劣化幅度', () => {
    const r = runRegressionGate(base, metrics({ successRate: 80 }));
    const d = r.degradations.find((x) => x.key === 'successRate')!;
    expect(d.baseline).toBe(90);
    expect(d.candidate).toBe(80);
    expect(d.delta).toBe(-10);
    expect(d.unit).toBe('pct');
  });

  test('submitForGate：劣化版本被拦截且不可放量（TC-FLM-21）', () => {
    const id = readyVersion('gate-block');
    const res = submitForGate(id, base, metrics({ successRate: 60 }));
    expect(res.ok).toBe(false);
    expect(res.report?.gateStatus).toBe('blocked');
    expect(getStrategy(id)?.gate_status).toBe('blocked');

    const canary = setCanary(id, 10);
    expect(canary.ok).toBe(false);
  });

  test('submitForGate：合格版本通过门禁（TC-FLM-22 前置）', () => {
    const id = readyVersion('gate-pass');
    const res = submitForGate(id, base, metrics({ successRate: 92 }));
    expect(res.ok).toBe(true);
    expect(getStrategy(id)?.gate_status).toBe('passed');
  });

  test('版本不存在时明确报错', () => {
    expect(submitForGate('nope', base, base).ok).toBe(false);
  });
});

// ── 人工审核（AC-F5.5）──────────────────────────────────────────────

describe('FLM F5 · 强制人工审核', () => {
  test('未审核的安全类版本被门禁拦下', () => {
    const id = readyVersion('review-required', true);
    const res = submitForGate(id, base, metrics({ successRate: 99 }));
    expect(res.ok).toBe(false);
    expect(res.blockedReason).toContain('人工审核');
    expect(getStrategy(id)?.gate_status).toBe('blocked');
  });

  test('未审核不可放量，且产生告警', () => {
    const id = readyVersion('review-canary', true);
    const res = setCanary(id, 10);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('审核');
    expect(listAlerts(50).some((a) => a.metric === 'human_review_required')).toBe(true);
  });

  test('非强制审核版本无需签字', () => {
    const id = readyVersion('review-not-needed');
    expect(approveHumanReview(id, 'admin', 'x').ok).toBe(false);
  });

  test('签字后仍需过门禁（审核是必要非充分条件）', () => {
    const id = readyVersion('review-then-gate', true);
    expect(approveHumanReview(id, 'admin', '已评估风险').ok).toBe(true);
    expect(getStrategy(id)?.reviewed_by).toContain('admin');

    // 签字后指标劣化，依然要被拦
    const res = submitForGate(id, base, metrics({ successRate: 50 }));
    expect(res.ok).toBe(false);
    expect(res.report?.gateStatus).toBe('blocked');
  });
});

// ── 灰度（AC-F5.3、TC-FLM-22/23）────────────────────────────────────

describe('FLM F5 · 灰度发布', () => {
  test('通过门禁的版本可灰度到 10%（TC-FLM-22）', () => {
    const id = readyVersion('canary-10');
    const res = setCanary(id, 10);
    expect(res.ok).toBe(true);
    const v = getStrategy(id);
    expect(v?.status).toBe('canary');
    expect(v?.gray_ratio).toBe(10);
  });

  test('比例 10% → 100% 转为 released（TC-FLM-23）', () => {
    const id = readyVersion('canary-full');
    setCanary(id, 10);
    const res = setCanary(id, 100);
    expect(res.ok).toBe(true);
    expect(getStrategy(id)?.status).toBe('released');
    expect(getStrategy(id)?.gray_ratio).toBe(100);
  });

  test('比例可调：10% → 30% 仍在 canary', () => {
    const id = readyVersion('canary-adjust');
    setCanary(id, 10);
    setCanary(id, 30);
    const v = getStrategy(id);
    expect(v?.status).toBe('canary');
    expect(v?.gray_ratio).toBe(30);
  });

  test('最小灰度比例为 1%，0 被拒（AC-F5.3）', () => {
    const id = readyVersion('canary-min');
    expect(MIN_GRAY_RATIO).toBe(1);
    expect(setCanary(id, 0).ok).toBe(false);
    expect(setCanary(id, 1).ok).toBe(true);
  });

  test('超过 100% 被拒', () => {
    const id = readyVersion('canary-over');
    expect(setCanary(id, 101).ok).toBe(false);
  });

  test('同一策略类型同时只允许一个灰度版本', () => {
    const a = readyVersion('dup-a');
    const b = readyVersion('dup-b');
    setCanary(a, 20);
    setCanary(b, 20);
    expect(getStrategy(a)?.status).toBe('archived');
    expect(getStrategy(b)?.status).toBe('canary');
  });

  test('灰度分流：比例 100 时全部命中，且同一 key 结果稳定', () => {
    const id = readyVersion('canary-route');
    setCanary(id, 100);
    const r1 = isInCanary('prompt', 'session-abc');
    const r2 = isInCanary('prompt', 'session-abc');
    expect(r1.inCanary).toBe(true);
    expect(r2.inCanary).toBe(true);
    expect(r1.ratio).toBe(100);
  });

  test('灰度分流：比例 1% 时命中率低的 key 不进入新版本', () => {
    const id = readyVersion('canary-1pct');
    setCanary(id, 1);
    // 同一 key 多次调用结果必须一致（不能用随机数）
    const first = isInCanary('prompt', 'stable-key-1');
    for (let i = 0; i < 5; i++) {
      expect(isInCanary('prompt', 'stable-key-1').inCanary).toBe(first.inCanary);
    }
  });

  test('无灰度版本时不分流', () => {
    expect(isInCanary('fewshot', 'k').inCanary).toBe(false);
  });
});

// ── 自动回滚（AC-F5.4、TC-FLM-24）───────────────────────────────────

describe('FLM F5 · 自动回滚', () => {
  // 这条不变量是回滚正确性的前提：publish_time 只有毫秒精度，连续放量会撞毫秒，
  // 一旦撞上 `ORDER BY publish_time DESC` 就不是全序 —— 回滚会挑到错误的版本。
  // （原实现用裸 Date.now()，此用例在 12 次连跑中偶发 4 次失败。）
  test('连续放量的 publish_time 严格递增 —— 保证"更晚发布"可判定', () => {
    const ids = ['mono-1', 'mono-2', 'mono-3', 'mono-4', 'mono-5'].map((n) => {
      const id = readyVersion(n);
      setCanary(id, 100);
      return id;
    });

    const times = ids.map((id) => getStrategy(id)!.publish_time!);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  test('回滚把灰度版本置为 rolled_back，并恢复上一稳定版本（TC-FLM-24）', () => {
    // 先造一个已发布的稳定版本，再造一个灰度版本
    const stable = readyVersion('rb-stable');
    setCanary(stable, 100);
    expect(getStrategy(stable)?.status).toBe('released');

    const bad = readyVersion('rb-bad');
    setCanary(bad, 30);
    expect(getStrategy(bad)?.status).toBe('canary');
    // 让 bad 的 publish_time 晚于 stable，确保回滚目标是 stable
    const res = autoRollback(bad, '灰度期成功率下降 15 个百分点');

    expect(res.rolledBack).toBe(true);
    expect(getStrategy(bad)?.status).toBe('rolled_back');
    expect(res.toVersion).toBe(stable);
    expect(getStrategy(stable)?.status).toBe('released');
  });

  test('回滚耗时远低于 60 秒上限（AC-F5.4）', () => {
    const v = readyVersion('rb-fast');
    setCanary(v, 10);
    const res = autoRollback(v, '指标劣化');
    expect(res.elapsedMs).toBeLessThan(60_000);
  });

  test('回滚产生告警', () => {
    const before = listAlerts(200).length;
    const v = readyVersion('rb-alert');
    setCanary(v, 10);
    autoRollback(v, '错误率突增');
    const after = listAlerts(200);
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((a) => a.metric === 'canary_regression')).toBe(true);
  });

  test('回滚落成闭环动作记录', () => {
    const v = readyVersion('rb-action');
    setCanary(v, 10);
    autoRollback(v, '测试回滚');
    expect(listActions(200).some((a) => a.action_type === 'rollback')).toBe(true);
  });

  test('回滚不存在的版本 → 明确失败而非静默', () => {
    const res = autoRollback('does-not-exist', 'x');
    expect(res.rolledBack).toBe(false);
    expect(res.reason).toContain('不存在');
  });

  test('灰度劣化巡检自动触发回滚', () => {
    const v = readyVersion('rb-sweep');
    setCanary(v, 20);
    const results = checkCanaryRegression(
      new Map([['prompt', base]]),
      new Map([['prompt', metrics({ successRate: 40 })]]),
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(getStrategy(v)?.status).toBe('rolled_back');
  });

  test('指标正常时巡检不回滚', () => {
    const v = readyVersion('rb-clean');
    setCanary(v, 20);
    const results = checkCanaryRegression(
      new Map([['prompt', base]]),
      new Map([['prompt', metrics({ successRate: 91 })]]),
    );
    expect(results.length).toBe(0);
    expect(getStrategy(v)?.status).toBe('canary');
  });
});

// ── 审计（AC-F5.6、TC-FLM-25）───────────────────────────────────────

describe('FLM F5 · 全链路审计', () => {
  test('生成 / 拦截 / 放量 / 回滚 全部留痕且可按时间线回放（TC-FLM-25）', () => {
    const v = readyVersion('audit-flow');
    submitForGate(v, base, metrics({ successRate: 30 }));   // gate_blocked
    setCanary(v, 10);                                       // 应被拒（门禁未过）
    updateStrategyStatus(v, { gateStatus: 'passed' });
    setCanary(v, 10);                                       // canary
    setCanary(v, 100);                                      // release
    autoRollback(v, '审计测试');                            // rollback

    const timeline = listAudit({ versionId: v, limit: 200 });
    const actions = timeline.map((t) => t.action);
    expect(actions).toContain('gate_blocked');
    expect(actions).toContain('canary');
    expect(actions).toContain('release');
    expect(actions).toContain('rollback');

    // 时间线可按时间正序回放
    const asc = [...timeline].sort((a, b) => a.created_at - b.created_at);
    expect(asc.length).toBe(timeline.length);
    for (const t of asc) {
      expect(t.created_at).toBeGreaterThan(0);
      expect(t.detail ?? '').not.toBe('');
    }
  });

  test('审计记录含执行者', () => {
    const v = readyVersion('audit-actor');
    setCanary(v, 10, 'alice');
    const rec = listAudit({ versionId: v }).find((a) => a.action === 'canary');
    expect(rec?.actor).toBe('alice');
  });

  test('audit 可独立写入（供其它模块补记）', () => {
    audit('v-x', 'gray_adjust', '手动调整比例', 'bob');
    const rec = listAudit({ versionId: 'v-x' })[0];
    expect(rec.action).toBe('gray_adjust');
    expect(rec.actor).toBe('bob');
  });
});

// ── 版本对比（AC-F6.4、TC-FLM-29）───────────────────────────────────

describe('FLM F5 · 版本对比', () => {
  test('B 劣化 → 不建议放量', () => {
    const c = compareVersions('v1', 'v2', base, metrics({ successRate: 60 }));
    expect(c.shouldRelease).toBe(false);
    expect(c.metrics.find((m) => m.name === '任务成功率')?.verdict).toBe('regressed');
  });

  test('B 改善 → 建议放量', () => {
    const c = compareVersions('v1', 'v2', base, metrics({ successRate: 97 }));
    expect(c.shouldRelease).toBe(true);
    expect(c.metrics.find((m) => m.name === '任务成功率')?.verdict).toBe('improved');
  });

  test('对比表含全部六项核心指标', () => {
    const c = compareVersions('v1', 'v2', base, base);
    expect(c.metrics.length).toBe(6);
  });

  test('建议文案与门禁结论一致（不各说各话）', () => {
    const blocked = compareVersions('v1', 'v2', base, metrics({ successRate: 10 }));
    expect(blocked.recommendation).toContain('拦截');
    expect(blocked.shouldRelease).toBe(false);
  });

  test('支持自定义版本标签', () => {
    const c = compareVersions('v1', 'v2', base, base, { a: 'v1.0', b: 'v1.1' });
    expect(c.a).toBe('v1.0');
    expect(c.b).toBe('v1.1');
  });
});
