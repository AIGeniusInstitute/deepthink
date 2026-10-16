// 手写 Markdown 入库（FR-P2-2 / `POST /:id/documents/text`）。
//
// 这条路径的价值在于"不落盘也能进库"，风险也在这里：它绕开了文件上传的校验链，
// 很容易变成一条**旁路** —— 跳过重复检测、写了一行正文为空的孤儿文档、
// 或者入库了却不参与检索。所以用例盯的不是"返回 201"，而是这三件事。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-text-ingest-test-'));
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

async function listDocs(kbId: string): Promise<any[]> {
  const res = await req('GET', `${BASE}/${kbId}/documents`);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).documents as any[];
}

const MARKDOWN = [
  '# 试验方案摘要',
  '',
  '本节描述受试者信息录错之后的修正流程，研究者需发起质疑并在 EDC 中留痕。',
  '',
  '## 数据核查',
  '',
  '监查员核对原始病历与 eCRF 的一致性，方案编号 CHARLIE-9930。',
].join('\n');

let kbId = '';
let faqKbId = '';

beforeAll(async () => {
  await initDatabase();
  const kb = await req('POST', BASE, { name: '手写入库库' });
  expect(kb.status).toBe(201);
  kbId = ((await kb.json()) as any).knowledge_base.id;

  const faq = await req('POST', BASE, { name: '手写入库 FAQ 库', type: 'faq' });
  expect(faq.status).toBe(201);
  faqKbId = ((await faq.json()) as any).knowledge_base.id;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('手写 Markdown 入库', () => {
  test('201 入库、parser_type 记为 markdown、后台完成分块', async () => {
    const res = await req('POST', `${BASE}/${kbId}/documents/text`, {
      title: '试验方案摘要',
      content: MARKDOWN,
    });
    expect(res.status).toBe(201);
    const doc = ((await res.json()) as any).document;
    expect(doc.parser_type).toBe('markdown');
    expect(doc.filename).toBe('试验方案摘要');

    expect(await waitForIngest(doc.id)).toBe('ready');
    const listed = (await listDocs(kbId)).find((d) => d.id === doc.id);
    expect(listed.chunk_count).toBeGreaterThan(0);
  });

  test('入库的内容真的能检索到（不是只写了文档行）', async () => {
    // 用 Latin 词而不是中文整句：关键词臂是 FTS5 trigram 的子串语义，
    // 中文整句在纯 keyword 模式本来就不命中，拿它当断言点会误判。
    const res = await req('POST', `${BASE}/${kbId}/search`, {
      query: 'CHARLIE-9930',
      mode: 'keyword',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const hits = body.hits ?? body.results ?? [];
    expect(hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(hits)).toContain('CHARLIE-9930');
  });

  test('标题为空：400 且**不留下任何文档行**', async () => {
    const before = (await listDocs(kbId)).length;
    for (const title of ['', '   ']) {
      const res = await req('POST', `${BASE}/${kbId}/documents/text`, {
        title,
        content: '正文是好的，但标题不合格。',
      });
      expect(res.status).toBe(400);
    }
    // 这是本组用例最要紧的一条：校验若放在 addKbDocument 之后，列表里就会多出
    // 一行没人认领的空标题文档 —— 用户删不掉（不知道它是什么）又占着位置。
    expect((await listDocs(kbId)).length).toBe(before);
  });

  test('正文为空/纯空白：400 且不留下文档行', async () => {
    const before = (await listDocs(kbId)).length;
    for (const content of ['', '   \n  \t ']) {
      const res = await req('POST', `${BASE}/${kbId}/documents/text`, {
        title: `空正文测试-${content.length}`,
        content,
      });
      expect(res.status).toBe(400);
    }
    expect((await listDocs(kbId)).length).toBe(before);
  });

  test('完全相同的正文再存一次判重（不能因为换了端点就绕开重复检测）', async () => {
    const res = await req('POST', `${BASE}/${kbId}/documents/text`, {
      title: '换个标题但正文一样',
      content: MARKDOWN,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).doc_id).toBeTruthy();
  });

  test('字段类型不对：400，不是 500', async () => {
    const res = await req('POST', `${BASE}/${kbId}/documents/text`, {
      title: 123,
      content: { nested: true },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).issues?.length).toBeGreaterThan(0);
  });

  test('FAQ 库拒绝文档入库（对齐文件上传的口径）', async () => {
    const res = await req('POST', `${BASE}/${faqKbId}/documents/text`, {
      title: 'x',
      content: 'y',
    });
    expect(res.status).toBe(422);
  });

  test('知识库不存在：404', async () => {
    const res = await req('POST', `${BASE}/no-such-kb/documents/text`, {
      title: 'x',
      content: 'y',
    });
    expect(res.status).toBe(404);
  });
});
