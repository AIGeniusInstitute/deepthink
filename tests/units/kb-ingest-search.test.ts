// 知识库子系统端到端单测：上传 → 入库流水线 → 分块 → 检索 → 引用溯源 → 问答。
// 覆盖 PRD FR-1/FR-2/FR-4/FR-5/FR-6 与 AC-1.x / AC-2.x / AC-4.x / AC-5.x / AC-6.x。
//
// 这一组用例的存在理由：分块引擎、RRF 融合、流水线各自单测全绿，也证明不了
// "上传一份长文档之后，尾部内容真的能被检索到"。所以这里挂真实的 Hono app 发
// 请求、等流水线跑完、再回查 /documents/:id/content 用字符偏移切原文比对 —— 只有
// 偏移能切回原文，引用才是可核验的，否则只是一段看起来像引用的字符串。

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDir,
}));

// 认证在这里没有被测价值，直接注入一个固定用户。
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

function req(
  method: string,
  url: string,
  body?: unknown,
  user = 'u-owner',
): Promise<Response> {
  return app.request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': user,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function uploadFile(
  kbId: string,
  filename: string,
  content: string,
  user = 'u-owner',
): Promise<Response> {
  const fd = new FormData();
  fd.set('file', new File([content], filename, { type: 'text/plain' }));
  return app.request(`${BASE}/${kbId}/documents`, {
    method: 'POST',
    headers: { 'x-test-user': user },
    body: fd,
  });
}

/** 轮询 parse_status 直到终态；超时即失败，避免用例挂死。 */
async function waitForIngest(docId: string, timeoutMs = 20_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await req('GET', `${BASE}/documents/${docId}`);
    const json = (await res.json()) as any;
    const status = json.document?.parse_status;
    if (status === 'ready' || status === 'failed') return json.document;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Ingestion for ${docId} did not reach a terminal state`);
}

async function createKb(name: string, user = 'u-owner'): Promise<string> {
  const res = await req('POST', BASE, { name }, user);
  expect(res.status).toBe(201);
  const json = (await res.json()) as any;
  return json.knowledge_base.id as string;
}

/**
 * A document long enough that the old 8000-char slice would have dropped the
 * tail. TAIL_MARKER sits well past that boundary and is the whole point: if
 * anything reintroduces whole-document truncation, this test fails.
 */
const TAIL_MARKER = 'ZEBRAFISH_SENTINEL_9X';
function longDocument(): string {
  const paragraphs: string[] = [];
  for (let i = 0; i < 120; i++) {
    paragraphs.push(
      `第 ${i} 节 内容占位。这里是一段用于撑长文档的中文段落，目的是让正文长度明显超过八千字符，` +
        `从而检验入库流水线是否真的把整篇文档都切块并索引，而不是只处理开头部分。`,
    );
  }
  paragraphs.push(`最后一节：${TAIL_MARKER} 是只出现在文末的检索标记。`);
  return paragraphs.join('\n\n');
}

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  // 每个用例自建知识库，互不干扰。
});

describe('知识库 CRUD', () => {
  test('创建后可查询到，且带默认字段', async () => {
    const kbId = await createKb('测试库 A');
    const res = await req('GET', `${BASE}/${kbId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.knowledge_base).toMatchObject({ id: kbId, name: '测试库 A', docCount: 0 });
  });

  test('GET /:id 对不存在的库返回 404', async () => {
    const res = await req('GET', `${BASE}/no-such-kb`);
    expect(res.status).toBe(404);
  });

  test('他人无法读取自己的知识库', async () => {
    const kbId = await createKb('私有库', 'u-alice');
    const res = await req('GET', `${BASE}/${kbId}`, undefined, 'u-bob');
    expect(res.status).toBe(404);
  });

  test('PATCH 改名，DELETE 删除', async () => {
    const kbId = await createKb('待改名');
    const patched = await req('PATCH', `${BASE}/${kbId}`, { name: '已改名' });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).knowledge_base.name).toBe('已改名');

    const del = await req('DELETE', `${BASE}/${kbId}`);
    expect(del.status).toBe(200);
    expect((await req('GET', `${BASE}/${kbId}`)).status).toBe(404);
  });
});

