/**
 * 工作区目录支持选择用户本机目录（custom_cwd 全模式 + PATCH 可改）：
 *
 *  ① resolveWorkspaceRoot / resolveScriptCwd —— 工作区根目录解析的唯一规则
 *     （customCwd 优先，脚本任务 cwd 不再落回 data/groups/{folder}）。
 *  ② POST /api/groups —— custom_cwd 在 container / host 两模式通用；
 *     与 init_source_path/init_git_url 互斥；绝对路径/存在/白名单/敏感黑名单/
 *     DATA_DIR 内部四道校验；member 403。
 *  ③ PATCH /api/groups/:jid —— 创建后可改可清（null 与空串），校验链与
 *     创建一致；home 容器允许改目录（执行模式仍禁改）。
 *  ④ buildVolumeMounts —— container 模式 /workspace/group 的挂载源即
 *     resolveWorkspaceRoot（本机目录 bind-mount）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.DEEPTHINK_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deepthink-ws-custom-dir-'));
    process.env.DEEPTHINK_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;
// 允许挂载的根（工作区 fixture 都放这里）与白名单文件都在独立目录，
// 避免与 DATA_DIR=SHARED_TMP 重叠触发「DATA_DIR 内部」拒绝规则。
const WS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deepthink-ws-root-'));
const ALLOWLIST_PATH = path.join(SHARED_TMP, 'mount-allowlist.json');

fs.writeFileSync(
  ALLOWLIST_PATH,
  JSON.stringify({
    allowedRoots: [{ path: WS_ROOT, readOnly: false }],
    blockedPatterns: [],
    nonMainReadOnly: false,
  }),
  'utf-8',
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.DEEPTHINK_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
    MOUNT_ALLOWLIST_PATH: path.join(dataDir, 'mount-allowlist.json'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.DEEPTHINK_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.DEEPTHINK_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

// groups.ts statically imports these from web.js; mock them so importing the
// route module doesn't pull in the full Hono app + every route's middleware.
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');
const workspaceRoot = await import('../src/workspace-root.js');
const scriptRunner = await import('../src/script-runner.js');
const containerRunner = await import('../src/container-runner.js');

const groupRoutes = groupRoutesModule.default;

const OWNER_ID = 'alice';
const ADMIN_ID = 'zadmin';

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.DEEPTHINK_TEST_USER_ID = userId;
  process.env.DEEPTHINK_TEST_USER_ROLE = role;
}

// Persistent stub cache — stable across getRegisteredGroups() calls.
const webDepsCache: Record<string, unknown> = {};

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  webContext.setWebDeps({
    getRegisteredGroups: () => webDepsCache,
    ensureTerminalContainerStarted: () => {},
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterEach(() => {
  delete process.env.DEEPTHINK_TEST_USER_ID;
  delete process.env.DEEPTHINK_TEST_USER_ROLE;
});

function makeDir(name: string): string {
  const dir = path.join(WS_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

async function postGroup(body: Record<string, unknown>) {
  return groupRoutes.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchGroup(jid: string, body: Record<string, unknown>) {
  return groupRoutes.request(`/${encodeURIComponent(jid)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const createdJids: string[] = [];

async function createGroupWithCustomCwd(
  customCwd: string,
  executionMode: 'container' | 'host' = 'container',
): Promise<string> {
  const res = await postGroup({
    name: `ws-${Math.random().toString(36).slice(2, 8)}`,
    execution_mode: executionMode,
    custom_cwd: customCwd,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { jid: string };
  createdJids.push(data.jid);
  return data.jid;
}

afterEach(() => {
  while (createdJids.length) {
    const jid = createdJids.pop()!;
    const group = db.getRegisteredGroup(jid);
    if (group) {
      delete webDepsCache[jid];
      db.deleteGroupData(jid, group.folder);
    }
  }
});

describe('resolveWorkspaceRoot / resolveScriptCwd', () => {
  test('默认回落 data/groups/{folder}', () => {
    expect(workspaceRoot.resolveWorkspaceRoot({ folder: 'flow-x' })).toBe(
      path.join(tmpDataDir, 'groups', 'flow-x'),
    );
  });

  test('customCwd 优先（与执行模式无关）', () => {
    const dir = makeDir('proj-a');
    expect(
      workspaceRoot.resolveWorkspaceRoot({
        folder: 'flow-x',
        customCwd: dir,
      }),
    ).toBe(dir);
  });

  test('resolveScriptCwd 对 customCwd 组返回本机目录，无注册时回落默认目录', () => {
    const dir = makeDir('proj-script');
    const jid = `web:${crypto.randomUUID()}`;
    db.setRegisteredGroup(jid, {
      name: 'script-group',
      folder: 'folder-script',
      added_at: new Date().toISOString(),
      executionMode: 'container',
      customCwd: dir,
    } as never);
    webDepsCache[jid] = db.getRegisteredGroup(jid);
    try {
      expect(scriptRunner.resolveScriptCwd('folder-script')).toBe(dir);
      expect(scriptRunner.resolveScriptCwd('folder-not-registered')).toBe(
        path.join(tmpDataDir, 'groups', 'folder-not-registered'),
      );
    } finally {
      delete webDepsCache[jid];
      db.deleteRegisteredGroup(jid);
    }
  });
});

describe('validateCustomCwd 校验链', () => {
  test('相对路径 400', () => {
    const r = workspaceRoot.validateCustomCwd('relative/path');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  test('不存在的目录 400', () => {
    const r = workspaceRoot.validateCustomCwd(path.join(WS_ROOT, 'no-such-dir'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  test('白名单内目录通过并返回 realpath', () => {
    const dir = makeDir('proj-valid');
    const r = workspaceRoot.validateCustomCwd(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.realPath).toBe(dir);
  });

  test('白名单外目录 403', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deepthink-ws-outside-'));
    const r = workspaceRoot.validateCustomCwd(outside);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  test('敏感路径（.ssh）403', () => {
    const secretDir = makeDir(path.join('proj-secret', '.ssh'));
    const r = workspaceRoot.validateCustomCwd(secretDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  test('DATA_DIR 内部路径 400', () => {
    const inside = path.join(tmpDataDir, 'groups', 'flow-inside');
    fs.mkdirSync(inside, { recursive: true });
    const r = workspaceRoot.validateCustomCwd(inside);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain('data directory');
    }
  });
});

describe('POST /api/groups —— custom_cwd 两模式通用', () => {
  beforeEach(() => {
    asUser(ADMIN_ID, 'admin');
  });

  test('容器模式可选本机目录为工作区，落库且回显', async () => {
    const dir = makeDir('proj-container');
    const jid = await createGroupWithCustomCwd(dir);
    const row = db.getRegisteredGroup(jid);
    expect(row?.customCwd).toBe(dir);
    expect(row?.executionMode).toBe('container');
  });

  test('宿主机模式维持既有行为', async () => {
    const dir = makeDir('proj-host');
    const jid = await createGroupWithCustomCwd(dir, 'host');
    expect(db.getRegisteredGroup(jid)?.customCwd).toBe(dir);
  });

  test('custom_cwd 与 init_source_path 互斥 400', async () => {
    const dir = makeDir('proj-mutex');
    const res = await postGroup({
      name: 'mutex',
      execution_mode: 'container',
      custom_cwd: dir,
      init_source_path: dir,
    });
    expect(res.status).toBe(400);
  });

  test('白名单外目录 403', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deepthink-ws-out2-'));
    const res = await postGroup({
      name: 'outside',
      execution_mode: 'container',
      custom_cwd: outside,
    });
    expect(res.status).toBe(403);
  });

  test('member 无权设置 custom_cwd（403）', async () => {
    asUser(OWNER_ID, 'member');
    const dir = makeDir('proj-member');
    const res = await postGroup({
      name: 'member-group',
      execution_mode: 'container',
      custom_cwd: dir,
    });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/groups/:jid —— 创建后可改可清', () => {
  const JID = 'web:patch-cwd';
  const FOLDER = 'patch-cwd';

  beforeEach(() => {
    asUser(ADMIN_ID, 'admin');
    db.setRegisteredGroup(JID, {
      name: 'Patch Cwd',
      folder: FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      // canModifyGroup 对 web 组只认 created_by（admin 不豁免），admin 测试
      // 需要既是 owner 又是 admin；member 用例单独把 created_by 改回 OWNER_ID。
      created_by: ADMIN_ID,
      is_home: false,
    } as never);
    webDepsCache[JID] = db.getRegisteredGroup(JID);
  });

  afterEach(() => {
    delete webDepsCache[JID];
    db.deleteRegisteredGroup(JID);
  });

  test('admin 可设置工作区目录', async () => {
    const dir = makeDir('proj-patch');
    const res = await patchGroup(JID, { custom_cwd: dir });
    expect(res.status).toBe(200);
    expect(db.getRegisteredGroup(JID)?.customCwd).toBe(dir);
  });

  test('null 与空串都表示恢复默认目录', async () => {
    const dir = makeDir('proj-patch-clear');
    await patchGroup(JID, { custom_cwd: dir });
    expect(db.getRegisteredGroup(JID)?.customCwd).toBe(dir);

    expect((await patchGroup(JID, { custom_cwd: null })).status).toBe(200);
    expect(db.getRegisteredGroup(JID)?.customCwd).toBeUndefined();

    await patchGroup(JID, { custom_cwd: dir });
    expect((await patchGroup(JID, { custom_cwd: '' })).status).toBe(200);
    expect(db.getRegisteredGroup(JID)?.customCwd).toBeUndefined();
  });

  test('非法路径被拒绝且原值不变', async () => {
    const dir = makeDir('proj-patch-keep');
    await patchGroup(JID, { custom_cwd: dir });

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deepthink-ws-out3-'));
    expect((await patchGroup(JID, { custom_cwd: outside })).status).toBe(403);
    expect((await patchGroup(JID, { custom_cwd: 'relative/path' })).status).toBe(400);
    expect(db.getRegisteredGroup(JID)?.customCwd).toBe(dir);
  });

  test('member（即使是 owner）无权改工作区目录', async () => {
    // owner 是 member：canModifyGroup 通过，但 custom_cwd 的 admin 门槛拦下
    db.setRegisteredGroup(JID, {
      name: 'Patch Cwd',
      folder: FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
    } as never);
    webDepsCache[JID] = db.getRegisteredGroup(JID);
    asUser(OWNER_ID, 'member');
    const dir = makeDir('proj-patch-member');
    const res = await patchGroup(JID, { custom_cwd: dir });
    expect(res.status).toBe(403);
    expect(db.getRegisteredGroup(JID)?.customCwd).toBeUndefined();
  });

  test('home 容器允许改工作区目录', async () => {
    const homeJid = 'web:home-test';
    db.setRegisteredGroup(homeJid, {
      name: 'Home',
      folder: 'home-test',
      added_at: new Date().toISOString(),
      executionMode: 'host',
      created_by: ADMIN_ID,
      is_home: true,
    } as never);
    webDepsCache[homeJid] = db.getRegisteredGroup(homeJid);
    try {
      const dir = makeDir('proj-home');
      const res = await patchGroup(homeJid, { custom_cwd: dir });
      expect(res.status).toBe(200);
      expect(db.getRegisteredGroup(homeJid)?.customCwd).toBe(dir);

      // 执行模式仍然禁改（既有约束不受本需求影响）
      const modeRes = await patchGroup(homeJid, { execution_mode: 'container' });
      expect(modeRes.status).toBe(403);
    } finally {
      delete webDepsCache[homeJid];
      db.deleteRegisteredGroup(homeJid);
    }
  });
});

describe('buildVolumeMounts —— container 模式挂载源', () => {
  test('customCwd 组的 /workspace/group 挂载本机目录', () => {
    const dir = makeDir('proj-mount');
    const mounts = containerRunner.buildVolumeMounts(
      {
        name: 'mount-group',
        folder: 'folder-mount',
        added_at: new Date().toISOString(),
        executionMode: 'container',
        customCwd: dir,
      } as never,
      false,
    );
    const ws = mounts.find((m) => m.containerPath === '/workspace/group');
    expect(ws?.hostPath).toBe(dir);
  });

  test('默认组维持 data/groups/{folder}', () => {
    const mounts = containerRunner.buildVolumeMounts(
      {
        name: 'default-group',
        folder: 'folder-default',
        added_at: new Date().toISOString(),
        executionMode: 'container',
      } as never,
      false,
    );
    const ws = mounts.find((m) => m.containerPath === '/workspace/group');
    expect(ws?.hostPath).toBe(path.join(tmpDataDir, 'groups', 'folder-default'));
  });
});
