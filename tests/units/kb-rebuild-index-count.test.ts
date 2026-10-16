// 回归用例：`重建索引` 之后，文档列表上的「已向量化」必须跟着变。
//
// 为什么单独写一组：`kb_documents.embedded_chunk_count` 是**冗余计数列**，平时
// 由 ingest 管线（src/kb/pipeline.ts）在入库末尾维护，列表接口直接读这一列，
// 不做实时统计。而 `POST /:id/rebuild-index` 走的是 `embedAllChunksInKb`，**不经过**
// 那条管线 —— 于是向量写了、检索也命中了，计数列却停在 0。
//
// 症状是"数据是对的、界面在撒谎"：9999 实例上 `kb_chunks` 267/267 都有向量、
// 混合检索实测命中 3 条，列表却显示「已向量化 0」。这类缺陷跑接口断言抓不到
// （接口返回的 attempted/success 全对），**只能对着列表接口读那一列才能抓到**，
// 所以这组用例的断言点刻意选在 `GET /:id/documents` 的返回上，而不是 stats。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-rebuild-count-test-'));
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

/** 确定性伪向量：同样的文本得到同样的单位向量。 */
function fakeVector(text: string, dim = 8): number[] {
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) out[i % dim] += text.codePointAt(i)! % 97;
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

async function waitForIngest(docId: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await req('GET', `${BASE}/documents/${docId}`);
    const status = ((await res.json()) as any).document?.parse_status;
    if (status === 'ready' || status === 'failed') return status;
    if (Date.now() > deadline) throw new Error(`ingest timeout, last status=${status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 列表接口里那一条文档 —— 用户界面上「已向量化 N」读的就是它。 */
async function listedDoc(kbId: string, docId: string): Promise<any> {
  const res = await req('GET', `${BASE}/${kbId}/documents`);
  expect(res.status).toBe(200);
  const docs = ((await res.json()) as any).documents as any[];
  const found = docs.find((d) => d.id === docId);
  expect(found, `列表里应该能找到文档 ${docId}`).toBeTruthy();
  return found;
}

const BODY = [
  '# 试验方案',
  '',
  '本节描述受试者信息录错之后的修正流程，需要研究者发起质疑并在 EDC 中留痕。',
  '',
  '## 数据核查',
  '',
  '监查员核对原始病历与 eCRF 的一致性，发现不一致时开具质疑。',
].join('\n');

let kbId = '';
let docId = '';

beforeAll(async () => {
  await initDatabase();

  const kb = await req('POST', BASE, { name: '重建索引计数库' });
  expect(kb.status).toBe(201);
  kbId = ((await kb.json()) as any).knowledge_base.id;

  // 第一步刻意**不配 embedding**：入库管线会跳过 embed 阶段，分块照常产生、
  // 计数列为 0。这正是「先传了文档、后来才配向量模型」的真实时序。
  const fd = new FormData();
  fd.set('file', new File([BODY], 'trial.md', { type: 'text/plain' }));
  const up = await app.request(`${BASE}/${kbId}/documents`, {
    method: 'POST',
    headers: { 'x-test-user': 'u-owner' },
    body: fd,
  });
  expect(up.status).toBe(201);
  docId = ((await up.json()) as any).document.id as string;
  expect(await waitForIngest(docId)).toBe('ready');
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('重建索引必须刷新「已向量化」计数', () => {
  test('前置状态：分块已产生，但未向量化（计数 0）', async () => {
    const doc = await listedDoc(kbId, docId);
    expect(doc.chunk_count).toBeGreaterThan(0);
    expect(doc.embedded_chunk_count).toBe(0);
  });

  test('重建索引后，列表上的已向量化等于分块数（缺陷点）', async () => {
    // 到这里才配向量模型 —— 模拟「配好模型再去补历史文档」的操作顺序。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { input: string[] };
        return new Response(
          JSON.stringify({
            data: body.input.map((text, index) => ({ index, embedding: fakeVector(text) })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    saveEmbeddingConfig({
      baseUrl: 'https://embed.test/v1',
      apiKey: 'k',
      model: 'test-embed',
      dimensions: 8,
    });

    const res = await req('POST', `${BASE}/${kbId}/rebuild-index`, {});
    expect(res.status).toBe(200);
    const stats = (await res.json()) as any;
    expect(stats.success).toBeGreaterThan(0);

    // 关键断言：统计说成功了不算数，列表读的那一列必须同步。
    // 修之前这里是 0 —— stats 全对、界面全错。
    const doc = await listedDoc(kbId, docId);
    expect(doc.embedded_chunk_count).toBe(doc.chunk_count);
    expect(doc.embedded_chunk_count).toBeGreaterThan(0);
  });

  test('重复调用是幂等的，计数不会翻倍也不会被清零', async () => {
    const before = await listedDoc(kbId, docId);
    const res = await req('POST', `${BASE}/${kbId}/rebuild-index`, {});
    expect(res.status).toBe(200);
    // 没有待嵌入的分块，本轮不该重复嵌入。
    expect(((await res.json()) as any).attempted).toBe(0);

    const after = await listedDoc(kbId, docId);
    expect(after.embedded_chunk_count).toBe(before.embedded_chunk_count);
  });
});
