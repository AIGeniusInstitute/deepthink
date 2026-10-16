/**
 * 本机内置模型服务（Ollama）适配层。
 *
 * 设计目标：让 DeepThink 开箱即用地跑通「向量检索」和「扫描件 OCR」，管理员不需要
 * 去 OpenAI / 智谱申请 API Key。做法不是把推理引擎编译进 Node 进程（onnxruntime
 * 那条路要么绑定特定模型、要么把 1GB 权重打进安装包），而是**复用本机的 Ollama**
 * ——它本身就是开源的模型服务，提供 OpenAI 兼容协议，且模型可以按需拉取。
 *
 * 因此本模块只做四件事：探测服务、列出模型、拉取模型、按需拉起服务进程。
 * 上层（embedding 配置、OCR）都通过这里拿 baseUrl 和模型清单，不各自探测。
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { logger } from './logger.js';

/** Ollama 默认监听地址。可用 `DEEPTHINK_LOCAL_MODEL_URL` 覆盖（改端口/远程主机）。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/** 常见安装位置。brew(arm64) / brew(intel) / 官方安装脚本。 */
const OLLAMA_BIN_CANDIDATES = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/usr/bin/ollama',
];

/**
 * 推荐的向量模型：bge-m3。
 *
 * 选它的理由是可验证的三条：1024 维（比 1536 省 1/3 索引体积）、原生多语言
 * （中文检索不需要额外的中文模型）、8192 上下文，正好覆盖 `MAX_EMBED_TEXT_CHARS`
 * 的 8000 字符截断线 —— 换句话说，DeepThink 切到它不会因为上下文变短而丢内容。
 */
export const RECOMMENDED_EMBEDDING_MODEL = 'bge-m3';
export const RECOMMENDED_EMBEDDING_DIM = 1024;

/**
 * 推荐的视觉模型：qwen2.5vl:7b。
 *
 * OCR 用 VLM 而不是 tesseract/PaddleOCR，是因为真正要处理的扫描件是**表格**：
 * 传统 OCR 引擎输出的是按行拼接的散字，表格的行列关系丢失，检索时相邻单元格的
 * 语义被彻底打乱。VLM 可以直接按 markdown 表格输出，行列结构保留在文本里。
 *
 * 为什么不是更新的 qwen3-vl:8b —— **它是思维链模型，实测吞吐不可用**。
 * 同一份 3 页夹具，本机 M 系列实测（原生 /api/chat，num_ctx=16384）：
 *
 *   qwen3-vl:8b    单页 51s / >300s 超时 / 52s   3 页丢 1 页   表格缺 | --- | 分隔行
 *   qwen2.5vl:7b   单页 20s / 15s / 14s          3 页全中     关键词 4/4
 *
 * 思维链会先花掉几十秒到几分钟的 reasoning token，再产出正文；页面一复杂就撞穿
 * 单页超时。按 16s/页、并发 2 估算，287 页的扫描件约 38 分钟；
 * 换成 qwen3-vl 是 6–12 小时。**这里是拿推理质量换可交付性，方向是"能跑完"。**
 *
 * 质量不比 qwen3-vl 差：夹具里 qwen3-vl 因第 2 页超时而漏掉的关键词
 * （Osimertinib / BRAVO-2251），qwen2.5vl 全部认出。想换回思维链模型，
 * 改 data/config/ocr.json 的 model 即可，链路本身两种都支持。
 */
export const RECOMMENDED_VISION_MODEL = 'qwen2.5vl:7b';

export interface LocalModelInfo {
  name: string;
  sizeBytes: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  modifiedAt?: string;
}

export interface LocalModelServiceStatus {
  available: boolean;
  baseUrl: string;
  version?: string;
  models: LocalModelInfo[];
  error?: string;
}

