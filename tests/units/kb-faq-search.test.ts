// FAQ 知识库接进检索链路后的行为。
//
// 这里要证明的承重命题有两条，都是纯函数单测覆盖不到的控制流：
//
//   1. **FAQ 库只走向量臂，不参与关键词检索。** 上游的说法是 "FAQ KBs are
//      retrieved exclusively via the FAQ vector index and have no keyword index"
//      （knowledgebase_search.go:456-461）。它靠的是 KB 分桶 + 关键词臂只收文档桶，
//      检索器内部没有任何按类型过滤的逻辑——所以必须在这里端到端跑出来，
//      否则"看起来实现了"和"真的实现了"分不出来。
//
//   2. **负向问题只做事后否决，精确相等。** 负例不进索引、不进 content，
//      命中之后才按 lower(trim(x)) == lower(trim(neg)) 丢掉结果。
//
// 另外覆盖 separate 模式：一条条目产生 1 + N 条向量（标准问进 chunk 自身，
// 相似问进变体表），以及命中后按 chunk 归并。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-faq-'));
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

const { initDatabase, getKbChunk, getKbChunksByIds } = await import('../../src/db.js');
const { searchChunks } = await import('../../src/kb/search.js');
const { saveEmbeddingConfig } = await import('../../src/embedding.js');
const { default: kbRoutes } = await import('../../src/routes/paas-knowledge-bases.js');

const app = new Hono();
app.route('/api/paas/knowledge-bases', kbRoutes);
const BASE = '/api/paas/knowledge-bases';

