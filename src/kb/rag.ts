/**
 * Retrieval-augmented answering with citation provenance.
 *
 * Config lives at data/config/rag.json. baseUrl/apiKey are optional and fall
 * back to embedding.json, since most OpenAI-compatible providers serve both
 * embeddings and chat from one endpoint and one key — inventing a second
 * credential store for the same provider would just be a second thing to keep
 * in sync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';
import { getEmbeddingConfig, embedText } from '../embedding.js';
import { getKnowledgeBase } from '../db.js';
import { searchChunks, buildCitations, type SearchHit, type Citation, type SearchMode } from './search.js';

const RAG_CONFIG_PATH = path.join(DATA_DIR, 'config', 'rag.json');
const REQUEST_TIMEOUT_MS = 120_000;
/** Cap on how much retrieved text is put in the prompt. */
const MAX_CONTEXT_CHARS = 12_000;

export interface RagConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ResolvedRagConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

let cached: RagConfig | null | undefined = undefined;
let cachedMtime = 0;

export function getRagConfig(): RagConfig | null {
  try {
    if (!fs.existsSync(RAG_CONFIG_PATH)) {
      cached = null;
      return null;
    }
    const stat = fs.statSync(RAG_CONFIG_PATH);
    if (cached !== undefined && stat.mtimeMs === cachedMtime) return cached;
    const parsed = JSON.parse(fs.readFileSync(RAG_CONFIG_PATH, 'utf8')) as Partial<RagConfig>;
    if (!parsed.model) {
      cached = null;
      return null;
    }
    cached = {
      model: parsed.model,
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
    };
    cachedMtime = stat.mtimeMs;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export function saveRagConfig(config: RagConfig): void {
  fs.mkdirSync(path.dirname(RAG_CONFIG_PATH), { recursive: true });
  const tmp = `${RAG_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, RAG_CONFIG_PATH);
  cached = undefined;
  cachedMtime = 0;
}

/** Resolve the effective chat endpoint, borrowing embedding credentials if needed. */
export function resolveRagConfig(): ResolvedRagConfig | null {
  const rag = getRagConfig();
  if (!rag) return null;
  const emb = getEmbeddingConfig();
  const baseUrl = (rag.baseUrl || emb?.baseUrl || '').replace(/\/+$/, '');
  const apiKey = rag.apiKey || emb?.apiKey || '';
  if (!baseUrl || !apiKey) return null;
  return {
    model: rag.model,
    baseUrl,
    apiKey,
    temperature: rag.temperature ?? 0.3,
    maxTokens: rag.maxTokens ?? 2048,
  };
}

export function isRagConfigured(): boolean {
  return resolveRagConfig() !== null;
}

export const FALLBACK_ANSWER =
  '知识库中没有找到与该问题相关的内容。请尝试换一种问法，或先上传相关文档。';

export const SYSTEM_PROMPT = [
  '你是一个严谨的企业知识库助手。请依据提供的「参考资料」回答问题。',
  '',
  '规则：',
  '1. 只使用参考资料中的信息作答，不要引入参考资料之外的知识。',
  '2. 如果参考资料不足以回答问题，明确说明「资料中没有相关信息」，不要推测。',
  '3. 在引用了某段资料的句子末尾标注对应编号，格式为 [1]、[2]，可多个。',
  '4. 回答使用与提问相同的语言，简洁、准确、分点陈述。',
].join('\n');

export interface RagRequest {
  kbIds: string[];
  question: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  mode?: SearchMode;
  topK?: number;
  useRerank?: boolean;
  minScore?: number;
}

export interface RagResult {
  answer: string;
  citations: Citation[];
  hits: SearchHit[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  fallback: boolean;
}

/** Assemble the numbered context block the model cites by index. */
export function buildContext(hits: SearchHit[]): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const header = h.headingPath
      ? `[${i + 1}] 文件：${h.filename}（${h.headingPath}）`
      : `[${i + 1}] 文件：${h.filename}`;
    const block = `${header}\n${h.content}`;
    if (used + block.length > MAX_CONTEXT_CHARS) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n---\n\n');
}

/** Retrieve the evidence for a question. Shared by the streaming and batch paths. */
export async function retrieveForQuestion(
  req: RagRequest,
): Promise<{ hits: SearchHit[]; citations: Citation[] }> {
  const embedding = await embedText(req.question);
  const { hits } = await searchChunks({
    kbIds: req.kbIds,
    query: req.question,
    limit: req.topK ?? 5,
    mode: req.mode ?? 'hybrid',
    queryEmbedding: embedding,
    useRerank: req.useRerank,
    minScore: req.minScore,
  });
  return { hits, citations: buildCitations(hits) };
}

function buildMessages(
  req: RagRequest,
  context: string,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  for (const turn of req.history ?? []) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({
    role: 'user',
    content: `参考资料：\n\n${context}\n\n---\n\n问题：${req.question}`,
  });
  return messages;
}

/** Non-streaming answer. Returns the fallback text when nothing was retrieved. */
export async function answerQuestion(req: RagRequest): Promise<RagResult> {
  const { hits, citations } = await retrieveForQuestion(req);
  if (hits.length === 0) {
    return { answer: FALLBACK_ANSWER, citations: [], hits: [], fallback: true };
  }
  const config = resolveRagConfig();
  if (!config) {
    return {
      answer: FALLBACK_ANSWER,
      citations,
      hits,
      fallback: true,
    };
  }

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildMessages(req, buildContext(hits)),
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.warn({ status: res.status, detail: detail.slice(0, 200) }, 'RAG chat call failed');
      return { answer: FALLBACK_ANSWER, citations, hits, fallback: true };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: RagResult['usage'];
    };
    const answer = json.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      return { answer: FALLBACK_ANSWER, citations, hits, fallback: true };
    }
    return { answer, citations, hits, usage: json.usage, fallback: false };
  } catch (err) {
    logger.warn({ err }, 'RAG chat call threw');
    return { answer: FALLBACK_ANSWER, citations, hits, fallback: true };
  }
}

export type RagStreamEvent =
  | { type: 'citations'; citations: Citation[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: string; fallback: boolean }
  | { type: 'error'; message: string };

/**
 * Streaming answer. Yields citations first so the UI can render sources while
 * the model is still generating.
 */
export async function* answerQuestionStream(
  req: RagRequest,
): AsyncGenerator<RagStreamEvent> {
  let hits: SearchHit[] = [];
  let citations: Citation[] = [];
  try {
    const retrieved = await retrieveForQuestion(req);
    hits = retrieved.hits;
    citations = retrieved.citations;
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    return;
  }

  yield { type: 'citations', citations };

  if (hits.length === 0) {
    yield { type: 'delta', text: FALLBACK_ANSWER };
    yield { type: 'done', answer: FALLBACK_ANSWER, fallback: true };
    return;
  }

  const config = resolveRagConfig();
  if (!config) {
    yield { type: 'delta', text: FALLBACK_ANSWER };
    yield { type: 'done', answer: FALLBACK_ANSWER, fallback: true };
    return;
  }

  let full = '';
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildMessages(req, buildContext(hits)),
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      logger.warn({ status: res.status, detail: detail.slice(0, 200) }, 'RAG stream call failed');
      yield { type: 'delta', text: FALLBACK_ANSWER };
      yield { type: 'done', answer: FALLBACK_ANSWER, fallback: true };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are newline-delimited; keep the trailing partial in buffer.
      const frames = buffer.split('\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            yield { type: 'delta', text: delta };
          }
        } catch {
          // Ignore malformed keep-alive frames.
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'RAG stream threw');
    if (!full) {
      yield { type: 'delta', text: FALLBACK_ANSWER };
      yield { type: 'done', answer: FALLBACK_ANSWER, fallback: true };
      return;
    }
  }

  if (!full.trim()) {
    yield { type: 'delta', text: FALLBACK_ANSWER };
    yield { type: 'done', answer: FALLBACK_ANSWER, fallback: true };
    return;
  }
  yield { type: 'done', answer: full, fallback: false };
}

/** Confirm a KB belongs to the user before letting it into a prompt. */
export function assertKbOwnership(kbIds: string[], userId: string): string[] {
  return kbIds.filter((id) => getKnowledgeBase(id, userId) !== null);
}
