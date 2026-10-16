/**
 * 扫描件 OCR：把没有文字层的 PDF 渲染成图片，再交给本机视觉模型转写成文本。
 *
 * 为什么不是 tesseract / PaddleOCR：真正要处理的扫描件是**表格**。传统 OCR 引擎
 * 的输出是按行拼接的散字，表格的行列关系丢失，一行里的三个单元格会被拼成一句话，
 * 检索时语义完全错乱。视觉模型可以直接按 markdown 表格输出，行列结构留在文本里。
 *
 * 为什么不在上传请求里同步做：287 页 × 每页数秒 = 半小时起步，HTTP 请求必然超时。
 * 因此 OCR 走后台任务，上传接口立刻返回，前端轮询 parse_status（见 kb/ocr-ingest.ts）。
 *
 * 依赖：pdfjs-dist + @napi-rs/canvas —— 两者都是 pdf-parse 的传递依赖，已经在依赖树里，
 * 所以光栅化不需要新增任何 npm 包。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { localModelBaseUrl, RECOMMENDED_VISION_MODEL } from './local-model.js';

const OCR_CONFIG_PATH = path.join(DATA_DIR, 'config', 'ocr.json');

/**
 * 每页 OCR 的默认超时。
 *
 * 定得比"够用"宽很多是有依据的：8B 视觉模型单页实测 80–160s（带思维链的模型更慢），
 * 按 5 秒去设会让正常页面被判成超时。超时只是兜底，不是性能预算。
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * 视觉模型的调用协议。
 *
 * `'ollama'` 走原生 `/api/chat`，`'openai'` 走 `/v1/chat/completions`。
 *
 * 为什么要分两套 —— 因为 **Ollama 的 OpenAI 兼容端点会静默忽略 `num_ctx`**。
 * 实测：在 `/v1/chat/completions` 里传 `options.num_ctx = 16384`，`/api/ps` 显示
 * 模型仍然是 `ctx=4096`。而 Ollama 默认上下文只有 4096，一页 150dpi 的扫描图
 * 光图片就占掉约 2200 token；带思维链的模型（qwen3-vl）再把剩下的额度全用在
 * reasoning 上，就会以 `done_reason: "length"` 收尾、**content 为空**。
 *
 * 那个空不是"这页是空白页"，是"模型没写完"。当成空白页处理就会静默丢页 ——
 * 287 页的扫描件丢到只剩几十页，而且没有任何报错。所以协议必须分开。
 */
export type OcrProvider = 'ollama' | 'openai';

export interface OcrConfig {
  enabled: boolean;
  provider: OcrProvider;
  /** 服务根地址；为 null 时跟随本机模型服务（`http://127.0.0.1:11434`）。 */
  baseUrl: string | null;
  apiKey: string;
  model: string;
  dpi: number;
  maxPages: number;
  concurrency: number;
  timeoutMs: number;
  /** 单页像素上限，超过则等比缩小 —— 大画幅扫描页不设上限会直接把内存打满。 */
  maxPixels: number;
  /** 仅 `provider: 'ollama'` 生效。默认 4096 装不下一张扫描图 + 思维链。 */
  numCtx: number;
}

export const DEFAULT_OCR_CONFIG: OcrConfig = {
  enabled: true,
  provider: 'ollama',
  baseUrl: null,
  apiKey: 'ollama',
  model: RECOMMENDED_VISION_MODEL,
  dpi: 150,
  maxPages: 300,
  concurrency: 2,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxPixels: 6_000_000,
  numCtx: 16384,
};

let cached: OcrConfig | undefined;

export function getOcrConfig(): OcrConfig {
  try {
    if (!fs.existsSync(OCR_CONFIG_PATH)) {
      cached = DEFAULT_OCR_CONFIG;
      return cached;
    }
    const raw = JSON.parse(fs.readFileSync(OCR_CONFIG_PATH, 'utf8')) as Partial<OcrConfig>;
    cached = sanitizeOcrConfig({ ...DEFAULT_OCR_CONFIG, ...raw });
    return cached;
  } catch {
    cached = DEFAULT_OCR_CONFIG;
    return cached;
  }
}

