/**
 * Vector embedding integration: call an OpenAI-compatible embeddings API
 * to convert text into Float32Array vectors, stored in kb_documents.embedding.
 *
 * Configuration: data/config/embedding.json (AES-256-GCM encrypted, 0600)
 *
 * When unconfigured: embedding-related code paths fall back to FTS5-only
 * search (Phase 1 behavior preserved).
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';
import {
  getKbDocumentContent,
  listUnembeddedDocsInKb,
  updateDocEmbedding,
  type KbDocumentRow,
} from './db.js';

const EMBEDDING_CONFIG_PATH = path.join(DATA_DIR, 'config', 'embedding.json');
const MAX_EMBED_TEXT_CHARS = 8000; // OpenAI text-embedding-3-small input limit ~8K tokens

export interface EmbeddingConfig {
  baseUrl: string;       // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;         // e.g. text-embedding-3-small
  dimensions: number;    // e.g. 1536
}

let cachedConfig: EmbeddingConfig | null | undefined = undefined;
let configMtime = 0;

export function getEmbeddingConfig(): EmbeddingConfig | null {
  try {
    if (!fs.existsSync(EMBEDDING_CONFIG_PATH)) {
      cachedConfig = null;
      return null;
    }
    const stat = fs.statSync(EMBEDDING_CONFIG_PATH);
    if (cachedConfig !== undefined && stat.mtimeMs === configMtime) {
      return cachedConfig;
    }
    const raw = fs.readFileSync(EMBEDDING_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<EmbeddingConfig>;
    if (
      !parsed.baseUrl ||
      !parsed.apiKey ||
      !parsed.model ||
      typeof parsed.dimensions !== 'number'
    ) {
      cachedConfig = null;
      return null;
    }
    cachedConfig = {
      baseUrl: parsed.baseUrl.replace(/\/+$/, ''),
      apiKey: parsed.apiKey,
      model: parsed.model,
      dimensions: parsed.dimensions,
    };
    configMtime = stat.mtimeMs;
    return cachedConfig;
  } catch {
    cachedConfig = null;
    return null;
  }
}

export async function embedText(text: string): Promise<Float32Array | null> {
  const config = getEmbeddingConfig();
  if (!config) return null;
  const truncated = text.slice(0, MAX_EMBED_TEXT_CHARS);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input: truncated }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, errText: errText.slice(0, 200) },
        'Embedding API returned non-OK status',
      );
      return null;
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const arr = json.data?.[0]?.embedding;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const f32 = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) f32[i] = arr[i];
    return f32;
  } catch (err) {
    logger.warn({ err }, 'Embedding API call failed');
    return null;
  }
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  // MVP: sequential embedText calls. Batch API can be added if perf demands.
  const results: (Float32Array | null)[] = [];
  for (const t of texts) {
    results.push(await embedText(t));
  }
  return results;
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * Trigger async embedding for a freshly inserted document.
 * No-op when embedding is unconfigured or fetch/parse fails.
 */
export async function triggerEmbeddingAsync(docId: string, content: string): Promise<void> {
  const config = getEmbeddingConfig();
  if (!config) return;
  const emb = await embedText(content);
  if (!emb) return;
  updateDocEmbedding(docId, emb, config.model);
}

/**
 * Re-embed a single document by ID. Returns false if unconfigured or doc missing.
 */
export async function embedDocumentById(docId: string): Promise<boolean> {
  const config = getEmbeddingConfig();
  if (!config) return false;
  const content = getKbDocumentContent(docId);
  if (!content) return false;
  const emb = await embedText(content);
  if (!emb) return false;
  updateDocEmbedding(docId, emb, config.model);
  return true;
}

/**
 * Batch-embed all documents in a KB that lack embeddings.
 * Returns { attempted, success, failed }.
 */
export async function embedAllInKb(kbId: string): Promise<{
  attempted: number;
  success: number;
  failed: number;
}> {
  const config = getEmbeddingConfig();
  if (!config) return { attempted: 0, success: 0, failed: 0 };
  const docs = listUnembeddedDocsInKb(kbId);
  let success = 0;
  let failed = 0;
  for (const d of docs) {
    const emb = await embedText(d.content);
    if (emb) {
      updateDocEmbedding(d.id, emb, config.model);
      success++;
    } else {
      failed++;
    }
  }
  return { attempted: docs.length, success, failed };
}

export type { KbDocumentRow };
