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
  listUnembeddedChunks,
  listUnembeddedChunksForDocument,
  updateChunkEmbedding,
  setKbVecDimension,
  resolveKbVecDimension,
  countEmbeddedChunksForDocument,
  setChunkVariantVectors,
  clearChunkVariantVectors,
  getKnowledgeBaseAnyOwner,
  type KbChunkRow,
  type KbDocumentRow,
} from './db.js';
import { parseFaqConfig, parseFaqMetadata, buildFaqIndexTexts } from './kb/faq.js';

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

export function saveEmbeddingConfig(config: EmbeddingConfig): void {
  const dir = path.dirname(EMBEDDING_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    apiKey: config.apiKey,
    model: config.model,
    dimensions: config.dimensions,
  };
  const tmp = `${EMBEDDING_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, EMBEDDING_CONFIG_PATH);
  cachedConfig = undefined;
  configMtime = 0;
}

export async function testEmbeddingConnection(): Promise<{ success: boolean; dimensions?: number; error?: string }> {
  try {
    const emb = await embedText('hello');
    if (!emb || emb.length === 0) {
      return { success: false, error: 'API returned empty embedding' };
    }
    return { success: true, dimensions: emb.length };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
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

// ─── Chunk-level embedding ────────────────────────────────

/**
 * Embed several texts in one API call.
 *
 * The endpoint accepts an array input, so this is a genuine batch rather than
 * the sequential loop `embedBatch` performs. Results stay index-aligned; a
 * failure yields null in that slot so one bad input cannot sink the batch.
 */
export async function embedTexts(texts: string[]): Promise<(Float32Array | null)[]> {
  const config = getEmbeddingConfig();
  if (!config || texts.length === 0) return texts.map(() => null);

  const payload = texts.map((t) => t.slice(0, MAX_EMBED_TEXT_CHARS));
  try {
    const controller = new AbortController();
    // Scale the timeout with batch size — a large batch legitimately takes longer.
    const timer = setTimeout(() => controller.abort(), 30_000 + texts.length * 500);
    const res = await fetch(`${config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input: payload }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, errText: errText.slice(0, 200) },
        'Batch embedding API returned non-OK status',
      );
      return texts.map(() => null);
    }
    const json = (await res.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
    };
    const out: (Float32Array | null)[] = texts.map(() => null);
    json.data?.forEach((entry, i) => {
      const idx = typeof entry.index === 'number' ? entry.index : i;
      if (idx < 0 || idx >= out.length) return;
      const arr = entry.embedding;
      if (!Array.isArray(arr) || arr.length === 0) return;
      const f32 = new Float32Array(arr.length);
      for (let k = 0; k < arr.length; k++) f32[k] = arr[k];
      out[idx] = f32;
    });
    return out;
  } catch (err) {
    logger.warn({ err }, 'Batch embedding API call failed');
    return texts.map(() => null);
  }
}

/** Chunk texts need a title prefix so a fragment carries its document context. */
function chunkEmbeddingInput(filename: string, headingPath: string | null, content: string): string {
  const header = headingPath ? `${filename} > ${headingPath}` : filename;
  return `${header}\n${content}`;
}

const CHUNK_EMBED_BATCH = 32;

/**
 * The texts a single row contributes to the vector index.
 *
 * Document chunks contribute exactly one: the title-prefixed body. FAQ entries
 * are different in two ways — the embedded text is **not** the stored body
 * (`chunk.content` reads "Q: … / Similar Questions: …" while the index text is
 * the bare questions joined by newlines), and `separate` mode produces one
 * vector *per question* rather than one per row. Upstream draws exactly this
 * distinction between `buildFAQChunkContent` and `buildFAQIndexInfoList`.
 *
 * Variant 0 is the standard question and lands in the row's own `embedding`
 * column, so "not yet embedded" (`embedding IS NULL`) keeps meaning what it
 * meant; variants 1..N go to the variant table.
 */
function chunkIndexTexts(row: ChunkEmbedRow, bodyText: (row: ChunkEmbedRow) => string): string[] {
  if (row.chunk_type !== 'faq') {
    return [bodyText(row)];
  }
  const meta = parseFaqMetadata(row.metadata);
  if (!meta) {
    // A FAQ row whose metadata will not parse still has an embeddable body;
    // indexing it beats leaving a hole in the index.
    return [row.content];
  }
  const config = parseFaqConfig(getKnowledgeBaseAnyOwner(row.kb_id)?.faq_config);
  return buildFaqIndexTexts(meta, config.indexMode, config.questionIndexMode);
}

