/**
 * 扫描件 OCR 编排的回归测试。
 *
 * 这里**不依赖 Ollama**：起一个本地 HTTP 桩冒充 OpenAI 兼容的视觉接口，
 * 需要什么返回就返回什么。理由很实际 —— 真模型是 6GB 的下载，CI 上不可能有；
 * 而真正容易写错的是编排本身（并发、失败容忍、页码标记、截断），不是模型推理。
 * 真实模型的端到端验证在 e2e 脚本里做。
 *
 * 桩的返回内容一律由**收到的图片字节数**推导 —— 每页 PNG 的大小互不相同，
 * 于是"第 N 页的正文"唯一对应"第 N 页的图片"。这样即使并发把调用顺序打乱，
 * 也能断言没有串页，而不是只能断言"有三段不同的文本"。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forEachPdfPagePng, ocrPdf, type OcrConfig } from '../../src/ocr.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'pdf', 'scanned-3p.pdf');

interface StubCall {
  callIndex: number;
  /** 收到的是哪套协议 —— 用来断言 provider 配置真的改变了请求走哪条路。 */
  protocol: 'ollama' | 'openai';
  imageBytes: number;
  /** 请求里带的 num_ctx（只有 Ollama 原生协议有），用于断言它真的传出去了。 */
  numCtx: number | undefined;
}

interface StubResponse {
  status?: number;
  content?: string;
  /** 思维链。用于复现"思维链吃光上下文、正文为空"的故障。 */
  thinking?: string;
  /** 结束原因。`length` 表示被截断。 */
  doneReason?: 'stop' | 'length';
}

