/**
 * 本机内置模型服务路由。挂载在 /api/paas/local-model。
 *
 * 这一组接口要解决的问题是：管理员手上没有任何 Embedding / 视觉模型的 API Key，
 * 而知识库的向量检索和扫描件 OCR 都需要模型。这里的做法是把本机的开源模型服务
 * （Ollama）当成系统的一部分 —— 探测它、拉起它、下模型、然后把生成的配置写进
 * embedding.json / ocr.json，管理员在界面上点一下就能用。
 *
 * 全部接口仅管理员可访问，且 GET 之外的动作都要求服务真的可用，不做"先写配置再说"。
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, adminRoleMiddleware } from '../middleware/auth.js';
import {
  probeLocalModelService,
  startLocalModelService,
  pullLocalModel,
  probeEmbeddingDimension,
  isModelInstalled,
  normalizeModelName,
  RECOMMENDED_EMBEDDING_MODEL,
  RECOMMENDED_VISION_MODEL,
} from '../local-model.js';
import { getEmbeddingConfig, saveEmbeddingConfig, syncVecDimensionFromConfig } from '../embedding.js';
import { getOcrConfig, saveOcrConfig, ocrBaseUrl, ocrEndpoint } from '../ocr.js';
import { logger } from '../logger.js';

export const paasLocalModelRoute = new Hono<{ Variables: Variables }>();

paasLocalModelRoute.use('*', authMiddleware);
paasLocalModelRoute.use('*', adminRoleMiddleware);

/** Ollama 不校验鉴权头，但 OpenAI 兼容客户端普遍要求它存在，给个占位值。 */
const LOCAL_API_KEY = 'ollama';

/** 当前 embedding 配置是否就指向本机模型服务。 */
function embeddingUsesLocalService(): boolean {
  const config = getEmbeddingConfig();
  if (!config) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/v1$/.test(config.baseUrl);
}

paasLocalModelRoute.get('/', async (c) => {
  const service = await probeLocalModelService();
  const embedding = getEmbeddingConfig();
  const ocr = getOcrConfig();
  return c.json({
    service: {
      available: service.available,
      baseUrl: service.baseUrl,
      version: service.version ?? null,
      error: service.error ?? null,
    },
    models: service.models.map((m) => ({
      name: m.name,
      sizeBytes: m.sizeBytes,
      parameterSize: m.parameterSize ?? null,
      family: m.family ?? null,
    })),
    recommended: {
      embedding: {
        model: RECOMMENDED_EMBEDDING_MODEL,
        installed: isModelInstalled(service.models, RECOMMENDED_EMBEDDING_MODEL),
        active: embedding?.model === normalizeModelName(RECOMMENDED_EMBEDDING_MODEL) && embeddingUsesLocalService(),
      },
      vision: {
        model: RECOMMENDED_VISION_MODEL,
        installed: isModelInstalled(service.models, RECOMMENDED_VISION_MODEL),
        active: ocr.enabled && ocr.model === RECOMMENDED_VISION_MODEL,
      },
    },
    embedding: {
      configured: embedding !== null,
      model: embedding?.model ?? null,
      dimensions: embedding?.dimensions ?? null,
      usingLocalService: embeddingUsesLocalService(),
      baseUrl: embedding?.baseUrl ?? null,
    },
    ocr: {
      enabled: ocr.enabled,
      provider: ocr.provider,
      model: ocr.model,
      baseUrl: ocrBaseUrl(ocr),
      endpoint: ocrEndpoint(ocr),
      dpi: ocr.dpi,
      maxPages: ocr.maxPages,
      concurrency: ocr.concurrency,
      numCtx: ocr.numCtx,
    },
  });
});

paasLocalModelRoute.post('/start', async (c) => {
  const result = await startLocalModelService();
  if (result.error) {
    return c.json({ success: false, error: result.error, ...statusBody(result.status) }, 400);
  }
  return c.json({ success: true, started: result.started, ...statusBody(result.status) });
});

