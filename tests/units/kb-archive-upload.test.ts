// 整目录上传的 zip 通道（FR-P2-3 入口③ / `POST /:id/documents/archive`）。
//
// 这个端点最容易做错的地方不是"能不能解包"，而是**用户能不能认领结果**：
// 200 个文件里坏了 3 个，用户得知道是哪 3 个、为什么。所以用例的主线是逐条回执，
// 而不是"整体成功"。第二条主线是相对路径 —— 不保留的话，200 个 index.md
// 在列表里糊成一片。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import JSZip from 'jszip';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-archive-test-'));
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

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'office');

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

async function uploadZip(kbId: string, buf: Buffer, name = 'bundle.zip'): Promise<Response> {
  const fd = new FormData();
  fd.set('file', new File([new Uint8Array(buf)], name, { type: 'application/zip' }));
  return app.request(`${BASE}/${kbId}/documents/archive`, {
    method: 'POST',
    headers: { 'x-test-user': 'u-owner' },
    body: fd,
  });
}

async function listDocs(kbId: string): Promise<any[]> {
  const res = await req('GET', `${BASE}/${kbId}/documents`);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).documents as any[];
}

const INTRO = '# 使用指南\n\n本文描述 CHARLIE-9930 系统的接入步骤与注意事项。';

let kbId = '';
let faqKbId = '';

beforeAll(async () => {
  await initDatabase();
  const kb = await req('POST', BASE, { name: '整目录入库库' });
  kbId = ((await kb.json()) as any).knowledge_base.id;
  const faq = await req('POST', BASE, { name: '整目录 FAQ 库', type: 'faq' });
  faqKbId = ((await faq.json()) as any).knowledge_base.id;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('整包上传：逐条回执', () => {
  test('混合内容：入库 3 条、跳过 3 条并逐条说明原因', async () => {
    const zip = new JSZip();
    // 该进的
    zip.file('docs/guide/intro.md', INTRO);
    zip.file('docs/guide/notes.txt', '零散记录，编号 CHARLIE-9930。');
    zip.file('slides.pptx', fs.readFileSync(path.join(FIXTURES, 'slides.pptx')));
    // 该跳过的
    zip.file('.git/config', '[core]\n\trepositoryformatversion = 0');
    zip.file('__MACOSX/._intro.md', 'resource fork junk');
    // PNG 签名 + 含 NUL 的 IHDR：明确是二进制，且扩展名不在支持表里。
    zip.file(
      'logo.png',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01]),
      ]),
    );

    const res = await uploadZip(kbId, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    expect(body.summary).toEqual({ added: 3, skipped: 3, failed: 0 });
    expect(body.summary.added + body.summary.skipped + body.summary.failed).toBe(6);

    const addedPaths = body.added.map((a: any) => a.path).sort();
    expect(addedPaths).toEqual(['docs/guide/intro.md', 'docs/guide/notes.txt', 'slides.pptx']);
    // pptx 走的是 zip 通道，parser_type 要如实记下来。
    expect(body.added.find((a: any) => a.path === 'slides.pptx').parser_type).toBe('pptx');

    const skippedPaths = body.skipped.map((s: any) => s.path).sort();
    expect(skippedPaths).toEqual(['.git/config', '__MACOSX/._intro.md', 'logo.png']);
    // 每个跳过项都必须有原因 —— 静默丢弃是 PRD 明确禁止的。
    for (const s of body.skipped) expect(s.reason).toBeTruthy();
    expect(body.skipped.find((s: any) => s.path === '.git/config').reason).toBe('隐藏项');
    expect(body.skipped.find((s: any) => s.path === 'logo.png').reason).toBe('不支持的格式');
  });

  test('文本形态的未知扩展名按既有策略当文本入库（P2 未改动这个口径）', async () => {
    // `.ai`（Illustrator）实际是 PostScript 文本，`sniffTextFromBuffer` 会认为它
    // 可打印、于是当文本收下。这是上传端点**引入 zip 通道之前**就有的策略
    // （`sniffTextFromBuffer` 的原意是拦住二进制乱码，不拦文本形态），
    // 这里如实钉住，免得日后有人以为整包上传漏判了格式。
    const zip = new JSZip();
    zip.file('logo.ai', Buffer.from('%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator\n'));
    const res = await uploadZip(kbId, await zip.generateAsync({ type: 'nodebuffer' }));
    const body = (await res.json()) as any;
    expect(body.summary).toEqual({ added: 1, skipped: 0, failed: 0 });
    expect(body.added[0].parser_type).toBe('text');
  });

  test('相对路径原样进库，列表里能看出它来自哪个目录', async () => {
    const docs = await listDocs(kbId);
    const filenames = docs.map((d) => d.filename);
    // 不保留路径的话，200 个 index.md 会糊成一片，用户无法认领。
    expect(filenames).toContain('docs/guide/intro.md');
    expect(filenames).toContain('docs/guide/notes.txt');
  });

  test('入包内容真的完成了分块（不是只写了文档行）', async () => {
    const docs = await listDocs(kbId);
    const intro = docs.find((d) => d.filename === 'docs/guide/intro.md');
    expect(intro).toBeTruthy();
    // 入库是异步的，轮询到 ready。
    const deadline = Date.now() + 10_000;
    let current = intro;
    while (Date.now() < deadline && current.parse_status === 'pending') {
      await new Promise((r) => setTimeout(r, 25));
      current = (await listDocs(kbId)).find((d) => d.filename === 'docs/guide/intro.md');
    }
    expect(current.parse_status).toBe('ready');
    expect(current.chunk_count).toBeGreaterThan(0);
  });

  test('重复内容记 skipped 而不是 failed（不是错误，只是没必要再存一遍）', async () => {
    const zip = new JSZip();
    zip.file('docs/guide/intro.md', INTRO);
    const res = await uploadZip(kbId, await zip.generateAsync({ type: 'nodebuffer' }));
    const body = (await res.json()) as any;
    expect(body.summary).toEqual({ added: 0, skipped: 1, failed: 0 });
    expect(body.skipped[0].reason).toContain('内容相同');
    expect(body.skipped[0].doc_id).toBeTruthy();
  });
});