let server: http.Server;
let baseUrl = '';
let calls: StubCall[] = [];
let handler: (call: StubCall) => StubResponse = () => ({ content: 'stub' });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const isOllama = url.endsWith('/api/chat');
    const isOpenAi = url.endsWith('/chat/completions');
    if (req.method !== 'POST' || (!isOllama && !isOpenAi)) {
      res.writeHead(404).end('not found');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        options?: { num_ctx?: number };
        messages?: Array<{
          images?: string[];
          content?: Array<{ type?: string; image_url?: { url?: string } }>;
        }>;
      };
      // 两套协议把图片放在不同的位置：原生在 messages[].images[]（裸 base64），
      // OpenAI 兼容在 content[].image_url.url（data URL）。
      const rawImage = isOllama
        ? (body.messages?.[0]?.images?.[0] ?? '')
        : (body.messages?.[0]?.content?.find((p) => p.type === 'image_url')?.image_url?.url ?? '');
      const b64 = rawImage.includes(',') ? rawImage.split(',')[1] : rawImage;
      const call: StubCall = {
        callIndex: calls.length,
        protocol: isOllama ? 'ollama' : 'openai',
        imageBytes: b64 ? Buffer.from(b64, 'base64').length : 0,
        numCtx: body.options?.num_ctx,
      };
      calls.push(call);
      const planned = handler(call);
      if (planned.status && planned.status >= 400) {
        res.writeHead(planned.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          isOllama
            ? {
                message: { content: planned.content ?? '', thinking: planned.thinking },
                done_reason: planned.doneReason ?? 'stop',
              }
            : {
                choices: [
                  {
                    message: { content: planned.content ?? '', reasoning: planned.thinking },
                    finish_reason: planned.doneReason ?? 'stop',
                  },
                ],
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function stubConfig(overrides: Partial<OcrConfig> = {}): OcrConfig {
  return {
    enabled: true,
    provider: 'ollama',
    baseUrl,
    apiKey: 'test',
    model: 'stub-vision',
    dpi: 96,
    maxPages: 50,
    concurrency: 1,
    timeoutMs: 20_000,
    maxPixels: 4_000_000,
    numCtx: 16384,
    ...overrides,
  };
}

const fixture = (): Buffer => fs.readFileSync(FIXTURE);

/** 每页 PNG 的字节数，作为"这一页的图片"的指纹。 */
async function pageFingerprints(cfg: OcrConfig): Promise<Map<number, number>> {
  const sizes = new Map<number, number>();
  await forEachPdfPagePng(fixture(), cfg, async (page) => {
    sizes.set(page.pageNumber, page.png.length);
  });
  return sizes;
}

describe('扫描件夹具的前置条件', () => {
  it('scanned-3p.pdf 是 3 页纯图片 PDF（否则下面的用例全是假通过）', async () => {
    const { parsePdf, PdfHasNoTextLayerError } = await import('../../src/document-parser.js');
    expect(fs.existsSync(FIXTURE)).toBe(true);
    await expect(parsePdf(fixture())).rejects.toBeInstanceOf(PdfHasNoTextLayerError);
  });
});

describe('ocrPdf 编排', () => {
  it('三页全部识别：正文按页拼接、页码与图片一一对应、送出去的是真实 PNG', async () => {
    const cfg = stubConfig();
    const sizes = await pageFingerprints(cfg);
    expect(sizes.size).toBe(3);
    calls = [];
    handler = (call) => ({ content: `BODY-${call.imageBytes}` });

    const result = await ocrPdf(fixture(), { config: cfg });

    expect(result.totalPages).toBe(3);
    expect(result.ocrPages).toBe(3);
    expect(result.failedPages).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.emptyPages).toBe(0);

    // 第 N 页的正文，必须来自第 N 页的图片 —— 页码错位比没有页码更糟。
    for (const [pageNumber, bytes] of sizes) {
      expect(result.text).toContain(`【第 ${pageNumber} 页】\nBODY-${bytes}`);
    }

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.protocol).toBe('ollama');
      expect(call.imageBytes).toBeGreaterThan(1000);
      // num_ctx 必须真的发出去 —— Ollama 默认 4096 装不下"扫描图 + 思维链"。
      expect(call.numCtx).toBe(16384);
    }
  });

  it('provider=openai 时改走 /v1/chat/completions（换服务商只改配置，不改代码）', async () => {
    calls = [];
    handler = (call) => ({ content: `BODY-${call.imageBytes}` });

    const result = await ocrPdf(fixture(), { config: stubConfig({ provider: 'openai' }) });

    expect(result.ocrPages).toBe(3);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.protocol).toBe('openai');
      expect(call.imageBytes).toBeGreaterThan(1000);
    }
  });

  it('单页失败不拖垮整本：其余页照常入库，失败页在正文里留痕', async () => {
    const cfg = stubConfig();
    const sizes = await pageFingerprints(cfg);
    const failingBytes = sizes.get(2);
    calls = [];
    handler = (call) =>
      call.imageBytes === failingBytes ? { status: 500 } : { content: `BODY-${call.imageBytes}` };

    const result = await ocrPdf(fixture(), { config: cfg });

    expect(result.failedPages.map((f) => f.pageNumber)).toEqual([2]);
    expect(result.text).toContain(`BODY-${sizes.get(1)}`);
    expect(result.text).toContain(`BODY-${sizes.get(3)}`);
    expect(result.text).not.toContain('【第 2 页】');
    expect(result.text).toContain('第 2 页 OCR 失败');
  });

  it('全部页失败必须抛错 —— 静默返回空文本会让用户以为这本书是空的', async () => {
    calls = [];
    handler = () => ({ status: 500 });

    await expect(ocrPdf(fixture(), { config: stubConfig() })).rejects.toThrow(/OCR 全部失败/);
  });

  it('空白页不产生页码标记（给无正文的页伪造标记正是 D8 那个缺陷）', async () => {
    const cfg = stubConfig();
    const sizes = await pageFingerprints(cfg);
    const blankBytes = sizes.get(2);
    calls = [];
    handler = (call) =>
      call.imageBytes === blankBytes ? { content: '   ' } : { content: `BODY-${call.imageBytes}` };

    const result = await ocrPdf(fixture(), { config: cfg });

    expect(result.emptyPages).toBe(1);
    expect(result.text).not.toContain('【第 2 页】');
    expect(result.text).toContain('【第 1 页】');
    expect(result.text).toContain('【第 3 页】');
  });

  it('超过 maxPages 时截断，并在正文末尾说明只转写了前 N 页', async () => {
    const cfg = stubConfig({ maxPages: 2 });
    calls = [];
    handler = (call) => ({ content: `BODY-${call.imageBytes}` });

    const result = await ocrPdf(fixture(), { config: cfg });

    expect(result.truncated).toBe(true);
    expect(result.totalPages).toBe(3);
    expect(result.ocrPages).toBe(2);
    expect(result.text).toContain('仅转写了前 2 页');
    expect(result.text).not.toContain('【第 3 页】');
  });

  it('并发 3 时仍然没有串页（每页正文对应的是该页自己的图片）', async () => {
    const cfg = stubConfig({ concurrency: 3 });
    const sizes = await pageFingerprints(cfg);
    calls = [];
    handler = (call) => ({ content: `BODY-${call.imageBytes}` });

    const result = await ocrPdf(fixture(), { config: cfg });

    expect(result.ocrPages).toBe(3);
    for (const [pageNumber, bytes] of sizes) {
      expect(result.text).toContain(`【第 ${pageNumber} 页】\nBODY-${bytes}`);
    }
  });

  it('resolvedBaseUrl 落在本机模型服务上（本机模式的默认指向）', async () => {
    const { ocrBaseUrl, ocrEndpoint } = await import('../../src/ocr.js');
    const local = { ...stubConfig(), baseUrl: null };
    expect(ocrBaseUrl(local)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(ocrEndpoint(local)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/chat$/);
    expect(ocrEndpoint({ ...local, provider: 'openai' })).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/,
    );
    // 用户显式填的地址已带 /v1 时不能再拼一层
    expect(ocrEndpoint({ ...local, provider: 'openai', baseUrl: 'https://api.x.com/v1' })).toBe(
      'https://api.x.com/v1/chat/completions',
    );
  });
});