paasLocalModelRoute.post('/pull', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) return c.json({ error: 'model is required' }, 400);

  // 拉取可能持续十几分钟（视觉模型约 6GB），所以按 NDJSON 流式回进度，
  // 而不是等拉完再返回一个 JSON —— 那样客户端只能挂一个转圈，看不出是在下载
  // 还是已经卡死，也容易被反向代理的空闲超时切断。
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      try {
        await pullLocalModel(model, (p) => send({ ...p, model }));
        send({ status: 'success', percent: 100, model, done: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ model, err: message }, 'Local model pull failed');
        send({ error: message, done: true, model });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
});

/**
 * 一键启用本机向量模型。
 *
 * 顺序刻意是「探测 → 验模型在 → 问出真实维度 → 才写配置」：任何一步失败都不留下
 * 半截配置。维度是**问出来的**而不是按模型名硬编码 —— 维度一旦写错，vec0 表建出来
 * 就是错的，要到用户第一次检索时才炸。
 */
paasLocalModelRoute.put('/embedding', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const model =
    typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : RECOMMENDED_EMBEDDING_MODEL;

  const service = await probeLocalModelService();
  if (!service.available) {
    return c.json(
      { error: `本机模型服务不可用（${service.baseUrl}）：${service.error ?? '未启动'}` },
      400,
    );
  }
  if (!isModelInstalled(service.models, model)) {
    return c.json(
      { error: `模型 ${model} 尚未下载，请先在下方的模型列表中下载`, code: 'model_missing' },
      400,
    );
  }

  const baseUrl = `${service.baseUrl}/v1`;
  let dimensions: number;
  try {
    dimensions = await probeEmbeddingDimension(baseUrl, model, LOCAL_API_KEY);
  } catch (err) {
    return c.json(
      { error: `调用本机嵌入接口失败：${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }

  const previous = getEmbeddingConfig();
  saveEmbeddingConfig({ baseUrl, apiKey: LOCAL_API_KEY, model, dimensions });
  // 维度变了就要重建 vec0 表；调用方据此提示用户「重建索引」。
  const dimensionChanged = syncVecDimensionFromConfig();
  logger.info(
    { model, dimensions, baseUrl, dimensionChanged },
    'Embedding switched to local model service',
  );

  return c.json({
    success: true,
    model,
    dimensions,
    baseUrl,
    dimensionChanged,
    previous: previous ? { model: previous.model, dimensions: previous.dimensions } : null,
  });
});

paasLocalModelRoute.get('/ocr-config', (c) => {
  const ocr = getOcrConfig();
  return c.json({ ...ocr, resolvedBaseUrl: ocrBaseUrl(ocr), endpoint: ocrEndpoint(ocr) });
});

paasLocalModelRoute.put('/ocr-config', async (c) => {
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Parameters<typeof saveOcrConfig>[0] = {};
  if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled;
  if (raw.provider === 'ollama' || raw.provider === 'openai') patch.provider = raw.provider;
  if (typeof raw.model === 'string' && raw.model.trim()) patch.model = raw.model.trim();
  if (typeof raw.baseUrl === 'string') patch.baseUrl = raw.baseUrl.trim() || null;
  if (typeof raw.apiKey === 'string') patch.apiKey = raw.apiKey;
  if (raw.dpi !== undefined) patch.dpi = Number(raw.dpi);
  if (raw.maxPages !== undefined) patch.maxPages = Number(raw.maxPages);
  if (raw.concurrency !== undefined) patch.concurrency = Number(raw.concurrency);
  if (raw.numCtx !== undefined) patch.numCtx = Number(raw.numCtx);
  const saved = saveOcrConfig(patch);
  return c.json({ success: true, ...saved, resolvedBaseUrl: ocrBaseUrl(saved), endpoint: ocrEndpoint(saved) });
});

function statusBody(status: Awaited<ReturnType<typeof probeLocalModelService>>): Record<string, unknown> {
  return {
    service: {
      available: status.available,
      baseUrl: status.baseUrl,
      version: status.version ?? null,
      error: status.error ?? null,
    },
    models: status.models.map((m) => ({ name: m.name, sizeBytes: m.sizeBytes })),
  };
}

export default paasLocalModelRoute;
