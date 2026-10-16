// Doc2Query 接进真实链路后的行为：配置 → 生成 → 落库 → 检索。
//
// 这里要证明的承重命题有三条，纯函数单测覆盖不到：
//
//   1. **生成的问题真的扩大了召回。** 拿一句正文里根本不存在、只作为"预生成问题"
//      出现的问法去检索，向量臂能召回该分块、关键词臂召不回——这才叫问题进了索引，
//      而不是只写进了 metadata。
//   2. **单个分块失败只跳过它**（上游 `knowledge_process.go:2404-2408` 是 continue
//      不是 return），整批其余分块照常生成。
//   3. **生成期间正文被改过就丢弃结果**（`:2412-2417` 比对 ContentRevision），
//      否则写回的问题是针对已经不存在的正文写的。
//
// 另外覆盖配置的回显/部分更新、未开启时的降级，以及"改正文/删分块必须清掉问题
// 向量"这条索引一致性。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-d2q-'));
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
    c.set('user', { id: 'u-owner', username: 'owner', role: 'user' });
    await next();
  },
  adminRoleMiddleware: async (_c: any, next: any) => {
    await next();
  },
}));

const {
  initDatabase,
  getKbChunk,
  getChunkGeneratedQuestions,
  getKbChunksByDocument,
  vectorSearchChunkVariants,
  listChunksForDocument,
} = await import('../../src/db.js');
const { searchChunks } = await import('../../src/kb/search.js');
const { saveEmbeddingConfig } = await import('../../src/embedding.js');
const { saveRagConfig } = await import('../../src/kb/rag.js');
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