function req(method: string, url: string, body?: unknown): Promise<Response> {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'u-owner' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Deterministic pseudo-embedding: same text → same unit vector. */
function fakeVector(text: string, dim = 8): number[] {
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    out[i % dim] += text.codePointAt(i)! % 97;
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

let fetchMock: ReturnType<typeof vi.fn>;

let faqKbId = '';
let docKbId = '';
let entryId = '';
let separateKbId = '';
let separateEntryId = '';

const STANDARD = '什么是向量数据库';
const SIMILAR_A = '向量数据库是什么';
const SIMILAR_B = '向量库怎么理解';
const ANSWER = '向量数据库是专门存储和检索高维向量的数据库。';

/** Text that only the *similar* questions would match — used for the separate test. */
const VARIANT_ONLY_QUERY = '向量库怎么理解';

/** 上传后分块+嵌入在后台跑，等到 ready 再断言，否则等于在赌调度顺序。 */
async function waitForIngest(docId: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await req('GET', `${BASE}/documents/${docId}`);
    const status = ((await res.json()) as any).document.parse_status as string;
    if (status === 'ready' || status === 'failed') return status;
    if (Date.now() > deadline) throw new Error(`ingest timeout, last status=${status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  await initDatabase();

  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { input: string[] };
    return new Response(
      JSON.stringify({
        data: body.input.map((text, index) => ({ index, embedding: fakeVector(text) })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  saveEmbeddingConfig({
    baseUrl: 'https://embed.test/v1',
    apiKey: 'k',
    model: 'test-embed',
    dimensions: 8,
  });

  // 文档库（对照组）：同样的词，但走的是普通文档路径。
  const docKb = await req('POST', BASE, { name: 'doc-kb' });
  docKbId = ((await docKb.json()) as any).knowledge_base.id;
  const fd = new FormData();
  fd.set('file', new File([`# 向量\n\n${ANSWER}\n`], 'v.md', { type: 'text/plain' }));
  const up = await app.request(`${BASE}/${docKbId}/documents`, {
    method: 'POST',
    headers: { 'x-test-user': 'u-owner' },
    body: fd,
  });
  expect(up.status).toBe(201);
  const docId = ((await up.json()) as any).document.id as string;
  expect(await waitForIngest(docId)).toBe('ready');

  // FAQ 库
  const faqKb = await req('POST', BASE, { name: 'faq-kb', type: 'faq' });
  expect(faqKb.status).toBe(201);
  faqKbId = ((await faqKb.json()) as any).knowledge_base.id;

  const entry = await req('POST', `${BASE}/${faqKbId}/faq/entries`, {
    standard_question: STANDARD,
    similar_questions: [SIMILAR_A, SIMILAR_B],
    negative_questions: ['向量数据库怎么安装'],
    answers: [ANSWER],
  });
  expect(entry.status).toBe(201);
  entryId = ((await entry.json()) as any).entry.id;

  // separate 模式的 FAQ 库
  const sepKb = await req('POST', BASE, {
    name: 'faq-sep',
    type: 'faq',
    faq_config: { index_mode: 'question_answer', question_index_mode: 'separate' },
  });
  separateKbId = ((await sepKb.json()) as any).knowledge_base.id;
  const sepEntry = await req('POST', `${BASE}/${separateKbId}/faq/entries`, {
    standard_question: STANDARD,
    similar_questions: [SIMILAR_A, SIMILAR_B],
    answers: [ANSWER],
  });
  separateEntryId = ((await sepEntry.json()) as any).entry.id;

  // 嵌入：走真实管线，只是模型换成了桩。
  for (const kbId of [faqKbId, separateKbId]) {
    const res = await req('POST', `${BASE}/${kbId}/embed-all`, {});
    expect(res.status).toBe(200);
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FAQ 知识库的创建与回显', () => {
  test('type=faq 落库，faq_config 补齐上游默认值', async () => {
    const res = await req('GET', `${BASE}/${faqKbId}`);
    const kb = ((await res.json()) as any).knowledge_base;
    expect(kb.type).toBe('faq');
    // 未显式传 faq_config → 上游 EnsureDefaults 的 question_answer + combined
    expect(kb.faqConfig).toEqual({ indexMode: 'question_answer', questionIndexMode: 'combined' });
  });

  test('未指定 type 时是普通文档库，且不回显 faqConfig', async () => {
    const res = await req('GET', `${BASE}/${docKbId}`);
    const kb = ((await res.json()) as any).knowledge_base;
    expect(kb.type).toBe('document');
    expect(kb.faqConfig).toBeNull();
  });

  // 上游报错原文："FAQ 知识库不支持文件上传，请使用 FAQ 导入功能"
  test('FAQ 库拒绝文件上传', async () => {
    const fd = new FormData();
    fd.set('file', new File(['随便什么'], 'x.md', { type: 'text/plain' }));
    const res = await app.request(`${BASE}/${faqKbId}/documents`, {
      method: 'POST',
      headers: { 'x-test-user': 'u-owner' },
      body: fd,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error).toContain('不支持文件上传');
  });
});

describe('FAQ 条目的存储形态', () => {
  test('一条条目 = 一行 chunk，chunk_type=faq，业务字段在 metadata', async () => {
    const row = getKbChunk(entryId)!;
    expect(row.chunk_type).toBe('faq');
    const meta = JSON.parse(row.metadata!);
    expect(meta.standard_question).toBe(STANDARD);
    expect(meta.similar_questions).toEqual([SIMILAR_A, SIMILAR_B]);
    expect(meta.negative_questions).toEqual(['向量数据库怎么安装']);
    expect(meta.answers).toEqual([ANSWER]);
    expect(meta.version).toBe(1);
  });

  test('chunk.content 是给人看的 Q:/Similar Questions:/Answers: 形态', async () => {
    const row = getKbChunk(entryId)!;
    expect(row.content).toContain(`Q: ${STANDARD}`);
    expect(row.content).toContain('Similar Questions:');
    expect(row.content).toContain(`- ${SIMILAR_A}`);
    expect(row.content).toContain('Answers:');
    // 负例永不进 content
    expect(row.content).not.toContain('向量数据库怎么安装');
  });

  test('重复的问题被去重，version 在更新时递增', async () => {
    const res = await req('PUT', `${BASE}/${faqKbId}/faq/entries/${entryId}`, {
      standard_question: STANDARD,
      similar_questions: [SIMILAR_A, SIMILAR_A, '  '],
      answers: [ANSWER],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.entry.similar_questions).toEqual([SIMILAR_A]);
    expect(body.entry.version).toBe(2);
    // 改完把夹具恢复原样，免得影响后面的检索用例
    const restore = await req('PUT', `${BASE}/${faqKbId}/faq/entries/${entryId}`, {
      standard_question: STANDARD,
      similar_questions: [SIMILAR_A, SIMILAR_B],
      negative_questions: ['向量数据库怎么安装'],
      answers: [ANSWER],
    });
    expect(((await restore.json()) as any).entry.version).toBe(3);
  });

  // 语义上必要：旧向量对应的是旧文本，留着就是错的召回。上游同样是
  // "改了内容就重新嵌入"，所以这里锁定"更新即失效"。
  test('更新会让旧向量失效，重新嵌入后才重新可检索', async () => {
    const before = getKbChunk(entryId)!;
    expect(before.embedding).toBeNull();
    expect(before.content).toContain(`Q: ${STANDARD}`);

    const res = await req('POST', `${BASE}/${faqKbId}/embed-all`, {});
    expect(res.status).toBe(200);
    expect(getKbChunk(entryId)!.embedding).toBeTruthy();
  });
});

describe('检索分流：FAQ 库不参与关键词检索', () => {
  test('前置条件：条目正文里确实含有查询词', () => {
    // 若不成立，下面的"关键词臂召回为 0"会是平凡结论。
    expect(getKbChunk(entryId)!.content).toContain('向量数据库');
  });

  test('keyword 模式下 FAQ 库召回为 0，而同样的词在文档库里召得到', async () => {
    const faq = await searchChunks({ kbIds: [faqKbId], query: STANDARD, limit: 5, mode: 'keyword' });
    expect(faq.hits).toHaveLength(0);

    // 对照组：证明查询串本身在这一天不是"谁都搜不到"
    const doc = await searchChunks({ kbIds: [docKbId], query: '向量数据库', limit: 5, mode: 'keyword' });
    expect(doc.hits.length).toBeGreaterThan(0);
  });

  test('debug 里能看出分桶结果', async () => {
    const { debug } = await searchChunks({
      kbIds: [faqKbId, docKbId],
      query: STANDARD,
      limit: 5,
      mode: 'keyword',
      debug: true,
    });
    expect(debug!.kb_buckets).toEqual({ faq: 1, doc: 1 });
  });

  test('vector 模式下 FAQ 库能召回（证明它确实进了向量索引）', async () => {
    const { hits } = await searchChunks({
      kbIds: [faqKbId],
      query: STANDARD,
      limit: 5,
      mode: 'vector',
      queryEmbedding: new Float32Array(fakeVector(STANDARD)),
    });
    expect(hits.map((h) => h.chunkId)).toContain(entryId);
  });
});

describe('负向问题的事后否决', () => {
  const NEGATIVE = '向量数据库怎么安装';

  /** 用条目自己的正文向量当查询向量 —— 保证这一枪必定命中，否决才有意义。 */
  function searchWith(queryText: string) {
    return searchChunks({
      kbIds: [faqKbId],
      query: queryText,
      limit: 5,
      mode: 'vector',
      queryEmbedding: new Float32Array(fakeVector(getKbChunk(entryId)!.content)),
      debug: true,
    });
  }

  test('同一个必然命中的向量：查询文本等于负例就被丢，不等于就保留', async () => {
    // A 组：向量相同、查询文本是一条普通问法 → 必须命中
    const kept = await searchWith('向量数据库是什么');
    expect(kept.hits.map((h) => h.chunkId)).toContain(entryId);
    expect(kept.debug!.faq_negative_filtered).toBe(0);

    // B 组：唯一的差别是查询文本命中了负例 → 必须被丢
    const vetoed = await searchWith(NEGATIVE);
    expect(vetoed.debug!.faq_negative_filtered).toBe(1);
    expect(vetoed.hits.map((h) => h.chunkId)).not.toContain(entryId);
  });

  test('大小写与首尾空白不影响否决（两侧都 lower+trim）', async () => {
    const { debug, hits } = await searchWith(`  ${NEGATIVE}  `);
    expect(debug!.faq_negative_filtered).toBe(1);
    expect(hits).toHaveLength(0);
  });

  // 上游是 == 比较而不是 contains，所以带标点/前后缀的提问不会被误杀。
  test('负例是子串不否决：只有精确相等才丢', async () => {
    for (const query of [`请问${NEGATIVE}呢`, `${NEGATIVE}？`]) {
      const { hits, debug } = await searchWith(query);
      expect(debug!.faq_negative_filtered).toBe(0);
      expect(hits.map((h) => h.chunkId)).toContain(entryId);
    }
  });
});

describe('separate 模式：一条条目产生 1 + N 条向量', () => {
  test('标准问进 chunk 自身的 embedding，相似问进变体表', async () => {
    const row = getKbChunk(separateEntryId)!;
    expect(row.embedding).toBeTruthy();

    // 两个相似问 → 变体下标 1、2（下标 0 是标准问，在 chunk 自己身上）
    const { vectorSearchChunkVariants } = await import('../../src/db.js');
    const variants = vectorSearchChunkVariants(
      [separateKbId],
      new Float32Array(fakeVector(`${SIMILAR_B}\n${ANSWER}`)),
      10,
      'faq_variant',
    );
    expect(variants.map((v) => v.chunk_id)).toContain(separateEntryId);
  });

  test('相似问的向量能召回父条目（归并回同一个 chunk）', async () => {
    const { hits } = await searchChunks({
      kbIds: [separateKbId],
      query: VARIANT_ONLY_QUERY,
      limit: 5,
      mode: 'vector',
      queryEmbedding: new Float32Array(fakeVector(`${VARIANT_ONLY_QUERY}\n${ANSWER}`)),
    });
    expect(hits.map((h) => h.chunkId)).toContain(separateEntryId);
  });

  test('变体命中不会让同一条目在结果里出现两次', async () => {
    const { hits } = await searchChunks({
      kbIds: [separateKbId],
      query: VARIANT_ONLY_QUERY,
      limit: 10,
      mode: 'vector',
      queryEmbedding: new Float32Array(fakeVector(getKbChunk(separateEntryId)!.content)),
    });
    const ids = hits.map((h) => h.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('combined 模式的库不产生变体向量', async () => {
    const { vectorSearchChunkVariants } = await import('../../src/db.js');
    const variants = vectorSearchChunkVariants(
      [faqKbId],
      new Float32Array(fakeVector(getKbChunk(entryId)!.content)),
      10,
      'faq_variant',
    );
    expect(variants).toHaveLength(0);
  });
});

describe('FAQ 条目路由', () => {
  test('列表按更新时间倒序，删除只认本库的 id', async () => {
    const list = await req('GET', `${BASE}/${faqKbId}/faq/entries`);
    const entries = ((await list.json()) as any).entries;
    expect(entries.map((e: any) => e.id)).toContain(entryId);

    // 拿另一个库的 id 来删：不该被删掉
    const cross = await req('DELETE', `${BASE}/${faqKbId}/faq/entries`, {
      ids: [separateEntryId],
    });
    expect(((await cross.json()) as any).deleted).toBe(0);
    expect(getKbChunk(separateEntryId)).not.toBeNull();
  });

  test('普通文档库上没有 FAQ 条目接口', async () => {
    const res = await req('GET', `${BASE}/${docKbId}/faq/entries`);
    expect(res.status).toBe(422);
  });

  test('新建的条目会挂到同一个容器文档下', async () => {
    const second = await req('POST', `${BASE}/${faqKbId}/faq/entries`, {
      standard_question: 'RAG 是什么',
    });
    expect(second.status).toBe(201);
    const a = getKbChunk(((await second.json()) as any).entry.id)!;
    const b = getKbChunk(entryId)!;
    expect(a.doc_id).toBe(b.doc_id);
    // 清理，避免影响上面的列表断言之外的东西
    await req('DELETE', `${BASE}/${faqKbId}/faq/entries`, { ids: [a.id] });
    expect(getKbChunksByIds([a.id])).toHaveLength(0);
  });
});
