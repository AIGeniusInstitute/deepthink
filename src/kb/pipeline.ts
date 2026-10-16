/**
 * Document ingestion pipeline: parsed text → chunks → vectors.
 *
 * Runs in-process rather than through an external queue. DeepThink is
 * single-node-first (SQLite by default, Redis optional), so adding a broker
 * dependency to index a document would cost more than it buys; the pipeline
 * is bounded by the embedding batch size and records its own progress so the
 * UI can follow along.
 *
 * Text extraction happens in the upload handler — the parsed result is already
 * stored on the document by the time this runs — so the `parse` stage is
 * recorded for completeness rather than performed here.
 */

import { logger } from '../logger.js';
import {
  getKbDocumentAnyOwner,
  replaceChunksForDocument,
  updateDocumentParseState,
  countChunksForDocument,
  setDocumentParserType,
  resolveKbVecDimension,
} from '../db.js';
import {
  chunkParentChild,
  chunkText,
  recommendStrategy,
  DEFAULT_CHUNK_CONFIG,
  type ChunkConfig,
  type ChunkStrategy,
} from './chunker.js';
import { embedChunksForDocument, getEmbeddingConfig, syncVecDimensionFromConfig } from '../embedding.js';

export type ParseStatus =
  | 'pending'
  | 'parsing'
  /** 扫描件：正文由 OCR 产生，可能持续几十分钟，进度写在 `parse_stage`（形如 `ocr 12/287`）。 */
  | 'ocr'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed';

export interface StageRecord {
  stage: 'parse' | 'chunk' | 'embed';
  status: 'ok' | 'failed' | 'skipped';
  ms: number;
  detail?: string;
}

export interface IngestResult {
  docId: string;
  status: ParseStatus;
  chunkCount: number;
  embeddedCount: number;
  stages: StageRecord[];
  error?: string;
}

export interface IngestOptions {
  /**
   * Chunking overrides. `strategy: 'auto'` lets the document's own shape pick
   * the strategy — it is a request-time instruction, not a stored strategy.
   */
  chunkConfig?: Partial<Omit<ChunkConfig, 'strategy'>> & {
    strategy?: ChunkStrategy | 'auto';
  };
  parserType?: string;
  /**
   * 启用父子分块。开启后产出的行里会有 chunk_type='parent_text' 的父块；
   * 父块只用于检索命中后回溯上下文，**不参与 embedding**。
   * 默认关闭——它对既有库会改变分块粒度，按库显式开启。
   */
  parentChild?: boolean;
}

/** In-flight ingestions, keyed by document. Value flags a requested cancel. */
const inFlight = new Map<string, { cancelled: boolean }>();

export function isIngesting(docId: string): boolean {
  return inFlight.has(docId);
}

/** Ask a running ingestion to stop at the next stage boundary. */
export function cancelIngest(docId: string): boolean {
  const entry = inFlight.get(docId);
  if (!entry) return false;
  entry.cancelled = true;
  return true;
}

function serializeStages(stages: StageRecord[]): string {
  return JSON.stringify(stages);
}

function resolveChunkConfig(partial?: IngestOptions['chunkConfig']): ChunkConfig {
  const strategy = partial?.strategy;
  return {
    // 'auto' is resolved against the document body in runIngestPipeline.
    strategy: strategy && strategy !== 'auto' ? strategy : 'heuristic',
    chunkSize: partial?.chunkSize ?? DEFAULT_CHUNK_CONFIG.chunkSize,
    chunkOverlap: partial?.chunkOverlap ?? DEFAULT_CHUNK_CONFIG.chunkOverlap,
  };
}

/**
 * Chunk and index a document.
 *
 * Never throws: a failure is recorded on the document row (status `failed`
 * plus the failing stage and message) so the UI can show it and offer a
 * reparse, which is more useful than an exception nobody is listening for.
 */
