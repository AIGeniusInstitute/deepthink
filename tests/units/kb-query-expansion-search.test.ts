// 查询扩展接进检索链路后的行为。
//
// 纯函数单测证明不了"召回不足时才触发、且只走关键词臂"——那两条都是 searchChunks
// 里的控制流。这里用真库真文档跑出来。
//
// 夹具的关键点：`buildChunkFtsQuery` 把没有分隔符的中文整串当成**一个短语**查询
// （每个 term 加引号，trigram 分词器），短语的前三个字不在文档里整条就匹配不上；
// 匹配不上时 keywordSearchChunks 会回退到 instr() 子串扫描，仍要求整串是子串。
// 所以只要让"原始查询"不是文档的子串、而"扩展变体"是，就能稳定造出"首轮召回为 0、
// 扩展后命中"的场景，不需要依赖任何模型或阈值。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-qe-'));
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

const { initDatabase } = await import('../../src/db.js');
const { searchChunks } = await import('../../src/kb/search.js');
const { default: kbRoutes } = await import('../../src/routes/paas-knowledge-bases.js');

const app = new Hono();
app.route('/api/paas/knowledge-bases', kbRoutes);
const BASE = '/api/paas/knowledge-bases';

/**
 * 文档含 "配置向量数据库索引参数"，但**不含** "如何配置向量数据库索引参数"。
 * 于是原始查询整串子串扫描为 0，而剥掉疑问词后的变体是文档的子串。
 */
const DOC = [
  '# 向量数据库运维',
  '',
  '配置向量数据库索引参数时，需要同时考虑分片数量与副本因子。索引参数配置不当会显著拖慢查询。',
  '',
].join('\n');

const QUERY = '如何配置向量数据库索引参数';
const VARIANT = '配置向量数据库索引参数';

let kbId = '';

function req(method: string, url: string, body?: unknown): Promise<Response> {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'u-owner' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  await initDatabase();
  const created = await req('POST', BASE, { name: 'qe-kb' });
  expect(created.status).toBe(201);
  kbId = ((await created.json()) as any).knowledge_base.id;

  const fd = new FormData();
  fd.set('file', new File([DOC], 'ops.md', { type: 'text/plain' }));
  const up = await app.request(`${BASE}/${kbId}/documents`, {
    method: 'POST',
    headers: { 'x-test-user': 'u-owner' },
    body: fd,
  });
  expect(up.status).toBe(201);
  const docId = ((await up.json()) as any).document.id;

  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await req('GET', `${BASE}/documents/${docId}`);
    const doc = ((await res.json()) as any).document;
    if (doc?.parse_status === 'ready') break;
    if (doc?.parse_status === 'failed') throw new Error(`ingest failed: ${doc.parse_error}`);
    if (Date.now() > deadline) throw new Error('ingest timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('查询扩展 — 检索链路行为', () => {
  test('前置条件：原始查询首轮召回为 0，扩展变体是文档的子串', async () => {
    // 这两条前提若不成立，下面几条用例会平凡通过，所以先钉死。
    const { hits } = await searchChunks({ kbIds: [kbId], query: QUERY, limit: 5, mode: 'keyword' });
    expect(hits).toHaveLength(0);

    const { hits: variantHits } = await searchChunks({
      kbIds: [kbId],
      query: VARIANT,
      limit: 5,
      mode: 'keyword',
    });
    expect(variantHits.length).toBeGreaterThan(0);
  });

  test('开启扩展：召回不足时补上关键词臂命中，并在 debug 里报出变体', async () => {
    const { hits, debug } = await searchChunks({
      kbIds: [kbId],
      query: QUERY,
      limit: 5,
      mode: 'keyword',
      enableQueryExpansion: true,
      debug: true,
    });

    expect(debug!.expansion_variants).toEqual([VARIANT]);
    expect(debug!.expansion_added).toBeGreaterThan(0);
    expect(hits.length).toBeGreaterThan(0);
    // 扩展变体只加关键词召回，不重复向量臂
    for (const h of hits) expect(h.source).toBe('keyword');
    expect(debug!.expansion_concurrency_cap).toBe(16);
  });

  test('关闭扩展：同一查询召回仍为 0（证明上一条的命中确实来自扩展）', async () => {
    const { hits, debug } = await searchChunks({
      kbIds: [kbId],
      query: QUERY,
      limit: 5,
      mode: 'keyword',
      enableQueryExpansion: false,
      debug: true,
    });
    expect(hits).toHaveLength(0);
    expect(debug!.expansion_variants).toEqual([]);
    expect(debug!.expansion_added).toBe(0);
  });

  test('召回已足够时不触发扩展（WeKnora: len(SearchResult) < max(1, EmbeddingTopK)）', async () => {
    // VARIANT 本身能命中，limit=1 时首轮就满了
    const { hits, debug } = await searchChunks({
      kbIds: [kbId],
      query: VARIANT,
      limit: 1,
      mode: 'keyword',
      enableQueryExpansion: true,
      debug: true,
    });
    expect(hits.length).toBe(1);
    expect(debug!.expansion_variants).toEqual([]);
  });

  test('mode=vector 时不做扩展（上游同样在关键词匹配关闭时直接返回）', async () => {
    const { hits, debug } = await searchChunks({
      kbIds: [kbId],
      query: QUERY,
      limit: 5,
      mode: 'vector',
      // 无 embedding 配置，vector 臂降级；关键是扩展不得介入
      queryEmbedding: null,
      enableQueryExpansion: true,
      debug: true,
    });
    expect(hits).toHaveLength(0);
    expect(debug!.expansion_variants).toEqual([]);
  });

  test('扩展结果不重复已有命中', async () => {
    const { hits } = await searchChunks({
      kbIds: [kbId],
      query: QUERY,
      limit: 5,
      mode: 'keyword',
      enableQueryExpansion: true,
    });
    const ids = hits.map((h) => h.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('查询扩展 — 路由开关', () => {
  test('enable_query_expansion 经 /search 透传，debug 可观测', async () => {
    const res = await req('POST', `${BASE}/${kbId}/search`, {
      query: QUERY,
      mode: 'keyword',
      top_k: 5,
      enable_query_expansion: true,
      debug: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.debug.expansion_variants).toContain(VARIANT);
    expect(body.hits.length).toBeGreaterThan(0);
  });

  test('默认不开（对齐 WeKnora conversation.enable_query_expansion 未设置即为 false）', async () => {
    const res = await req('POST', `${BASE}/${kbId}/search`, {
      query: QUERY,
      mode: 'keyword',
      top_k: 5,
      debug: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.debug.expansion_variants).toEqual([]);
    expect(body.hits).toHaveLength(0);
  });
});
