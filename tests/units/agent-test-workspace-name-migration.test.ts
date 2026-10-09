/**
 * Agent 测试工作区名字迁移（去掉 "测试: " 前缀）——后端单元测试。
 *
 * 关键断言不是"名字变干净了"，而是**jid 与 folder 一个字都没动**：这正是选轻量方案
 * 的全部理由（改 jid 会牵连 messages→chats 外键与十余张引用表）。若将来有人把它
 * "顺手"升级成彻底迁移，下面的断言会先失败。
 *
 * 点 DEEPTHINK_DATA_DIR 到临时目录再 import db.ts，让 initDatabase() 建隔离库。
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// vi.hoisted 会先于 ESM import 执行，保证 config.ts 读到的是临时目录而不是生产库。
const tmpDir = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-name-migration-'));
  process.env.DEEPTHINK_DATA_DIR = dir;
  return dir;
});

import {
  initDatabase,
  getDb,
  getRegisteredGroup,
  setRegisteredGroup,
  updateChatName,
  migrateAgentTestWorkspaceNames,
} from '../../src/db.js';

const LEGACY_JID = 'web:agent-test-11111111-1111-1111-1111-111111111111';
const LEGACY_FOLDER = 'agent-test-11111111-1111-1111-1111-111111111111';
// 已迁移的新形态工作区：不该被本次迁移碰
const NEW_JID = 'web:agent-22222222-2222-2222-2222-222222222222';
const NEW_FOLDER = 'agent-22222222-2222-2222-2222-222222222222';
// 旧 jid 但名字已经干净的（历史手工改过）：应幂等跳过
const ALREADY_CLEAN_JID = 'web:agent-test-33333333-3333-3333-3333-333333333333';

function chatName(jid: string): string | undefined {
  const row = getDb().prepare('SELECT name FROM chats WHERE jid = ?').get(jid) as
    | { name: string }
    | undefined;
  return row?.name;
}

beforeAll(() => {
  initDatabase();

  setRegisteredGroup(LEGACY_JID, {
    name: '测试: MedDRA 转 WHODrug',
    folder: LEGACY_FOLDER,
    added_at: new Date().toISOString(),
  });
  updateChatName(LEGACY_JID, '测试: MedDRA 转 WHODrug');

  setRegisteredGroup(NEW_JID, {
    name: 'AI 大模型智能体论文写作专家',
    folder: NEW_FOLDER,
    added_at: new Date().toISOString(),
  });
  updateChatName(NEW_JID, 'AI 大模型智能体论文写作专家');

  setRegisteredGroup(ALREADY_CLEAN_JID, {
    name: '已经改过名字的 Agent',
    folder: 'agent-test-33333333-3333-3333-3333-333333333333',
    added_at: new Date().toISOString(),
  });
  updateChatName(ALREADY_CLEAN_JID, '已经改过名字的 Agent');
});

afterAll(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrateAgentTestWorkspaceNames', () => {
  test('去掉 "测试: " 前缀，只命中带前缀的旧工作区', () => {
    // 只有 LEGACY_JID 一条符合（旧 jid + 带前缀）
    expect(migrateAgentTestWorkspaceNames()).toBe(1);

    expect(getRegisteredGroup(LEGACY_JID)?.name).toBe('MedDRA 转 WHODrug');
    expect(chatName(LEGACY_JID)).toBe('MedDRA 转 WHODrug');
  });

  test('jid 与 folder 保持原样（轻量方案的核心约束）', () => {
    const group = getRegisteredGroup(LEGACY_JID);
    expect(group).toBeDefined();
    expect(group?.folder).toBe(LEGACY_FOLDER);
    // 旧 jid 仍然可查——它没被改名成 web:agent-{id}
    expect(getDb().prepare('SELECT jid FROM registered_groups WHERE jid = ?').get(LEGACY_JID)).toBeDefined();
    expect(getDb().prepare('SELECT jid FROM chats WHERE jid = ?').get(LEGACY_JID)).toBeDefined();
  });

  test('新形态工作区不受影响', () => {
    expect(getRegisteredGroup(NEW_JID)?.name).toBe('AI 大模型智能体论文写作专家');
    expect(getRegisteredGroup(NEW_JID)?.folder).toBe(NEW_FOLDER);
    expect(chatName(NEW_JID)).toBe('AI 大模型智能体论文写作专家');
  });

  test('名字已干净的旧工作区不被再次裁剪', () => {
    expect(getRegisteredGroup(ALREADY_CLEAN_JID)?.name).toBe('已经改过名字的 Agent');
  });

  test('幂等：再跑一次返回 0 且不改动任何名字', () => {
    expect(migrateAgentTestWorkspaceNames()).toBe(0);
    expect(getRegisteredGroup(LEGACY_JID)?.name).toBe('MedDRA 转 WHODrug');
    expect(chatName(LEGACY_JID)).toBe('MedDRA 转 WHODrug');
  });
});