describe('整包上传：边界', () => {
  test('单条解析失败记 failed 并带原因，同包其它条目照常入库', async () => {
    const zip = new JSZip();
    zip.file('good.md', '这条是好的，编号 CHARLIE-9930。');
    // 扩展名说是 pptx，内容却是个普通 zip —— 解析必然失败。
    const fake = new JSZip();
    fake.file('not-a-slide.txt', 'x');
    zip.file('broken.pptx', await fake.generateAsync({ type: 'nodebuffer' }));

    const res = await uploadZip(kbId, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.summary.added).toBe(1);
    expect(body.summary.failed).toBe(1);
    expect(body.failed[0].path).toBe('broken.pptx');
    expect(body.failed[0].reason).toMatch(/presentation\.xml/);
  });

  test('超过单次上限的条目进 skipped 并说明，不静默丢弃', async () => {
    const zip = new JSZip();
    // 上限 200。塞 205 条，超出的 5 条必须在回执里看得见。
    for (let i = 0; i < 205; i++) {
      zip.file(`bulk/note-${String(i).padStart(3, '0')}.md`, `第 ${i} 条记录，唯一编号 BULK-${i}。`);
    }
    const res = await uploadZip(kbId, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.summary.added).toBe(200);
    expect(body.summary.skipped).toBe(5);
    for (const s of body.skipped) expect(s.reason).toMatch(/超出单次上限/);
  });

  test('不是 zip 的文件：400，且说清楚是压缩包的问题', async () => {
    const res = await uploadZip(kbId, Buffer.from('这不是一个 zip'), 'fake.zip');
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/不是有效的压缩包/);
  });

  test('路径穿越的 zip 整体拒绝', async () => {
    const zip = new JSZip();
    zip.file('../../etc/passwd', 'x');
    const res = await uploadZip(kbId, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/非法路径/);
  });

  test('缺少 file 字段：400', async () => {
    const fd = new FormData();
    fd.set('nope', 'x');
    const res = await app.request(`${BASE}/${kbId}/documents/archive`, {
      method: 'POST',
      headers: { 'x-test-user': 'u-owner' },
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  test('FAQ 库拒绝整包上传', async () => {
    const zip = new JSZip();
    zip.file('a.md', 'x');
    const res = await uploadZip(faqKbId, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(res.status).toBe(422);
  });

  test('知识库不存在：404', async () => {
    const zip = new JSZip();
    zip.file('a.md', 'x');
    const res = await uploadZip('no-such-kb', await zip.generateAsync({ type: 'nodebuffer' }));
    expect(res.status).toBe(404);
  });
});