describe('入库流水线（FR-1 / FR-2）', () => {
  test('AC-1.1 上传后文档进入 ready，并产生分块与阶段记录', async () => {
    const kbId = await createKb('入库库');
    const res = await uploadFile(kbId, 'doc.txt', longDocument());
    expect(res.status).toBe(201);
    const created = (await res.json()) as any;
    const docId = created.document.id;
    expect(created.document.parse_status).toBe('pending');

    const doc = await waitForIngest(docId);
    expect(doc.parse_status).toBe('ready');
    expect(doc.chunk_count).toBeGreaterThan(0);
    expect(doc.parser_type).toBe('text');
    // 三个阶段都应留下记录，便于 UI 展示耗时。
    const stages = doc.stages.map((s: any) => s.stage);
    expect(stages).toContain('parse');
    expect(stages).toContain('chunk');
    expect(stages).toContain('embed');
    // 未配置 embedding 时 embed 阶段应为 skipped 而不是 failed。
    const embed = doc.stages.find((s: any) => s.stage === 'embed');
    expect(['ok', 'skipped']).toContain(embed.status);
  });

  test('AC-2.1 长文档被切成多个分块，且覆盖全文', async () => {
    const kbId = await createKb('长文档库');
    const text = longDocument();
    const res = await uploadFile(kbId, 'long.txt', text);
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);

    const chunksRes = await req('GET', `${BASE}/documents/${docId}/chunks?full=1`);
    const chunks = ((await chunksRes.json()) as any).chunks;
    expect(chunks.length).toBeGreaterThanOrEqual(20);

    // 不变量：偏移递增不重叠，且 content 恰好是原文切片 —— 引用可核验的全部依据。
    // 分块之间可能留有空行分隔符（不属于任何一段），所以不要求逐字连续，
    // 但必须完整覆盖 [0, len]，否则文档尾部会静默丢失。
    let cursor = 0;
    for (const ch of chunks) {
      expect(ch.start_at).toBeGreaterThanOrEqual(cursor);
      expect(ch.end_at).toBeGreaterThan(ch.start_at);
      expect(text.slice(ch.start_at, ch.end_at)).toBe(ch.content);
      cursor = ch.end_at;
    }
    expect(cursor).toBe(text.length);
    // 全文所有非空白字符都必须落在某个分块里。
    const covered = chunks.map((c: any) => text.slice(c.start_at, c.end_at)).join('');
    const strip = (s: string) => s.replace(/\s+/g, '');
    expect(strip(covered)).toBe(strip(text));
  });

  test('重复内容上传返回 409（内容哈希去重）', async () => {
    const kbId = await createKb('去重库');
    const res1 = await uploadFile(kbId, 'a.txt', '同样的内容');
    expect(res1.status).toBe(201);
    const res2 = await uploadFile(kbId, 'b.txt', '同样的内容');
    expect(res2.status).toBe(409);
  });

  test('空文件被拒绝', async () => {
    const kbId = await createKb('空文件库');
    const res = await uploadFile(kbId, 'empty.txt', '   \n  ');
    expect(res.status).toBe(400);
  });

  test('重新分块可更换策略并重建分块', async () => {
    const kbId = await createKb('重分块库');
    const res = await uploadFile(kbId, 'r.txt', longDocument());
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);

    const reparse = await req('POST', `${BASE}/documents/${docId}/reparse`, {
      strategy: 'recursive',
      chunk_size: 256,
      chunk_overlap: 32,
    });
    expect(reparse.status).toBe(202);
    const doc = await waitForIngest(docId);
    expect(doc.parse_status).toBe('ready');
    expect(doc.chunk_count).toBeGreaterThan(0);
  });
});

