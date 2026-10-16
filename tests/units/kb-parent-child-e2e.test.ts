// 父子分块端到端：真实上传 → 真实入库 → 真实落库校验。
//
// 这一组用例的存在理由：分块器的 13 条单测全绿，也证明不了"父块真的没被写进向量表"。
// 那是个落库行为，只有把流水线真跑一遍、再直接查 kb_chunks / kb_chunks_vec 才能证明。
//
// 最关键的一条断言是「父块不得出现在 kb_chunks_vec 中」—— 若父块被向量化，
// 检索会被大块稀释，而这在接口层面完全看不出来。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-pc-e2e-'));
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
    const as = c.req.header('x-test-user');
    c.set('user', { id: as || 'u-owner', username: as || 'owner', role: 'user' });
    await next();
  },
  adminRoleMiddleware: async (_c: any, next: any) => {
    await next();
  },
}));

const { initDatabase, listChunksForDocument, listUnembeddedChunksForDocument } = await import(
  '../../src/db.js'
);
const { default: kbRoutes } = await import('../../src/routes/paas-knowledge-bases.js');

const app = new Hono();
app.route('/api/paas/knowledge-bases', kbRoutes);
const BASE = '/api/paas/knowledge-bases';

let probeDb: Database.Database | null = null;

function req(method: string, url: string, body?: unknown, user = 'u-owner'): Promise<Response> {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * 生成 markdown，每个 section 都**大于子块尺寸 384**，从而每个父块会被真分裂出
 * 多个子块、进而产生父行。
 *
 * 这里的 section 尺寸是有讲究的：heading 策略按标题边界切分，section 若小于
 * 384，父块的 content 就等于唯一子块的 content，真分裂不成立，按 WeKnora
 * 语义 2 就不建父行（见下一条用例）。夹具必须让 section 大于子块尺寸，
 * 否则测的根本不是父子分块。
 */
function longDoc(sections = 14, bodyRepeat = 150): string {
  const parts: string[] = ['# 平台运维手册', ''];
  for (let i = 1; i <= sections; i++) {
    parts.push(`## 第 ${i} 章 主题${i}`, '');
    parts.push(`正文${i}：${'这是第'.repeat(bodyRepeat)}${i}章的内容。`, '');
  }
  return parts.join('\n');
}

async function createKb(name: string): Promise<string> {
  const res = await req('POST', BASE, { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).knowledge_base.id as string;
}

async function upload(kbId: string, filename: string, content: string, withParentChild: boolean) {
  const fd = new FormData();
  fd.set('file', new File([content], filename, { type: 'text/plain' }));
  if (withParentChild) fd.set('parent_child', 'true');
  const res = await app.request(`${BASE}/${kbId}/documents`, {
    method: 'POST',
    headers: { 'x-test-user': 'u-owner' },
    body: fd,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).document.id as string;
}

async function waitForIngest(docId: string, timeoutMs = 20_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await req('GET', `${BASE}/documents/${docId}`);
    const doc = ((await res.json()) as any).document;
    if (doc?.parse_status === 'ready' || doc?.parse_status === 'failed') return doc;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Ingestion for ${docId} did not reach a terminal state`);
}

async function docContent(docId: string): Promise<string> {
  const res = await req('GET', `${BASE}/documents/${docId}/content`);
  return ((await res.json()) as any).content as string;
}

/** 父块 id 是否出现在向量表里。表可能不存在（无 embedding 配置时仍然会被创建）。 */
function vecHasChunk(chunkId: string): boolean {
  if (!probeDb) throw new Error('probeDb not ready');
  const exists = probeDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_chunks_vec'")
    .get();
  if (!exists) return false;
  const row = probeDb.prepare('SELECT chunk_id FROM kb_chunks_vec WHERE chunk_id = ?').get(chunkId);
  return row !== undefined;
}

beforeAll(async () => {
  await initDatabase();
  probeDb = new Database(path.join(tmpStoreDir, 'messages.db'));
  // kb_chunks_vec 是 vec0 虚表，不加载扩展连 SELECT 都会报 "no such module"。
  // 主连接在 initDatabase() 里做的同一件事，这里照做。
  const sqliteVec = createRequire(import.meta.url)('sqlite-vec');
  sqliteVec.load(probeDb);
});

afterAll(() => {
  probeDb?.close();
});

describe('父子分块 — 端到端行为', () => {
  test('开启 parent_child 后落库产生 parent_text 父块，且父块不进向量表', async () => {
    const kbId = await createKb('pc-on');
    const docId = await upload(kbId, 'ops.md', longDoc(), true);
    const doc = await waitForIngest(docId);
    expect(doc.parse_status).toBe('ready');

    const rows = listChunksForDocument(docId);
    expect(rows.length).toBeGreaterThan(2);

    const parents = rows.filter((r) => r.chunk_type === 'parent_text');
    expect(parents.length).toBeGreaterThan(0);

    // 核心断言 ①：嵌入器拿到的候选集里**绝不能有父块**。
    // 这是"父块不参与 embedding"的实际机制——比查向量表更有说服力，因为它不依赖
    // 测试环境是否配了 embedding provider（没配时向量表本来就是空的，查了等于没查）。
    const candidates = listUnembeddedChunksForDocument(docId).map((c) => c.id);
    const parentIds = new Set(parents.map((p) => p.id));
    for (const id of candidates) {
      expect(parentIds.has(id)).toBe(false);
    }
    // 且候选集非空——否则上一条断言也是平凡成立的
    expect(candidates.length).toBeGreaterThan(0);

    // 核心断言 ②：父块也不在向量表里（防的是绕过候选集直接写向量的其它路径）。
    for (const p of parents) {
      expect(vecHasChunk(p.id)).toBe(false);
      expect(p.embedding).toBeNull();
    }
  });

  test('子块通过 parent_chunk_id 回指父块，且区间落在父块内', async () => {
    const kbId = await createKb('pc-link');
    const docId = await upload(kbId, 'ops.md', longDoc(), true);
    await waitForIngest(docId);

    const rows = listChunksForDocument(docId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const children = rows.filter((r) => r.parent_chunk_id !== null);
    expect(children.length).toBeGreaterThan(0);

    for (const child of children) {
      const parent = byId.get(child.parent_chunk_id!);
      expect(parent).toBeDefined();
      expect(parent!.chunk_type).toBe('parent_text');
      expect(parent!.doc_id).toBe(child.doc_id);
      expect(child.start_at).toBeGreaterThanOrEqual(parent!.start_at);
      expect(child.end_at).toBeLessThanOrEqual(parent!.end_at);
    }
  });

  test('全部块（含父块）满足引用可核验的不变式 content === 源文本切片', async () => {
    const kbId = await createKb('pc-offsets');
    const docId = await upload(kbId, 'ops.md', longDoc(), true);
    await waitForIngest(docId);

    const text = await docContent(docId);
    const rows = listChunksForDocument(docId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(text.slice(r.start_at, r.end_at)).toBe(r.content);
    }
  });

  test('短文档未发生真分裂，不产生父块行', async () => {
    const kbId = await createKb('pc-short');
    const docId = await upload(kbId, 'tiny.md', '# 标题\n\n很短的一段正文。\n', true);
    await waitForIngest(docId);

    const rows = listChunksForDocument(docId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.chunk_type === 'parent_text')).toHaveLength(0);
  });

  // WeKnora 语义 2 的端到端体现：heading 策略按标题边界切分，当每个 section 都
  // 小于子块尺寸时，父块 content 与唯一子块完全相同，再建父行纯属冗余。
  // 这条用例锁定"不建冗余父行"这个行为本身。
  test('section 小于子块尺寸时不产生冗余父行（语义 2）', async () => {
    const kbId = await createKb('pc-noredundant');
    const docId = await upload(kbId, 'fine.md', longDoc(14, 40), true);
    await waitForIngest(docId);

    const rows = listChunksForDocument(docId);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.chunk_type === 'parent_text')).toHaveLength(0);
    // 且这些块确实是普通块，不是"父块没标出来"
    for (const r of rows) {
      expect(r.chunk_type).toBe('text');
      expect(r.parent_chunk_id).toBeNull();
    }
  });

  test('未开启 parent_child 时行为不变：全部是普通块', async () => {
    const kbId = await createKb('pc-default');
    const docId = await upload(kbId, 'ops.md', longDoc(), false);
    await waitForIngest(docId);

    const rows = listChunksForDocument(docId);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
      expect(r.chunk_type).toBe('text');
      expect(r.parent_chunk_id).toBeNull();
    }
  });

  test('兄弟链只在普通块之间建立，不把父块链进来', async () => {
    const kbId = await createKb('pc-siblings');
    const docId = await upload(kbId, 'ops.md', longDoc(), true);
    await waitForIngest(docId);

    const rows = listChunksForDocument(docId);
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const r of rows) {
      if (r.pre_chunk_id) {
        expect(byId.get(r.pre_chunk_id)?.chunk_type).toBe('text');
      }
      if (r.next_chunk_id) {
        expect(byId.get(r.next_chunk_id)?.chunk_type).toBe('text');
      }
    }
  });
});