export function saveOcrConfig(patch: Partial<OcrConfig>): OcrConfig {
  const merged = sanitizeOcrConfig({ ...getOcrConfig(), ...patch });
  const dir = path.dirname(OCR_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${OCR_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, OCR_CONFIG_PATH);
  cached = undefined;
  return merged;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeOcrConfig(cfg: OcrConfig): OcrConfig {
  return {
    enabled: cfg.enabled !== false,
    provider: cfg.provider === 'openai' ? 'openai' : 'ollama',
    baseUrl: cfg.baseUrl ? String(cfg.baseUrl).replace(/\/+$/, '') : null,
    apiKey: cfg.apiKey ? String(cfg.apiKey) : 'ollama',
    model: cfg.model ? String(cfg.model) : RECOMMENDED_VISION_MODEL,
    dpi: clampInt(cfg.dpi, 72, 400, DEFAULT_OCR_CONFIG.dpi),
    maxPages: clampInt(cfg.maxPages, 1, 5000, DEFAULT_OCR_CONFIG.maxPages),
    concurrency: clampInt(cfg.concurrency, 1, 8, DEFAULT_OCR_CONFIG.concurrency),
    timeoutMs: clampInt(cfg.timeoutMs, 10_000, 600_000, DEFAULT_TIMEOUT_MS),
    maxPixels: clampInt(cfg.maxPixels, 250_000, 40_000_000, DEFAULT_OCR_CONFIG.maxPixels),
    numCtx: clampInt(cfg.numCtx, 2048, 131_072, DEFAULT_OCR_CONFIG.numCtx),
  };
}

/** 服务根地址（不含任何协议路径），供界面显示与两套协议各自拼路径。 */
export function ocrBaseUrl(cfg: OcrConfig = getOcrConfig()): string {
  return cfg.baseUrl ?? localModelBaseUrl();
}

/**
 * 实际会被请求的完整地址。放在这里是因为界面上必须显示**真正会打的那个地址** ——
 * 只为展示而拼一个"看起来对"的 URL，切换协议后界面就会撒谎。
 */
export function ocrEndpoint(cfg: OcrConfig = getOcrConfig()): string {
  return cfg.provider === 'openai' ? openAiChatUrl(cfg) : `${ocrBaseUrl(cfg)}/api/chat`;
}

function openAiChatUrl(cfg: OcrConfig): string {
  const base = ocrBaseUrl(cfg);
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

// ─── 光栅化 ────────────────────────────────────────────────

/** pdfjs-dist 的最小类型面 —— 我们只用得到渲染，不引它的类型定义以免绑死版本。 */
interface PdfJsViewport {
  width: number;
  height: number;
}
interface PdfJsPage {
  getViewport(params: { scale: number }): PdfJsViewport;
  render(params: { canvasContext: unknown; viewport: PdfJsViewport }): { promise: Promise<void> };
  cleanup(): void;
}
interface PdfJsDocument {
  numPages: number;
  getPage(n: number): Promise<PdfJsPage>;
  destroy(): Promise<void>;
}
interface PdfJsModule {
  getDocument(src: {
    data: Uint8Array;
    useSystemFonts?: boolean;
    isEvalSupported?: boolean;
  }): { promise: Promise<PdfJsDocument> };
}

async function loadPdfJs(): Promise<{ pdfjs: PdfJsModule; createCanvas: (w: number, h: number) => any }> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsModule;
  const canvasMod = (await import('@napi-rs/canvas')) as unknown as {
    createCanvas: (w: number, h: number) => any;
  };
  return { pdfjs, createCanvas: canvasMod.createCanvas };
}

export interface RasterizedPage {
  pageNumber: number;
  png: Buffer;
  width: number;
  height: number;
}

/**
 * 逐页光栅化并回调，**不把整本 PDF 的图片攒在内存里**。
 *
 * 287 页 × 每页约 400KB PNG ≈ 115MB，攒着不算致命，但并发 OCR 时还要再复制一份
 * base64（+33%），叠加视觉模型本身的内存占用就没必要了。逐页吐出去，调用方
 * OCR 完即可释放。
 */
export async function forEachPdfPagePng(
  buf: Buffer,
  cfg: OcrConfig,
  onPage: (page: RasterizedPage) => Promise<void>,
  onRasterized?: (pageNumber: number, totalPages: number) => void,
): Promise<{ totalPages: number; renderedPages: number; truncated: boolean }> {
  const { pdfjs, createCanvas } = await loadPdfJs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
  }).promise;

  const totalPages = doc.numPages;
  const limit = Math.min(totalPages, cfg.maxPages);
  const baseScale = cfg.dpi / 72;
  let renderedPages = 0;

  try {
    for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        let viewport = page.getViewport({ scale: baseScale });
        // 像素上限保护：等比缩放到 maxPixels 以内。
        const pixels = viewport.width * viewport.height;
        if (pixels > cfg.maxPixels) {
          const shrink = Math.sqrt(cfg.maxPixels / pixels);
          viewport = page.getViewport({ scale: baseScale * shrink });
        }
        const width = Math.max(1, Math.floor(viewport.width));
        const height = Math.max(1, Math.floor(viewport.height));
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        // 扫描件底白字黑，先铺白底：PDF 的透明背景渲染成 PNG 后是黑的，
        // 直接喂给视觉模型会得到"图全黑"的结果。
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const png = canvas.toBuffer('image/png');
        renderedPages++;
        onRasterized?.(pageNumber, totalPages);
        await onPage({ pageNumber, png, width, height });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  return { totalPages, renderedPages, truncated: totalPages > limit };
}

// ─── 视觉模型转写 ───────────────────────────────────────────

/**
 * OCR 提示词。三条约束缺一不可：
 * - 不许总结：视觉模型默认行为是"描述这张图"，对表格会给出概括而不是转写；
 * - 表格转 markdown：这正是弃用传统 OCR 的理由，行列关系必须保住；
 * - 只输出正文：模型爱加"这张图片显示了…"的前言，那会作为噪声进知识库。
 */
const OCR_PROMPT = [
  '你是 OCR 引擎。请把这张扫描页图片完整转写为 Markdown 文本。',
  '要求：',
  '1. 逐字转写，不要总结、不要翻译、不要解释、不要补充图中没有的内容。',
  '2. 表格必须转写为 Markdown 表格，保留行列结构；合并单元格在其覆盖的每个位置重复内容。',
  '3. 标题用 # 标记，列表项用 - 标记，正文段落之间空一行。',
  '4. 无法辨认的字符用 □ 代替；空白页直接输出空内容。',
  '5. 只输出转写结果本身，不要任何前后说明。',
].join('\n');

/** 模型吐出的原始结果，先把"截断"和"空"区分开，再决定怎么当正文用。 */
interface VisionOutput {
  content: string;
  /** 输出被上下文/长度上限截断 —— 这不是空白页，是失败。 */
  truncated: boolean;
  /** 思维链长度，仅用于诊断信息。 */
  reasoningChars: number;
}

/**
 * 截断与空白必须分开处理。
 *
 * 视觉模型（尤其带思维链的）在上下文不够时，会把额度全花在 reasoning 上，
 * 然后以 `done_reason: "length"` 收尾、content 为空。旧代码只看 content，
 * 于是把它记成"空白页"跳过 —— 287 页的扫描件可能静默丢掉大半，且不报任何错。
 * 这里宁可把这一页记成失败（正文里留痕「第 N 页 OCR 失败」），也不假装它是空白。
 */
function assertNotTruncated(out: VisionOutput, cfg: OcrConfig): string {
  if (out.truncated) {
    throw new Error(
      `输出被截断（模型上下文不足，思维链占了 ${out.reasoningChars} 字符后未产出正文）。` +
        `请改用非思维链模型，或调大 ocr.json 的 numCtx（当前 ${cfg.numCtx}）。`,
    );
  }
  if (!out.content && out.reasoningChars > 0) {
    // 有些模型不带 done_reason，但"只有思维链、没有正文"是同一个故障的另一种表现。
    throw new Error(
      `模型只输出了思维链（${out.reasoningChars} 字符）而没有正文，通常意味着上下文不足被截断。`,
    );
  }
  return out.content.trim();
}

/** Ollama 原生 `/api/chat` —— 只有这条路会尊重 `num_ctx`。 */
async function ocrViaOllama(png: Buffer, cfg: OcrConfig, signal: AbortSignal): Promise<VisionOutput> {
  const res = await fetch(`${ocrBaseUrl(cfg)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      // keep_alive 用默认值（5 分钟）：287 页连续识别不会让模型被卸载重载。
      options: { temperature: 0, num_ctx: cfg.numCtx },
      messages: [
        { role: 'user', content: OCR_PROMPT, images: [png.toString('base64')] },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`视觉模型返回 HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    message?: { content?: string; thinking?: string };
    done_reason?: string;
  };
  const thinking = json.message?.thinking ?? '';
  return {
    content: json.message?.content ?? '',
    truncated: json.done_reason === 'length',
    reasoningChars: thinking.length,
  };
}

/** OpenAI 兼容 `/v1/chat/completions` —— 给非 Ollama 的服务用；注意它不认 `num_ctx`。 */
async function ocrViaOpenAi(png: Buffer, cfg: OcrConfig, signal: AbortSignal): Promise<VisionOutput> {
  const res = await fetch(openAiChatUrl(cfg), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
            },
          ],
        },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`视觉模型返回 HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string; reasoning?: string; reasoning_content?: string };
      finish_reason?: string;
    }>;
  };
  const choice = json.choices?.[0];
  const msg = choice?.message;
  const reasoning = msg?.reasoning ?? msg?.reasoning_content ?? '';
  return {
    content: msg?.content ?? '',
    truncated: choice?.finish_reason === 'length',
    reasoningChars: reasoning.length,
  };
}

async function ocrPageWithVision(png: Buffer, cfg: OcrConfig): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const out =
      cfg.provider === 'openai'
        ? await ocrViaOpenAi(png, cfg, controller.signal)
        : await ocrViaOllama(png, cfg, controller.signal);
    return assertNotTruncated(out, cfg);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`单页 OCR 超时（>${Math.round(cfg.timeoutMs / 1000)}s）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 编排 ──────────────────────────────────────────────────