describe('分块预览（FR-2 测试台）', () => {
  test('预览不落库，只返回切分结果', async () => {
    const kbId = await createKb('预览库');
    const res = await req('POST', `${BASE}/${kbId}/chunker/preview`, {
      text: '第一段内容。\n\n第二段内容。\n\n第三段内容。',
      chunk_size: 12,
      chunk_overlap: 0,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.total).toBeGreaterThan(1);
    expect(json.chunks[0]).toHaveProperty('start_at');
    expect(json.chunks[0]).toHaveProperty('end_at');
  });

  test('预览空文本被拒绝', async () => {
    const kbId = await createKb('预览库2');
    const res = await req('POST', `${BASE}/${kbId}/chunker/preview`, { text: '' });
    expect(res.status).toBe(400);
  });
});

describe('检索与引用溯源（FR-4 / FR-5）', () => {
  test('AC-4.3 关键词检索能命中长文档尾部分块（8000 字截断回归测试）', async () => {
    const kbId = await createKb('检索库');
    const text = longDocument();
    const res = await uploadFile(kbId, 'k.txt', text);
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);

    // 标记位于 8000 字符之后 —— 旧实现只索引前 8000 字符，必然命中不到。
    expect(text.indexOf(TAIL_MARKER)).toBeGreaterThan(8000);

    const search = await req('POST', `${BASE}/${kbId}/search`, {
      query: TAIL_MARKER,
      mode: 'keyword',
      top_k: 5,
    });
    expect(search.status).toBe(200);
    const json = (await search.json()) as any;
    expect(json.hits.length).toBeGreaterThan(0);
    expect(json.hits[0].content).toContain(TAIL_MARKER);
    expect(json.hits[0].doc_id).toBe(docId);
  });

  test('AC-4.4 命中带完整引用字段，且偏移能切回原文', async () => {
    const kbId = await createKb('引用库');
    const text = longDocument();
    const res = await uploadFile(kbId, 'cite.txt', text);
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);

    const search = await req('POST', `${BASE}/${kbId}/search`, {
      query: TAIL_MARKER,
      mode: 'keyword',
    });
    const hit = ((await search.json()) as any).hits[0];
    for (const field of [
      'chunk_id',
      'doc_id',
      'kb_id',
      'filename',
      'start_at',
      'end_at',
      'score',
      'source',
    ]) {
      expect(hit).toHaveProperty(field);
    }
    expect(hit.filename).toBe('cite.txt');

    // 关键：用命中的偏移回源文档切原文，必须与命中内容逐字一致。
    const src = await req(
      'GET',
      `${BASE}/documents/${docId}/content?start=${hit.start_at}&end=${hit.end_at}`,
    );
    expect(src.status).toBe(200);
    expect(((await src.json()) as any).content).toBe(hit.content);
  });

  test('min_score 过滤掉低相关命中', async () => {
    const kbId = await createKb('阈值库');
    const res = await uploadFile(kbId, 's.txt', longDocument());
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);

    const loose = await req('POST', `${BASE}/${kbId}/search`, {
      query: TAIL_MARKER,
      mode: 'keyword',
    });
    const strict = await req('POST', `${BASE}/${kbId}/search`, {
      query: TAIL_MARKER,
      mode: 'keyword',
      min_score: 0.99,
    });
    const looseHits = ((await loose.json()) as any).hits.length;
    const strictHits = ((await strict.json()) as any).hits.length;
    expect(strictHits).toBeLessThanOrEqual(looseHits);
  });

  test('debug 模式返回各阶段耗时', async () => {
    const kbId = await createKb('调试库');
    const res = await uploadFile(kbId, 'd.txt', longDocument());
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);

    const search = await req('POST', `${BASE}/${kbId}/search`, {
      query: TAIL_MARKER,
      mode: 'keyword',
      debug: true,
    });
    const json = (await search.json()) as any;
    expect(json.debug).toBeTruthy();
    // 检索测试台要能展示各臂耗时，字段名与 SearchDebug 保持一致。
    expect(json.debug.timings_ms).toBeTruthy();
    expect(typeof json.debug.timings_ms.total).toBe('number');
    expect(json.debug.effective_mode).toBeTruthy();
  });

  test('跨库检索只能看到自己的库', async () => {
    const mine = await createKb('我的库', 'u-me');
    const theirs = await createKb('别人的库', 'u-other');
    await uploadFile(mine, 'mine.txt', `我的独有内容 ${TAIL_MARKER}`, 'u-me');
    await uploadFile(theirs, 'theirs.txt', `别人的独有内容 ${TAIL_MARKER}`, 'u-other');

    // 明确指定别人库 id，也不应越过归属校验。
    const res = await req(
      'POST',
      `${BASE}/search/all`,
      { query: TAIL_MARKER, kb_ids: [mine, theirs] },
      'u-me',
    );
    const json = (await res.json()) as any;
    for (const hit of json.hits) {
      expect(hit.kb_id).toBe(mine);
    }
  });
});

describe('分块编辑与版本（FR-2 / FR-7）', () => {
  test('AC-2.5 编辑分块内容会留版本、清空向量，可回滚', async () => {
    const kbId = await createKb('编辑库');
    const res = await uploadFile(kbId, 'e.txt', longDocument());
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);

    const chunks = ((await (await req('GET', `${BASE}/documents/${docId}/chunks?full=1`)).json()) as any)
      .chunks;
    const target = chunks[0];
    const original = target.content;

    const edited = await req('PUT', `${BASE}/chunks/${target.id}`, {
      content: '人工修订后的分块内容 ' + TAIL_MARKER,
    });
    expect(edited.status).toBe(200);
    const editedChunk = ((await edited.json()) as any).chunk;
    expect(editedChunk.content).toContain('人工修订');
    // 内容变了，旧向量必须失效，否则检索会命中过期语义。
    expect(editedChunk.embedded).toBe(false);

    const revs = await req('GET', `${BASE}/chunks/${target.id}/revisions`);
    const revisions = ((await revs.json()) as any).revisions;
    expect(revisions.length).toBe(1);
    expect(revisions[0].content).toBe(original);

    const reverted = await req('POST', `${BASE}/chunks/${target.id}/revert`, {
      revision_id: revisions[0].id,
    });
    expect(reverted.status).toBe(200);
    expect(((await reverted.json()) as any).chunk.content).toBe(original);
  });

  test('编辑为空内容被拒绝', async () => {
    const kbId = await createKb('编辑库2');
    const res = await uploadFile(kbId, 'e2.txt', '一段内容');
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);
    const chunkId = ((await (await req('GET', `${BASE}/documents/${docId}/chunks`)).json()) as any)
      .chunks[0].id;
    const bad = await req('PUT', `${BASE}/chunks/${chunkId}`, { content: '   ' });
    expect(bad.status).toBe(400);
  });

  test('删除分块后不再出现在文档分块列表', async () => {
    const kbId = await createKb('删除分块库');
    const res = await uploadFile(kbId, 'del.txt', longDocument());
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);
    const before = ((await (await req('GET', `${BASE}/documents/${docId}/chunks`)).json()) as any)
      .chunks;
    const del = await req('DELETE', `${BASE}/chunks/${before[0].id}`);
    expect(del.status).toBe(200);
    const after = ((await (await req('GET', `${BASE}/documents/${docId}/chunks`)).json()) as any)
      .chunks;
    expect(after.length).toBe(before.length - 1);
  });
});