/**
 * 这一组用例锁定的是一个**真实发生过的静默丢页**：
 * qwen3-vl:8b 是思维链模型，Ollama 默认上下文只有 4096，一页扫描图占掉约 2200 token，
 * 模型把剩下的额度全用在 reasoning 上，最后以 done_reason="length" 收尾、content 为空。
 * 旧代码把这个空当成"空白页"跳过 —— 实测 3 页只留下 1 页，且不报任何错。
 */
describe('截断必须被当成失败，而不是空白页', () => {
  it('done_reason=length 的页记成失败并留痕，不冒充空白页', async () => {
    const cfg = stubConfig();
    const sizes = await pageFingerprints(cfg);
    const truncatedBytes = sizes.get(2);
    calls = [];
    handler = (call) =>
      call.imageBytes === truncatedBytes
        ? { content: '', thinking: '让我先看看这张图……', doneReason: 'length' }
        : { content: `BODY-${call.imageBytes}` };

    const result = await ocrPdf(fixture(), { config: cfg });

    expect(result.failedPages.map((f) => f.pageNumber)).toEqual([2]);
    expect(result.failedPages[0].error).toMatch(/截断/);
    // 关键：**不能**记成 emptyPages —— 那正是丢页而不报错的那条路。
    expect(result.emptyPages).toBe(0);
    expect(result.text).toContain('第 2 页 OCR 失败');
    expect(result.text).toContain(`BODY-${sizes.get(1)}`);
    expect(result.text).toContain(`BODY-${sizes.get(3)}`);
  });

  it('只有思维链没有正文（无 done_reason）同样算失败', async () => {
    calls = [];
    handler = () => ({ content: '', thinking: 'x'.repeat(500) });

    await expect(ocrPdf(fixture(), { config: stubConfig() })).rejects.toThrow(/思维链/);
  });

  it('整本都因截断而失败时必须抛错，而不是入库一本空书', async () => {
    calls = [];
    handler = () => ({ content: '', thinking: 'reasoning…', doneReason: 'length' });

    await expect(ocrPdf(fixture(), { config: stubConfig() })).rejects.toThrow(/OCR 全部失败/);
  });

  it('openai 兼容协议下的 finish_reason=length 同样被识别为截断', async () => {
    calls = [];
    handler = () => ({ content: '', thinking: 'reasoning…', doneReason: 'length' });

    await expect(
      ocrPdf(fixture(), { config: stubConfig({ provider: 'openai' }) }),
    ).rejects.toThrow(/OCR 全部失败/);
  });
});