export async function runIngestPipeline(
  docId: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const existing = inFlight.get(docId);
  if (existing) {
    return {
      docId,
      status: 'failed',
      chunkCount: 0,
      embeddedCount: 0,
      stages: [],
      error: 'Ingestion already in progress for this document',
    };
  }
  const handle = { cancelled: false };
  inFlight.set(docId, handle);

  const stages: StageRecord[] = [];
  const startedAt = Date.now();

  const fail = (stage: StageRecord['stage'], message: string): IngestResult => {
    stages.push({ stage, status: 'failed', ms: Date.now() - startedAt, detail: message });
    updateDocumentParseState(docId, {
      parse_status: 'failed',
      parse_stage: stage,
      error_message: message,
      stages_json: serializeStages(stages),
    });
    logger.warn({ docId, stage, message }, 'KB ingestion failed');
    return { docId, status: 'failed', chunkCount: 0, embeddedCount: 0, stages, error: message };
  };

  try {
    const doc = getKbDocumentAnyOwner(docId);
    if (!doc) {
      inFlight.delete(docId);
      return fail('parse', 'Document not found');
    }

    if (options.parserType) setDocumentParserType(docId, options.parserType);

    // ── parse ──────────────────────────────────────────────
    const content = doc.content ?? '';
    if (!content.trim()) {
      inFlight.delete(docId);
      return fail('parse', 'Parsed document is empty');
    }
    stages.push({ stage: 'parse', status: 'ok', ms: Date.now() - startedAt });

    if (handle.cancelled) {
      inFlight.delete(docId);
      return finishCancelled(docId, stages);
    }

    // ── chunk ──────────────────────────────────────────────
    const cfg = resolveChunkConfig(options.chunkConfig);
    updateDocumentParseState(docId, {
      parse_status: 'chunking',
      parse_stage: 'chunk',
      error_message: null,
      chunk_config_json: JSON.stringify(cfg),
      stages_json: serializeStages(stages),
    });

    const tChunk = Date.now();
    // 'auto' resolves against the document's shape; an explicit strategy wins.
    const requested = options.chunkConfig?.strategy;
    const effectiveCfg: ChunkConfig = {
      ...cfg,
      strategy: !requested || requested === 'auto' ? recommendStrategy(content) : cfg.strategy,
    };

    // 父子分块使用自己的尺寸（父 4096 / 子 384），不走单层 chunkSize——
    // 这与 WeKnora 一致：ParentChunkSize / ChildChunkSize 是独立配置。
    const chunks = options.parentChild
      ? chunkParentChild(content, {
          parent: { strategy: effectiveCfg.strategy },
          child: { strategy: effectiveCfg.strategy },
        })
      : chunkText(content, effectiveCfg);
    if (chunks.length === 0) {
      inFlight.delete(docId);
      return fail('chunk', 'Chunking produced no chunks');
    }

    const rows = replaceChunksForDocument(
      docId,
      doc.kb_id,
      doc.user_id,
      chunks.map((c) => ({
        content: c.content,
        headingPath: c.headingPath,
        startAt: c.startAt,
        endAt: c.endAt,
        chunkIndex: c.index,
        chunkType: c.chunkType,
        parentIndex: c.parentIndex,
      })),
    );
    const parentCount = rows.filter((r) => r.chunk_type === 'parent_text').length;
    stages.push({
      stage: 'chunk',
      status: 'ok',
      ms: Date.now() - tChunk,
      detail: options.parentChild
        ? `${rows.length} chunks（其中 ${parentCount} 个父块，不参与 embedding）via ${effectiveCfg.strategy}+parent-child`
        : `${rows.length} chunks via ${effectiveCfg.strategy}`,
    });

    if (handle.cancelled) {
      inFlight.delete(docId);
      return finishCancelled(docId, stages);
    }

    // ── embed ──────────────────────────────────────────────
    updateDocumentParseState(docId, {
      parse_status: 'embedding',
      parse_stage: 'embed',
      chunk_count: rows.length,
      stages_json: serializeStages(stages),
    });

    const tEmbed = Date.now();
    let embeddedCount = 0;
    if (getEmbeddingConfig()) {
      // A dimension change invalidates the ANN tables; reconcile before writing.
      syncVecDimensionFromConfig();
      const stats = await embedChunksForDocument(docId);
      embeddedCount = stats.success;
      stages.push({
        stage: 'embed',
        status: stats.failed > 0 ? 'failed' : 'ok',
        ms: Date.now() - tEmbed,
        detail: `${stats.success}/${stats.attempted} embedded`,
      });
    } else {
      stages.push({
        stage: 'embed',
        status: 'skipped',
        ms: Date.now() - tEmbed,
        detail: 'Embedding is not configured — keyword search only',
      });
    }

    updateDocumentParseState(docId, {
      parse_status: 'ready',
      parse_stage: null,
      chunk_count: rows.length,
      embedded_chunk_count: embeddedCount,
      embedding_dim: getEmbeddingConfig()?.dimensions ?? resolveKbVecDimension(),
      processed_at: new Date().toISOString(),
      stages_json: serializeStages(stages),
    });

    logger.info(
      { docId, chunks: rows.length, embedded: embeddedCount, ms: Date.now() - startedAt },
      'KB ingestion complete',
    );
    return {
      docId,
      status: 'ready',
      chunkCount: rows.length,
      embeddedCount,
      stages,
    };
  } catch (err) {
    inFlight.delete(docId);
    return fail('chunk', err instanceof Error ? err.message : String(err));
  } finally {
    inFlight.delete(docId);
  }
}

function finishCancelled(docId: string, stages: StageRecord[]): IngestResult {
  updateDocumentParseState(docId, {
    parse_status: 'failed',
    parse_stage: 'cancelled',
    error_message: 'Ingestion cancelled',
    stages_json: serializeStages(stages),
  });
  return {
    docId,
    status: 'failed',
    chunkCount: 0,
    embeddedCount: 0,
    stages,
    error: 'Ingestion cancelled',
  };
}

/**
 * Re-run ingestion for a document, optionally with new chunking settings.
 * Chunk replacement is transactional, so a failure leaves the old index
 * intact rather than a half-written one.
 */
export async function reparseDocument(
  docId: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  updateDocumentParseState(docId, {
    parse_status: 'pending',
    parse_stage: null,
    error_message: null,
  });
  return runIngestPipeline(docId, options);
}

/**
 * Fire-and-forget ingestion for a freshly uploaded document. The upload
 * response returns immediately; progress is observable via parse_status.
 */
export function startIngestAsync(docId: string, options: IngestOptions = {}): void {
  void runIngestPipeline(docId, options).catch((err) => {
    logger.error({ err, docId }, 'KB ingestion crashed');
    updateDocumentParseState(docId, {
      parse_status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
    });
  });
}