export function localModelBaseUrl(): string {
  const raw = process.env.DEEPTHINK_LOCAL_MODEL_URL?.trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Ollama 的模型名可能带 `:latest` 后缀 —— `ollama pull bge-m3` 之后 `/api/tags`
 * 里叫 `bge-m3:latest`。不归一化的话「已安装」判断会永远为假，界面上刚拉完的模型
 * 仍然显示"未安装"，然后重复触发一次 1.2GB 的下载。
 */
export function normalizeModelName(name: string): string {
  const trimmed = name.trim();
  const [base, tag] = trimmed.split(':');
  if (!tag || tag === 'latest') return base;
  return trimmed;
}

export function isModelInstalled(models: LocalModelInfo[], wanted: string): boolean {
  const target = normalizeModelName(wanted);
  return models.some((m) => normalizeModelName(m.name) === target);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface OllamaTagEntry {
  name?: string;
  size?: number;
  modified_at?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

/**
 * 探测本机模型服务。**不抛异常** —— 服务没装/没起是这个功能的正常状态之一，
 * 调用方需要拿到结构化的"为什么不可用"而不是一个异常。
 */
export async function probeLocalModelService(timeoutMs = 3000): Promise<LocalModelServiceStatus> {
  const baseUrl = localModelBaseUrl();
  try {
    const versionRes = await fetchWithTimeout(`${baseUrl}/api/version`, {}, timeoutMs);
    if (!versionRes.ok) {
      return { available: false, baseUrl, models: [], error: `HTTP ${versionRes.status}` };
    }
    const versionJson = (await versionRes.json()) as { version?: string };
    const models = await listLocalModels(baseUrl, timeoutMs);
    return { available: true, baseUrl, version: versionJson.version, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, baseUrl, models: [], error: message };
  }
}

async function listLocalModels(baseUrl: string, timeoutMs: number): Promise<LocalModelInfo[]> {
  const res = await fetchWithTimeout(`${baseUrl}/api/tags`, {}, timeoutMs);
  if (!res.ok) throw new Error(`Failed to list models: HTTP ${res.status}`);
  const json = (await res.json()) as { models?: OllamaTagEntry[] };
  return (json.models ?? []).map((m) => ({
    name: m.name ?? '',
    sizeBytes: m.size ?? 0,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
    family: m.details?.family,
    modifiedAt: m.modified_at,
  }));
}

/**
 * 问一次 embedding 接口，拿到**真实的**向量维度。
 *
 * 不靠模型名硬编码维度：bge-m3 是 1024，但同一个模型在不同服务端可能被截断输出，
 * 而维度一旦写错，`vec0` 表建出来就是错的，且要到用户第一次检索失败才会暴露。
 * 写配置之前先问一次，代价是一次 20ms 的请求。
 */
export async function probeEmbeddingDimension(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<number> {
  const res = await fetchWithTimeout(
    `${baseUrl.replace(/\/+$/, '')}/embeddings`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: 'ping' }),
    },
    timeoutMs,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Embedding 接口返回 HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const dim = json.data?.[0]?.embedding?.length ?? 0;
  if (!dim) throw new Error('Embedding 接口返回空向量，请确认模型名是否正确');
  return dim;
}

export function findOllamaBinary(): string | null {
  for (const candidate of OLLAMA_BIN_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * 拉起本机模型服务进程，然后轮询直到就绪。
 *
 * `detached` + `unref`：服务进程的生命周期不跟随 DeepThink 主进程 —— 否则
 * 每次重启后端都要重拉一次模型到显存。这也是"内置部署"和"子进程"的区别。
 */
export async function startLocalModelService(
  waitMs = 20_000,
): Promise<{ started: boolean; status: LocalModelServiceStatus; error?: string }> {
  const before = await probeLocalModelService();
  if (before.available) return { started: false, status: before };

  const bin = findOllamaBinary();
  if (!bin) {
    return {
      started: false,
      status: before,
      error: '本机未安装 Ollama。请先安装（macOS: `brew install ollama`，或访问 https://ollama.com/download）。',
    };
  }

  try {
    const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    return {
      started: false,
      status: before,
      error: `启动 Ollama 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const status = await probeLocalModelService(1000);
    if (status.available) return { started: true, status };
  }
  const final = await probeLocalModelService();
  return { started: false, status: final, error: `Ollama 已启动但 ${waitMs}ms 内未就绪` };
}

export type PullProgress = {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
};

/**
 * 拉取模型。流式读取 NDJSON 进度 —— 一次 pull 少则 270MB 多则 6GB，
 * 不给进度的话界面上只能挂一个转圈，管理员无法判断是在下载还是卡死了。
 */
export async function pullLocalModel(
  model: string,
  onProgress?: (p: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const baseUrl = localModelBaseUrl();
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`拉取 ${model} 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.body) throw new Error(`拉取 ${model} 失败：响应无 body`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastError: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: {
        status?: string;
        error?: string;
        total?: number;
        completed?: number;
      };
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // Ollama 用 HTTP 200 + body 里的 error 字段报错，不看这个字段会把
      // "拉取失败"当成"拉取完成"。
      if (event.error) {
        lastError = event.error;
        continue;
      }
      const percent =
        typeof event.total === 'number' && event.total > 0 && typeof event.completed === 'number'
          ? Math.floor((event.completed / event.total) * 100)
          : undefined;
      onProgress?.({
        status: event.status ?? '',
        completed: event.completed,
        total: event.total,
        percent,
      });
    }
  }
  if (lastError) throw new Error(`拉取 ${model} 失败：${lastError}`);
  logger.info({ model }, 'Local model pulled');
}

/**
 * 确保某个模型可用：已装则直接返回，未装则拉取。
 * `onProgress` 会先收到一条 `checking` 再进入下载进度。
 */
export async function ensureLocalModel(
  model: string,
  onProgress?: (p: PullProgress) => void,
): Promise<{ pulled: boolean; service: LocalModelServiceStatus }> {
  const service = await probeLocalModelService();
  if (!service.available) {
    throw new Error(`本机模型服务不可用（${service.baseUrl}）：${service.error ?? '未启动'}`);
  }
  if (isModelInstalled(service.models, model)) {
    return { pulled: false, service };
  }
  onProgress?.({ status: 'pulling manifest', percent: 0 });
  await pullLocalModel(model, onProgress);
  return { pulled: true, service: await probeLocalModelService() };
}
