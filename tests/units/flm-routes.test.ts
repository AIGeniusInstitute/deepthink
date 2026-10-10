// FLM 环境观测点 / 快照路由单测（PRD F1.3、AC-F1.3.1 – AC-F1.3.3、TC-FLM-08/09）。
//
// 这一组用例的存在理由：`captureSnapshot` / `diffSnapshots` 在库里写得再对，
// 只要没有 HTTP 出口，业务侧就永远用不上 —— 库函数单测覆盖不到"接口到底通不通"。
// 所以这里真的挂一个 Hono app 发请求，并回查 flm_events 确认事件真的落库了。

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-routes-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDir,
}));

vi.mock('../../src/middleware/auth.js', () => ({
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
const { writeConfig, readConfig } = await import('../../src/flm/flm-config.js');
const { listObservations, deleteObservation, listEventsByTask } = await import('../../src/flm/flm-db.js');

const app = new Hono();
app.route('/api/flm', flmRoutes);

const TASK = 'turn:env-route-test';

function json(body: unknown, method = 'POST', url = '') {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function registerObservation(name: string, p: string, expected: string | null) {
  const res = await json({ name, path: p, expected }, 'POST', '/api/flm/admin/observations');
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  // 用例之间必须隔离：上一条用例注册的观测点会让"未注册时提交快照被拒"假通过，
  // 关掉开关的用例也会让后面的降级断言全部失真。
  writeConfig({ ...readConfig(), enabled: true }, 'test');
  for (const o of listObservations()) deleteObservation(o.id);
});

describe('对照：未实现的路由确实 404', () => {
  // 若没有这条，上面所有 `toBe(200)` 都无法证明"路由真挂上了"——挂错了前缀
  // 或者 app.route 失效时，Hono 一样会返回 404 而断言早已失败，但读者看不出
  // 这组用例到底有没有区分能力。这里用一个不存在的路径把区分能力钉住。
  test('不存在的 admin 路径返回 404', async () => {
    const res = await app.request('/api/flm/admin/observations-not-implemented');
    expect(res.status).toBe(404);
  });
});

describe('环境观测点注册（AC-F1.3.1 / TC-FLM-08）', () => {
  test('注册后出现在列表中，且带名称/路径/期望值', async () => {
    const before = (await (await app.request('/api/flm/admin/observations')).json() as any).observations.length;

    const { id } = await registerObservation('订单状态', 'order.status', 'paid');
    expect(id).toMatch(/^obs_/);

    const after = (await (await app.request('/api/flm/admin/observations')).json() as any).observations;
    expect(after.length).toBe(before + 1);

    const mine = after.find((o: any) => o.id === id);
    expect(mine.name).toBe('订单状态');
    expect(mine.path).toBe('order.status');
    expect(mine.expected).toBe('paid');
    expect(mine.enabled).toBe(1);
  });

  test('缺 name 或 path 时拒绝（400），不写库', async () => {
    const before = listObservations().length;
    expect((await json({ path: 'a.b' }, 'POST', '/api/flm/admin/observations')).status).toBe(400);
    expect((await json({ name: '只有名字' }, 'POST', '/api/flm/admin/observations')).status).toBe(400);
    expect(listObservations().length).toBe(before);
  });

  test('期望值可留空 —— 表示只观测不判定', async () => {
    const { id } = await registerObservation('仅观测', 'x.y', null);
    const mine = listObservations().find((o) => o.id === id);
    expect(mine?.expected).toBeNull();
  });

  test('删除后从列表消失', async () => {
    const { id } = await registerObservation('待删除', 'z.z', '1');
    const res = await app.request(`/api/flm/admin/observations/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
    expect(listObservations().find((o) => o.id === id)).toBeUndefined();
  });
});

describe('前后快照 diff（AC-F1.3.2 / TC-FLM-09）', () => {
  test('未注册观测点时提交快照被拒 —— 没人关心的快照只会污染 diff', async () => {
    const res = await json({ taskId: TASK, phase: 'before', values: {} }, 'POST', '/api/flm/admin/snapshots');
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('观测点');
  });

  test('取值以 path 为键，落库以 name 为键；未提供的观测点记为 null', async () => {
    await registerObservation('订单状态', 'order.status', 'paid');
    await registerObservation('库存量', 'stock.qty', null);

    const res = await json(
      { taskId: TASK, phase: 'before', values: { 'order.status': 'pending' } },
      'POST', '/api/flm/admin/snapshots',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.snapshotId).toMatch(/^snap_/);
    expect(body.values['订单状态']).toBe('pending');
    expect(body.values['库存量']).toBeNull();
  });

  test('落后于期望值 → verdict=unmet，并产出 source=env 事件', async () => {
    const task = `${TASK}:unmet`;
    await registerObservation('订单状态', 'order.status', 'paid');

    await json({ taskId: task, phase: 'before', values: { 'order.status': 'pending' } }, 'POST', '/api/flm/admin/snapshots');
    await json({ taskId: task, phase: 'after', values: { 'order.status': 'pending' } }, 'POST', '/api/flm/admin/snapshots');

    const res = await json(undefined, 'POST', `/api/flm/admin/snapshots/${encodeURIComponent(task)}/diff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.verdict).toBe('unmet');
    expect(body.unmet).toContain('订单状态');
    expect(body.inserted).toBe(true);

    const events = listEventsByTask(task).filter((e) => e.source === 'env');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('env_snapshot_diff');
  });

  test('达到期望值 → verdict=met', async () => {
    const task = `${TASK}:met`;
    await registerObservation('订单状态', 'order.status', 'paid');

    await json({ taskId: task, phase: 'before', values: { 'order.status': 'pending' } }, 'POST', '/api/flm/admin/snapshots');
    await json({ taskId: task, phase: 'after', values: { 'order.status': 'paid' } }, 'POST', '/api/flm/admin/snapshots');

    const body = (await (await json(undefined, 'POST', `/api/flm/admin/snapshots/${encodeURIComponent(task)}/diff`)).json()) as any;
    expect(body.verdict).toBe('met');
    expect(body.changed).toContainEqual({ name: '订单状态', before: 'pending', after: 'paid' });
  });

  test('没有期望值的观测点不参与判定 → verdict=unknown', async () => {
    const task = `${TASK}:unknown`;
    await registerObservation('仅观测', 'only.watch', null);

    await json({ taskId: task, phase: 'before', values: { 'only.watch': '1' } }, 'POST', '/api/flm/admin/snapshots');
    await json({ taskId: task, phase: 'after', values: { 'only.watch': '2' } }, 'POST', '/api/flm/admin/snapshots');

    const body = (await (await json(undefined, 'POST', `/api/flm/admin/snapshots/${encodeURIComponent(task)}/diff`)).json()) as any;
    expect(body.verdict).toBe('unknown');
  });

  test('缺一侧快照时 diff 返回 404 —— 半个快照得不出结论', async () => {
    const task = `${TASK}:half`;
    await registerObservation('订单状态', 'order.status', 'paid');
    await json({ taskId: task, phase: 'before', values: { 'order.status': 'pending' } }, 'POST', '/api/flm/admin/snapshots');

    const res = await json(undefined, 'POST', `/api/flm/admin/snapshots/${encodeURIComponent(task)}/diff`);
    expect(res.status).toBe(404);
  });

  test('phase 非法值被拒（400）', async () => {
    await registerObservation('订单状态', 'order.status', 'paid');
    const res = await json({ taskId: TASK, phase: 'during', values: {} }, 'POST', '/api/flm/admin/snapshots');
    expect(res.status).toBe(400);
  });

  test('FLM 关闭时快照与 diff 均降级返回，不报错（AC-F0.1）', async () => {
    writeConfig({ ...readConfig(), enabled: false }, 'test');

    const snap = await json({ taskId: TASK, phase: 'before', values: {} }, 'POST', '/api/flm/admin/snapshots');
    expect(snap.status).toBe(200);
    expect((await snap.json() as any).degraded).toBe(true);

    const diff = await json(undefined, 'POST', `/api/flm/admin/snapshots/${encodeURIComponent(TASK)}/diff`);
    expect(diff.status).toBe(200);
    expect((await diff.json() as any).degraded).toBe(true);
  });
});
