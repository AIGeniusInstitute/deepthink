// 既有库的迁移路径回归。
//
// 这个文件的存在理由：P1 给 kb_chunks 加了 parent_chunk_id 列。全新库走
// CREATE TABLE 带出新列，一切正常；但**既有库**的 kb_chunks 已经存在，
// CREATE TABLE IF NOT EXISTS 是空操作、不会补列。若索引语句写在建表块里，
// 它会在 ensureColumn 迁移之前执行，既有库启动即 "no such column" 崩溃。
//
// 这个 bug 真的发生过：它只在用持久化 DB 文件的测试里暴露，全新临时库的测试
// 全部通过。所以这里刻意**先手工造一个缺列的旧库**，再跑 initDatabase。
//
// 断言的不只是"不抛异常"，还包括"列真的补上了、索引真的建上了、存量数据没丢"。

import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-migrate-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDir,
}));

const DB_PATH = path.join(tmpStoreDir, 'messages.db');

/** 造一个 P1 之前的 kb_chunks：**没有** parent_chunk_id，且已有一条存量数据。 */
function seedLegacyDb(): void {
  const legacy = new Database(DB_PATH);
  legacy.exec(`
    CREATE TABLE kb_chunks (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      heading_path TEXT,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      pre_chunk_id TEXT,
      next_chunk_id TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      chunk_type TEXT NOT NULL DEFAULT 'text',
      embedding BLOB,
      embedding_model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy
    .prepare(
      `INSERT INTO kb_chunks (id, kb_id, doc_id, user_id, chunk_index, content,
        content_hash, heading_path, start_at, end_at, pre_chunk_id, next_chunk_id,
        is_enabled, chunk_type, created_at, updated_at)
       VALUES ('legacy-1','kb-1','doc-1','u-1',0,'存量内容','h','A > B',0,12,NULL,NULL,1,'text','t','t')`,
    )
    .run();
  legacy.close();
}

let probe: Database.Database | null = null;

afterAll(() => {
  probe?.close();
});

describe('kb_chunks.parent_chunk_id 迁移', () => {
  test('既有库（无 parent_chunk_id 列）启动成功，且列与索引都被补上', async () => {
    seedLegacyDb();

    // 迁移前先确认前提成立：库里确实没有这一列。
    const before = new Database(DB_PATH, { readonly: true });
    const colsBefore = (before.prepare('PRAGMA table_info(kb_chunks)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    before.close();
    expect(colsBefore).not.toContain('parent_chunk_id');

    const { initDatabase } = await import('../../src/db.js');
    // 修复前这里会抛 SqliteError: no such column: parent_chunk_id
    expect(() => initDatabase()).not.toThrow();

    probe = new Database(DB_PATH);
    const colsAfter = (probe.prepare('PRAGMA table_info(kb_chunks)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(colsAfter).toContain('parent_chunk_id');

    const idx = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_kb_chunks_parent'")
      .get();
    expect(idx).toBeDefined();
  });

  test('存量数据在迁移后完好，且 parent_chunk_id 为 NULL（无需回填）', async () => {
    const row = probe!
      .prepare('SELECT * FROM kb_chunks WHERE id = ?')
      .get('legacy-1') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.content).toBe('存量内容');
    expect(row.heading_path).toBe('A > B');
    expect(row.parent_chunk_id).toBeNull();
  });
});