/**
 * Embed a batch of chunk rows, writing variant 0 to the row and any further
 * variants to the variant table.
 *
 * Variants are written **before** the row's own vector on purpose: the row's
 * `embedding IS NULL` flag is what marks it as pending, so a crash between the
 * two writes leaves the row pending and the next pass redoes both idempotently.
 * The other order would leave variants missing forever.
 */
type ChunkEmbedRow = KbChunkRow & { filename?: string | null };

async function embedChunkRows(
  rows: ChunkEmbedRow[],
  model: string,
  bodyText: (row: ChunkEmbedRow) => string,
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += CHUNK_EMBED_BATCH) {
    const batch = rows.slice(i, i + CHUNK_EMBED_BATCH);
    const textsPerRow = batch.map((row) => chunkIndexTexts(row, bodyText));
    const flat = textsPerRow.flat();
    if (flat.length === 0) continue;
    const vectors = await embedTexts(flat);

    let cursor = 0;
    batch.forEach((chunk, k) => {
      const own = textsPerRow[k];
      const ownVectors = vectors.slice(cursor, cursor + own.length);
      cursor += own.length;
      if (ownVectors.length === 0 || !ownVectors[0]) {
        failed++;
        return;
      }
      const extras = ownVectors
        .slice(1)
        .map((vec, index) => ({ index: index + 1, vec }))
        .filter((v): v is { index: number; vec: Float32Array } => !!v.vec);
      if (extras.length > 0) {
        setChunkVariantVectors(
          chunk.id,
          extras.map((v) => ({ index: v.index, embedding: v.vec, model })),
        );
      } else {
        // Mode may have flipped back to combined; drop stale variants so the
        // ANN and variant arms cannot disagree about an entry.
        clearChunkVariantVectors(chunk.id);
      }
      updateChunkEmbedding(chunk.id, ownVectors[0], model);
      success++;
    });
  }
  return { success, failed };
}

/**
 * Embed every not-yet-embedded chunk of a document.
 * Returns counts; individual failures are reported, not thrown.
 */
export async function embedChunksForDocument(docId: string): Promise<{
  attempted: number;
  success: number;
  failed: number;
}> {
  const config = getEmbeddingConfig();
  if (!config) return { attempted: 0, success: 0, failed: 0 };

  const rows = listUnembeddedChunksForDocument(docId);
  if (rows.length === 0) return { attempted: 0, success: 0, failed: 0 };

  const { success, failed } = await embedChunkRows(
    rows,
    config.model,
    (c) => chunkEmbeddingInput(c.filename ?? '', c.heading_path, c.content),
  );
  return { attempted: rows.length, success, failed };
}

/**
 * Reconcile the vec0/pgvector table dimension with the embedding config.
 * Returns true when the dimension changed, which invalidates every stored
 * vector — callers should then re-embed.
 */
export function syncVecDimensionFromConfig(): boolean {
  const config = getEmbeddingConfig();
  if (!config) return false;
  const current = resolveKbVecDimension();
  if (current === config.dimensions) return false;
  if (setKbVecDimension(config.dimensions)) {
    logger.info(
      { from: current, to: config.dimensions },
      'Embedding dimension changed — KB vector indexes rebuilt, re-embedding required',
    );
    return true;
  }
  return false;
}

/** Embed all pending chunks of a KB (bounded per call). */
export async function embedAllChunksInKb(kbId: string, limit = 200): Promise<{
  attempted: number;
  success: number;
  failed: number;
}> {
  const config = getEmbeddingConfig();
  if (!config) return { attempted: 0, success: 0, failed: 0 };
  const rows = listUnembeddedChunks(kbId, limit);
  if (rows.length === 0) return { attempted: 0, success: 0, failed: 0 };

  const { success, failed } = await embedChunkRows(rows, config.model, (c) => c.content);
  return { attempted: rows.length, success, failed };
}

/** Count of chunks of a document that currently hold a vector. */
export function embeddedChunkCount(docId: string): number {
  return countEmbeddedChunksForDocument(docId);
}