function fakeVector(text: string, dim = 8): number[] {
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    out[i % dim] += text.codePointAt(i)! % 97;
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

const DOC_TITLE = 'guide.md';

/** 正文里**不出现**这段字，它只作为"预生成问题"进索引。 */
const QUESTION_ONLY_PHRASE = '量子退相干时间应该怎么测量';
/** 中文 15 字，字节数远超 5，能过解析门槛。 */
const GEN_QUESTION = QUESTION_ONLY_PHRASE;

const DOC_BODY = [
  '# 测量手册',
  '',
  '本章说明仪器的校准流程与常见误差来源，包含温漂补偿的完整步骤。',
  '',
  '## 注意事项',
  '',
  '每次开机后需要预热十五分钟，否则读数会偏低。',
].join('\n');

function waitForIngest(docId: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      const res = await req('GET', `${BASE}/documents/${docId}`);
      const status = ((await res.json()) as any).document.parse_status as string;
      if (status === 'ready' || status === 'failed') return status;
      if (Date.now() > deadline) throw new Error(`ingest timeout, last status=${status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
}

/** 每次 chat 调用收到的请求体，用来断言提示词与采样参数。 */
let chatCalls: Array<Record<string, unknown>> = [];
/**
 * 让接下来 N 次生成调用返回 500（测"单块失败只跳过它"）。
 * 用次数而不是"提示词包含某段字"来判定：分块之间有重叠，按内容匹配会一次命中
 * 好几块，`skipped` 就变成不确定的数了。
 */
let failChatTimes = 0;
/**
 * 让入库阶段的分块嵌入失败（分块落库但 embedding 为空）。按正文特征词判定：
 * '校准流程' 只在文档正文里出现，桩模型返回的问题文本里没有它，所以生成问题
 * 那一步的嵌入不受影响。
 */
let failEmbedForBody = false;
/** 生成调用返回前执行的副作用，用来构造"生成期间正文被改"。 */
let onChat: ((chunkIdHint: string) => void) | null = null;

let docKbId = '';
let docId = '';
let firstChunkId = '';

async function uploadDoc(
  kbId: string,
  filename: string,
  body: string,
  chunkSize?: number,
): Promise<string> {
  const fd = new FormData();
  fd.set('file', new File([body], filename, { type: 'text/plain' }));
  // 分块大小按需收窄：默认 512 会把这段短文切成一块，而"单块失败只跳过它"
  // 这条要至少两块才测得出。
  if (chunkSize) fd.set('chunk_size', String(chunkSize));
  const up = await app.request(`${BASE}/${kbId}/documents`, {
    method: 'POST',
    headers: { 'x-test-user': 'u-owner' },
    body: fd,
  });
  expect(up.status).toBe(201);
  const id = ((await up.json()) as any).document.id as string;
  expect(await waitForIngest(id)).toBe('ready');
  return id;
}

async function createKb(name: string, questionGenerationConfig?: Record<string, unknown>) {
  const res = await req('POST', BASE, {
    name,
    ...(questionGenerationConfig ? { question_generation_config: questionGenerationConfig } : {}),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).knowledge_base.id as string;
}

beforeAll(async () => {
  await initDatabase();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/chat/completions')) {
        const body = JSON.parse(init.body as string) as {
          messages: Array<{ role: string; content: string }>;
          model: string;
          temperature: number;
          max_tokens: number;
        };
        chatCalls.push(body as unknown as Record<string, unknown>);
        if (onChat) {
          const hook = onChat;
          onChat = null;
          hook('');
        }
        if (failChatTimes > 0) {
          failChatTimes--;
          return new Response('model exploded', { status: 500 });
        }
        // 模型输出故意带序号与空行，顺带验证解析规则在真实链路上生效。
        const text = `1. ${GEN_QUESTION}\n\n2. 温漂补偿的步骤是什么\n- 仪器预热需要多久\n`;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: text } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const body = JSON.parse(init.body as string) as { input: string[] };
      if (failEmbedForBody && body.input.some((t) => t.includes('校准流程'))) {
        return new Response('embedding backend down', { status: 503 });
      }
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
  // baseUrl/apiKey 走 embedding 的回退，只需要给 chat 一个模型名。
  saveRagConfig({ model: 'test-chat' });

  docKbId = await createKb('d2q-kb', { enabled: true, question_count: 3 });
  docId = await uploadDoc(docKbId, DOC_TITLE, DOC_BODY);
  firstChunkId = listChunksForDocument(docId)[0].id;
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function resetStubs() {
  chatCalls = [];
  failChatTimes = 0;
  failEmbedForBody = false;
  onChat = null;
}

describe('配置面', () => {
  test('未传配置时回显"关着的默认值"', async () => {
    const kbId = await createKb('d2q-default');
    const res = await req('GET', `${BASE}/${kbId}`);
    const kb = ((await res.json()) as any).knowledge_base;
    expect(kb.questionGenerationConfig).toEqual({
      enabled: false,
      questionCount: 3,
      customInstructions: '',
    });
  });

  test('question_count 越界被夹取，自定义指令原样保留', async () => {
    const kbId = await createKb('d2q-clamp', {
      enabled: true,
      question_count: 99,
      custom_instructions: '问题里必须带上模块名',
    });
    const kb = ((await (await req('GET', `${BASE}/${kbId}`)).json()) as any).knowledge_base;
    expect(kb.questionGenerationConfig.questionCount).toBe(10);
    expect(kb.questionGenerationConfig.customInstructions).toBe('问题里必须带上模块名');
  });

  test('PATCH 是部分更新：只改开关不会把条数打回默认', async () => {
    const kbId = await createKb('d2q-patch', { enabled: false, question_count: 7 });
    const res = await req('PATCH', `${BASE}/${kbId}`, {
      question_generation_config: { enabled: true },
    });
    expect(res.status).toBe(200);
    const kb = ((await res.json()) as any).knowledge_base;
    expect(kb.questionGenerationConfig).toEqual({
      enabled: true,
      questionCount: 7,
      customInstructions: '',
    });
  });

  test('未开启时生成接口降级为 400 且带 disabled 标记，不抛错', async () => {
    resetStubs();
    const kbId = await createKb('d2q-off');
    const res = await req('POST', `${BASE}/${kbId}/generate-questions`, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.disabled).toBe(true);
    expect(chatCalls).toHaveLength(0);
  });
});

describe('生成与落库', () => {
  test('调用参数与提示词：temperature 0.7 / max_tokens 512 / 只有 user 一条', async () => {
    resetStubs();
    const res = await req('POST', `${BASE}/${docKbId}/generate-questions`, {});
    expect(res.status).toBe(200);

    expect(chatCalls.length).toBeGreaterThan(0);
    const call = chatCalls[0];
    expect(call.model).toBe('test-chat');
    expect(call.temperature).toBe(0.7);
    expect(call.max_tokens).toBe(512);
    const messages = call.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    // 文档名与正文都进了提示词，占位符不留字面量
    expect(messages[0].content).toContain(`Document name: ${DOC_TITLE}`);
    expect(messages[0].content).toContain('温漂补偿');
    expect(messages[0].content).not.toContain('{{');
  });

  test('解析结果（剥序号、跳空行）写回 metadata，并记下生成时的 revision', async () => {
    const chunk = getKbChunk(firstChunkId)!;
    const questions = getChunkGeneratedQuestions(firstChunkId).map((q) => q.question);
    expect(questions).toEqual([
      GEN_QUESTION,
      '温漂补偿的步骤是什么',
      '仪器预热需要多久',
    ]);
    const meta = JSON.parse(chunk.metadata!) as any;
    expect(meta.generated_questions_revision).toBe(chunk.content_revision ?? 1);
    expect(meta.generated_questions.every((q: any) => q.id.startsWith('q'))).toBe(true);
  });

  test('问题向量落进 generated_question 来源，不污染 faq_variant', async () => {
    const variants = vectorSearchChunkVariants(
      [docKbId],
      new Float32Array(fakeVector(`${DOC_TITLE}\n${GEN_QUESTION}`)),
      10,
      'generated_question',
    );
    expect(variants.map((v) => v.chunk_id)).toContain(firstChunkId);

    const faqVariants = vectorSearchChunkVariants(
      [docKbId],
      new Float32Array(fakeVector(`${DOC_TITLE}\n${GEN_QUESTION}`)),
      10,
      'faq_variant',
    );
    expect(faqVariants).toHaveLength(0);
  });

  test('分块列表接口回显已生成的问题', async () => {
    const res = await req('GET', `${BASE}/documents/${docId}/chunks`);
    const chunks = ((await res.json()) as any).chunks as any[];
    const first = chunks.find((c) => c.id === firstChunkId)!;
    expect(first.generated_questions).toContain(GEN_QUESTION);
    expect(first.content_revision).toBeGreaterThanOrEqual(1);
  });
});

describe('预生成问题真的扩大了召回', () => {
  // 这一组刻意用**自身没有向量**的分块：如果分块自己带着 embedding，
  // "搜到了"就可能是分块正文向量挣来的，跟问题有没有进索引无关 —— 那种测试
  // 把 generated_question 那一支删掉照样通过，等于没测。
  // 所以先把分块的嵌入打掉（入库时嵌入服务故障，分块留下但没向量，这是上游允许
  // 的真实状态：生成问题的合格判定只看 KB 有没有配嵌入模型），再断言它还能被
  // 一句"只作为预生成问题出现过"的问法召回。此时可检索的路径只剩问题索引一条。
  let bareKbId = '';
  let bareDocId = '';
  let bareChunkId = '';

  beforeAll(async () => {
    resetStubs();
    bareKbId = await createKb('d2q-bare', { enabled: true, question_count: 3 });
    // 入库阶段让嵌入失败 → 分块落库但 embedding 为空
    failEmbedForBody = true;
    bareDocId = await uploadDoc(bareKbId, DOC_TITLE, DOC_BODY, 40);
    failEmbedForBody = false;
    bareChunkId = listChunksForDocument(bareDocId)[0].id;

    const gen = await req('POST', `${BASE}/${bareKbId}/generate-questions`, {});
    expect(gen.status).toBe(200);
  });

  test('前提：该分块自身没有向量，正文里也没有那句问法', () => {
    expect(getKbChunk(bareChunkId)!.embedding).toBeNull();
    expect(
      listChunksForDocument(bareDocId).some((c) => c.content.includes(QUESTION_ONLY_PHRASE)),
    ).toBe(false);
  });

  test('向量臂能召回它，且得分是"问题向量"而非"正文向量"的相似度', async () => {
    const { hits } = await searchChunks({
      kbIds: [bareKbId],
      query: QUESTION_ONLY_PHRASE,
      limit: 5,
      mode: 'vector',
      queryEmbedding: new Float32Array(fakeVector(`${DOC_TITLE}\n${GEN_QUESTION}`)),
    });
    const hit = hits.find((h) => h.chunkId === bareChunkId);
    expect(hit).toBeDefined();
    // 索引里的正文是 `文档名\n问题`，与查询向量同源 → 相似度恰好 1。
    // 分块自身那一路不可能给出 1（而且它压根没有向量），所以这个分数就是
    // "命中来自预生成问题索引"的直接证据。
    // 这里不用"换一句无关查询就召不回"做对照：变体检索是精确 KNN，没有分数
    // 阈值，任何查询都会把最近的变体取回来，那种对照区分不出任何东西。
    expect(hit!.score).toBeGreaterThan(0.999);
  });

  test('命中的是问题的父分块，返回的正文不含那句问题本身', async () => {
    const { hits } = await searchChunks({
      kbIds: [bareKbId],
      query: QUESTION_ONLY_PHRASE,
      limit: 5,
      mode: 'vector',
      queryEmbedding: new Float32Array(fakeVector(`${DOC_TITLE}\n${GEN_QUESTION}`)),
    });
    const hit = hits.find((h) => h.chunkId === bareChunkId)!;
    expect(hit.content).not.toContain(QUESTION_ONLY_PHRASE);
    expect(hit.content).toBe(getKbChunk(bareChunkId)!.content);
  });

  test('关键词臂召不回（预生成问题只进向量索引，不进关键词索引）', async () => {
    const keyword = await searchChunks({
      kbIds: [bareKbId],
      query: QUESTION_ONLY_PHRASE,
      limit: 5,
      mode: 'keyword',
    });
    expect(keyword.hits.map((h) => h.chunkId)).not.toContain(bareChunkId);
  });
});

describe('失败与并发', () => {
  test('单个分块调用失败只跳过它，其余分块照常生成', async () => {
    resetStubs();
    const kbId = await createKb('d2q-partial', { enabled: true, question_count: 2 });
    const id = await uploadDoc(kbId, DOC_TITLE, DOC_BODY, 40);
    const chunkIds = listChunksForDocument(id).map((c) => c.id);
    expect(chunkIds.length).toBeGreaterThanOrEqual(2);

    // 只让第一个分块的调用失败（分块按 chunk_index 升序处理，第一次调用即第一块）
    failChatTimes = 1;

    const res = await req('POST', `${BASE}/${kbId}/generate-questions`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.skipped).toBe(1);
    expect(body.generated).toBe(chunkIds.length - 1);
    expect(getChunkGeneratedQuestions(chunkIds[0])).toHaveLength(0);
    expect(getChunkGeneratedQuestions(chunkIds[1]).length).toBeGreaterThan(0);
  });

  test('生成期间正文被改过 → 结果丢弃、不写回', async () => {
    resetStubs();
    const kbId = await createKb('d2q-stale', { enabled: true, question_count: 2 });
    const id = await uploadDoc(kbId, DOC_TITLE, DOC_BODY);
    const target = listChunksForDocument(id)[0].id;

    // 模型返回之前，把这块的正文改掉（content_revision 自增）
    const { updateKbChunkContent } = await import('../../src/db.js');
    onChat = () => {
      updateKbChunkContent(target, '彻底换掉的正文内容');
    };

    const res = await req('POST', `${BASE}/${kbId}/generate-questions`, {});
    const body = (await res.json()) as any;
    expect(body.stale).toBeGreaterThanOrEqual(1);
    expect(getChunkGeneratedQuestions(target)).toHaveLength(0);
    // 丢弃后不应留下向量索引条目
    const variants = vectorSearchChunkVariants(
      [kbId],
      new Float32Array(fakeVector(`${DOC_TITLE}\n${GEN_QUESTION}`)),
      10,
      'generated_question',
    );
    expect(variants.map((v) => v.chunk_id)).not.toContain(target);
  });

  test('自定义指令会出现在提示词里', async () => {
    resetStubs();
    const kbId = await createKb('d2q-custom', {
      enabled: true,
      question_count: 2,
      custom_instructions: '问题里必须带上模块名',
    });
    await uploadDoc(kbId, DOC_TITLE, DOC_BODY);
    await req('POST', `${BASE}/${kbId}/generate-questions`, {});
    const prompt = (chatCalls[0].messages as Array<{ content: string }>)[0].content;
    expect(prompt).toContain('问题里必须带上模块名');
    expect(prompt).toContain('Follow the business instructions above');
  });
});

describe('索引一致性：正文变了 / 分块没了', () => {
  test('改正文会清掉该分块的预生成问题向量与 metadata', async () => {
    const { updateKbChunkContent, patchChunkMetadata } = await import('../../src/db.js');
    const kbId = await createKb('d2q-edit', { enabled: true, question_count: 2 });
    const id = await uploadDoc(kbId, DOC_TITLE, DOC_BODY);
    const target = listChunksForDocument(id)[0].id;

    await req('POST', `${BASE}/${kbId}/generate-questions`, {});
    expect(getChunkGeneratedQuestions(target).length).toBeGreaterThan(0);
    expect(
      vectorSearchChunkVariants(
        [kbId],
        new Float32Array(fakeVector(`${DOC_TITLE}\n${GEN_QUESTION}`)),
        10,
        'generated_question',
      ).length,
    ).toBeGreaterThan(0);

    updateKbChunkContent(target, '改过的正文');
    expect(
      vectorSearchChunkVariants(
        [kbId],
        new Float32Array(fakeVector(`${DOC_TITLE}\n${GEN_QUESTION}`)),
        10,
        'generated_question',
      ),
    ).toHaveLength(0);

    // 只清向量而留着 metadata 会让界面显示一批已经不可检索的问题，两边一起清
    patchChunkMetadata(target, { generated_questions: [] });
    expect(getChunkGeneratedQuestions(target)).toHaveLength(0);
  });

  test('删分块会连变体向量一起清，不留指向幽灵 chunk 的条目', async () => {
    const { deleteKbChunk } = await import('../../src/db.js');
    const kbId = await createKb('d2q-del', { enabled: true, question_count: 2 });
    const id = await uploadDoc(kbId, DOC_TITLE, DOC_BODY);
    const target = listChunksForDocument(id)[0].id;

    await req('POST', `${BASE}/${kbId}/generate-questions`, {});
    expect(
      vectorSearchChunkVariants(
        [kbId],
        new Float32Array(fakeVector(`${DOC_TITLE}\n${GEN_QUESTION}`)),
        10,
        'generated_question',
      ).length,
    ).toBeGreaterThan(0);

    expect(deleteKbChunk(target)).toBe(true);
    expect(
      vectorSearchChunkVariants(
        [kbId],
        new Float32Array(fakeVector(`${DOC_TITLE}\n${GEN_QUESTION}`)),
        10,
        'generated_question',
      ),
    ).toHaveLength(0);
  });
});