export interface OcrResult {
  text: string;
  totalPages: number;
  ocrPages: number;
  emptyPages: number;
  failedPages: Array<{ pageNumber: number; error: string }>;
  truncated: boolean;
  model: string;
}

export interface OcrProgress {
  stage: 'rasterizing' | 'ocr' | 'done';
  pageNumber: number;
  totalPages: number;
  donePages: number;
  failedPages: number;
}

/**
 * 整本 PDF 走一遍 OCR。
 *
 * 单页失败不中断整本 —— 287 页里有 2 页模型抽风，丢掉另外 285 页的正确结果是最差的选择。
 * 但**全部页失败**必须抛错：那说明服务/模型/协议有问题，静默返回空文本会让用户以为
 * "这本书是空的"。
 */
export async function ocrPdf(
  buf: Buffer,
  opts?: { config?: OcrConfig; onProgress?: (p: OcrProgress) => void },
): Promise<OcrResult> {
  const cfg = opts?.config ?? getOcrConfig();
  const results = new Map<number, string>();
  const failedPages: Array<{ pageNumber: number; error: string }> = [];
  let totalPages = 0;
  let donePages = 0;

  const runPage = async (page: RasterizedPage): Promise<void> => {
    try {
      const text = await ocrPageWithVision(page.png, cfg);
      results.set(page.pageNumber, text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedPages.push({ pageNumber: page.pageNumber, error: message });
      logger.warn({ pageNumber: page.pageNumber, err: message }, 'OCR page failed');
    } finally {
      donePages++;
      opts?.onProgress?.({
        stage: 'ocr',
        pageNumber: page.pageNumber,
        totalPages,
        donePages,
        failedPages: failedPages.length,
      });
    }
  };

  // 有界并发：把光栅化结果立刻投给 OCR 工作池，避免"先全部渲染再全部识别"。
  const queue: Array<Promise<void>> = [];
  let active = 0;
  let waiters: Array<() => void> = [];
  // 用 while 复检而不是 if：release() 里唤醒 waiter 是异步的，这中间可能有新的
  // acquire() 抢走名额。while 保证被唤醒者拿不到名额时重新排队，并发数不会被突破。
  const acquire = async (): Promise<void> => {
    while (active >= cfg.concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
  };
  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };

  const raster = await forEachPdfPagePng(
    buf,
    cfg,
    async (page) => {
      await acquire();
      const task = runPage(page).finally(release);
      queue.push(task);
      // 池满时等待最早的任务完成，防止 queue 无限增长抢内存。
      if (queue.length >= cfg.concurrency * 4) {
        await Promise.all(queue.splice(0, queue.length));
      }
    },
    (pageNumber, total) => {
      totalPages = total;
      opts?.onProgress?.({
        stage: 'rasterizing',
        pageNumber,
        totalPages: total,
        donePages,
        failedPages: failedPages.length,
      });
    },
  );
  await Promise.all(queue);
  totalPages = raster.totalPages;

  const successful = raster.renderedPages - failedPages.length;
  if (raster.renderedPages > 0 && successful <= 0) {
    throw new Error(
      `OCR 全部失败（${failedPages.length}/${raster.renderedPages} 页）：${failedPages[0]?.error ?? '未知错误'}`,
    );
  }

  // 按页码顺序拼接。空页（真正的空白页 / 模型判定为空白）不输出页码标记 ——
  // 给没有正文的页伪造一条标记，正是 D8 那个缺陷的形态。
  const parts: string[] = [];
  let emptyPages = 0;
  for (let n = 1; n <= raster.renderedPages; n++) {
    const text = results.get(n);
    if (!text) {
      if (text !== undefined) emptyPages++;
      continue;
    }
    parts.push(`【第 ${n} 页】\n${text}`);
  }
  if (raster.truncated) {
    parts.push(
      `【注意：本文件共 ${raster.totalPages} 页，超出单次 OCR 上限（${cfg.maxPages} 页），仅转写了前 ${raster.renderedPages} 页。】`,
    );
  }
  if (failedPages.length > 0) {
    parts.push(
      `【注意：第 ${failedPages.map((f) => f.pageNumber).join('、')} 页 OCR 失败，正文缺失。】`,
    );
  }

  opts?.onProgress?.({
    stage: 'done',
    pageNumber: raster.renderedPages,
    totalPages: raster.totalPages,
    donePages,
    failedPages: failedPages.length,
  });

  return {
    text: parts.join('\n\n').trim(),
    totalPages: raster.totalPages,
    ocrPages: raster.renderedPages,
    emptyPages,
    failedPages,
    truncated: raster.truncated,
    model: cfg.model,
  };
}

// 注意：这里**没有**「同步跑一遍 OCR 再返回正文」的便捷函数。上传路径必须是
// 后台的（见 kb/ocr-ingest.ts），287 页要跑半小时，同步版本只会诱使调用方把
// HTTP 请求挂死。需要同步结果的场景（测试）直接用 parsePdf + ocrPdf 两步。
