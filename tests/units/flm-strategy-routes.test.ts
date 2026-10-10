// FLM 策略版本路由单测（PRD F5 / F6、AC-F6.4、TC-FLM-29）。
//
// 为什么单独一个文件：`compareVersions` 是纯函数，单测再全也证明不了"HTTP 出口真的能走通"。
// 本文件的核心用例是 `/admin/strategies/compare` —— 它注册在 `/admin/strategies/:versionId`
// 之后，Express/Hono 按注册顺序匹配，`compare` 会被当成一个 versionId 吃掉，
// 于是接口永远返回 404「版本不存在」。纯函数单测 100% 通过也照样漏掉这个缺陷。
// 所以这里必须真的发请求，把"路由顺序"这件事钉死在测试里。

import { beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-strategy-routes-'));
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

const { initDatabase } = await import('../../src/db.js');
const { default: flmRoutes } = await import('../../src/routes/flm.js');
const { insertStrategy } = await import('../../src/flm/flm-db.js');

const app = new Hono();
app.route('/api/flm', flmRoutes);

function post(body: unknown, url: string) {
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 造一个策略版本，返回 version_id。直接落库，不走 HTTP —— 这里要测的是策略路由本身。 */
function makeStrategy(name: string) {
  const versionId = `strat_test_${name}`;
  const now = Date.now();
  insertStrategy({
    version_id: versionId,
    strategy_type: 'prompt',
    name,
    content: JSON.stringify({ systemPrompt: `v-${name}` }),
    parent_version: null,
    trigger_source: 'manual',
    attribution_tag: 'execution',
    eval_report: null,
    gate_status: 'na',
    gray_ratio: 0,
    status: 'draft',
    requires_human_review: 0,
    reviewed_by: null,
    publisher: null,
    publish_time: null,
    created_at: now,
    updated_at: now,
  });
  return versionId;
}

beforeAll(() => {
  initDatabase();
});

describe('策略版本对比路由（AC-F6.4 / TC-FLM-29）', () => {
  test('GET /admin/strategies/compare 返回 A/B 对比而不是 404', async () => {
    const a = makeStrategy('灰度基线');
    const b = makeStrategy('候选版本');

    const metricsA = { successRate: 90, satisfaction: 85, qualityMean: 88, correctionRate: 70, avgLatencyMs: 5000, avgCostTokens: 20000 };
    const metricsB = { successRate: 92, satisfaction: 86, qualityMean: 89, correctionRate: 72, avgLatencyMs: 4800, avgCostTokens: 19500 };

    const url = `/api/flm/admin/strategies/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`
      + `&metricsA=${encodeURIComponent(JSON.stringify(metricsA))}`
      + `&metricsB=${encodeURIComponent(JSON.stringify(metricsB))}`;
    const res = await app.request(url);

    // 路由顺序写错时这里会是 404「版本不存在」—— 这正是本用例要抓的回归。
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.comparison).toBeTruthy();
    expect(body.comparison.a).toBe(a);
    expect(body.comparison.b).toBe(b);
    expect(body.comparison.metrics.length).toBeGreaterThan(0);
    expect(body.comparison.shouldRelease).toBe(true);
  });

  test('合格候选给出"可放量"建议；劣化候选给出拦截结论', async () => {
    const a = makeStrategy('对比基线');
    const b = makeStrategy('对比候选');

    const good = { successRate: 92, satisfaction: 86, qualityMean: 89, correctionRate: 72, avgLatencyMs: 4800, avgCostTokens: 19500 };
    const bad = { successRate: 60, satisfaction: 50, qualityMean: 55, correctionRate: 40, avgLatencyMs: 12000, avgCostTokens: 40000 };

    const okRes = await app.request(
      `/api/flm/admin/strategies/compare?a=${a}&b=${b}`
      + `&metricsA=${encodeURIComponent(JSON.stringify(good))}`
      + `&metricsB=${encodeURIComponent(JSON.stringify(good))}`,
    );
    expect(okRes.status).toBe(200);
    expect(((await okRes.json()) as any).comparison.shouldRelease).toBe(true);

    const badRes = await app.request(
      `/api/flm/admin/strategies/compare?a=${a}&b=${b}`
      + `&metricsA=${encodeURIComponent(JSON.stringify(good))}`
      + `&metricsB=${encodeURIComponent(JSON.stringify(bad))}`,
    );
    expect(badRes.status).toBe(200);
    const badBody = (await badRes.json()) as any;
    expect(badBody.comparison.shouldRelease).toBe(false);
    expect(badBody.comparison.metrics.some((m: any) => m.verdict === 'regressed')).toBe(true);
  });

  test('对比结果里每个指标都带 A/B 双侧数值与差值', async () => {
    const a = makeStrategy('字段基线');
    const b = makeStrategy('字段候选');
    const metricsA = { successRate: 90, satisfaction: 85, qualityMean: 88, correctionRate: 70, avgLatencyMs: 5000, avgCostTokens: 20000 };
    const metricsB = { successRate: 91, satisfaction: 87, qualityMean: 90, correctionRate: 71, avgLatencyMs: 4900, avgCostTokens: 19000 };

    const res = await app.request(
      `/api/flm/admin/strategies/compare?a=${a}&b=${b}`
      + `&metricsA=${encodeURIComponent(JSON.stringify(metricsA))}`
      + `&metricsB=${encodeURIComponent(JSON.stringify(metricsB))}`,
    );
    const body = (await res.json()) as any;
    for (const m of body.comparison.metrics) {
      expect(typeof m.name).toBe('string');
      expect(typeof m.a).toBe('number');
      expect(typeof m.b).toBe('number');
      expect(typeof m.delta).toBe('number');
      expect(['improved', 'regressed', 'neutral']).toContain(m.verdict);
    }
  });
});

describe('策略版本单查仍可用（确认 compare 不是靠吃掉 :versionId 实现）', () => {
  test('按真实 version_id 查询返回该版本', async () => {
    const id = makeStrategy('单查版本');
    const res = await app.request(`/api/flm/admin/strategies/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).strategy.version_id).toBe(id);
  });

  test('不存在的 version_id 返回 404', async () => {
    const res = await app.request('/api/flm/admin/strategies/ver_does_not_exist');
    expect(res.status).toBe(404);
  });
});

describe('门禁与灰度路由（TC-FLM-21/22）', () => {
  test('劣化候选过门禁被拦截', async () => {
    const id = makeStrategy('门禁劣化版');
    const res = await post(
      {
        baseline: { successRate: 90, satisfaction: 85, qualityMean: 88, correctionRate: 70, avgLatencyMs: 5000, avgCostTokens: 20000 },
        candidate: { successRate: 60, satisfaction: 50, qualityMean: 55, correctionRate: 40, avgLatencyMs: 12000, avgCostTokens: 40000 },
      },
      `/api/flm/admin/strategies/${encodeURIComponent(id)}/gate`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.report.gateStatus).toBe('blocked');
    expect(body.report.degradations.some((d: any) => d.breached)).toBe(true);
  });

  test('合格候选灰度 10% 后状态为 canary 且比例生效', async () => {
    const id = makeStrategy('门禁合格版');
    const m = { successRate: 92, satisfaction: 86, qualityMean: 89, correctionRate: 72, avgLatencyMs: 4800, avgCostTokens: 19500 };
    const gate = await post({ baseline: m, candidate: m }, `/api/flm/admin/strategies/${encodeURIComponent(id)}/gate`);
    expect((await gate.json() as any).report.gateStatus).toBe('passed');

    const canary = await post({ ratio: 10 }, `/api/flm/admin/strategies/${encodeURIComponent(id)}/canary`);
    expect(canary.status).toBe(200);

    const detail = await app.request(`/api/flm/admin/strategies/${encodeURIComponent(id)}`);
    const s = (await detail.json() as any).strategy;
    expect(s.status).toBe('canary');
    expect(s.gray_ratio).toBe(10);
  });
});