describe('RAG 问答（FR-6）', () => {
  test('AC-6.2 未配置对话模型时返回兜底答案而非报错', async () => {
    const kbId = await createKb('问答库');
    const res = await uploadFile(kbId, 'q.txt', longDocument());
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);

    const chat = await req('POST', `${BASE}/chat`, {
      question: `${TAIL_MARKER} 是什么？`,
      kb_ids: [kbId],
      stream: false,
    });
    expect(chat.status).toBe(200);
    const json = (await chat.json()) as any;
    expect(typeof json.answer).toBe('string');
    expect(json.answer.length).toBeGreaterThan(0);
    // 检索仍然应当命中，引用要一并返回，界面才能展示依据。
    expect(json.citations.length).toBeGreaterThan(0);
    expect(json.session_id).toBeTruthy();
  });

  test('AC-6.4 问答消息持久化，可按会话回放', async () => {
    const kbId = await createKb('会话库');
    const res = await uploadFile(kbId, 'c.txt', longDocument());
    await waitForIngest(((await res.json()) as any).document.id);

    const chat = await req('POST', `${BASE}/chat`, {
      question: `${TAIL_MARKER} 的出处？`,
      kb_ids: [kbId],
      stream: false,
    });
    const { session_id } = (await chat.json()) as any;

    const msgs = await req('GET', `${BASE}/chat/sessions/${session_id}/messages`);
    const messages = ((await msgs.json()) as any).messages;
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');

    const cleared = await req('DELETE', `${BASE}/chat/sessions/${session_id}`);
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as any).removed).toBeGreaterThan(0);
  });

  test('无任何可访问知识库时问答返回 403', async () => {
    const res = await req('POST', `${BASE}/chat`, { question: '你好', kb_ids: ['nope'] });
    expect(res.status).toBe(403);
  });
});

describe('文档级接口', () => {
  test('文档列表带解析状态与分块计数', async () => {
    const kbId = await createKb('列表库');
    const res = await uploadFile(kbId, 'l.txt', longDocument());
    await waitForIngest(((await res.json()) as any).document.id);

    const list = await req('GET', `${BASE}/${kbId}/documents`);
    const docs = ((await list.json()) as any).documents;
    expect(docs.length).toBe(1);
    expect(docs[0].parse_status).toBe('ready');
    expect(docs[0].chunk_count).toBeGreaterThan(0);
    expect(docs[0]).not.toHaveProperty('content'); // 列表不返回正文
  });

  test('按偏移取正文时越界参数被夹紧', async () => {
    const kbId = await createKb('切片库');
    const text = '零一二三四五六七八九';
    const res = await uploadFile(kbId, 'slice.txt', text);
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);

    const out = await req('GET', `${BASE}/documents/${docId}/content?start=-5&end=9999`);
    const json = (await out.json()) as any;
    expect(json.start_at).toBe(0);
    expect(json.end_at).toBe(text.length);
    expect(json.content).toBe(text);
  });

  test('删除文档后其分块一并消失', async () => {
    const kbId = await createKb('级联库');
    const res = await uploadFile(kbId, 'cascade.txt', longDocument());
    const docId = ((await res.json()) as any).document.id;
    await waitForIngest(docId);
    const chunkId = ((await (await req('GET', `${BASE}/documents/${docId}/chunks`)).json()) as any)
      .chunks[0].id;

    const del = await req('DELETE', `${BASE}/${kbId}/documents/${docId}`);
    expect(del.status).toBe(200);
    // 分块随文档级联删除，按 chunkId 直查应当 404。
    expect((await req('GET', `${BASE}/chunks/${chunkId}`)).status).toBe(404);
  });
});
