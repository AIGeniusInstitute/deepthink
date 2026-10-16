/**
 * Chunk-level retrieval: keyword, vector, and hybrid (RRF-fused).
 *
 * The vector arm needs a query embedding, which is produced by embedding.ts —
 * passed in rather than fetched here so this module stays synchronous and the
 * caller controls fallback when embedding is unconfigured.
 */

import {
  keywordSearchChunks,
  vectorSearchChunks,
  type ChunkSearchRow,
} from '../db.js';
import { fuseRRF, candidatePoolSize, DEFAULT_FUSION, type FusionOptions } from './fusion.js';
import {
  rerankScores,
  isRerankConfigured,
  MAX_RERANK_CANDIDATES,
} from './rerank.js';

export type SearchMode = 'keyword' | 'vector' | 'hybrid';

export interface ChunkSearchOptions {
  kbIds: string[];
  query: string;
  limit?: number;
  mode?: SearchMode;
  /** Query vector; when null the hybrid mode degrades to keyword-only. */
  queryEmbedding?: Float32Array | null;
  fusion?: Partial<FusionOptions>;
  /** Drop hits below this fused score. 0 disables. */
  minScore?: number;
  /** Apply the configured reranker to the fused head, when one is set up. */
  useRerank?: boolean;
  /** Collect per-stage diagnostics for the retrieval lab. */
  debug?: boolean;
}

export interface SearchHit {
  chunkId: string;
  docId: string;
  kbId: string;
  filename: string;
  content: string;
  headingPath: string | null;
  startAt: number;
  endAt: number;
  score: number;
  vectorScore: number | null;
  keywordScore: number | null;
  source: 'vector' | 'keyword' | 'hybrid';
}

export interface SearchDebug {
  mode: SearchMode;
  effective_mode: SearchMode;
  pool_size: number;
  vector_candidates: number;
  keyword_candidates: number;
  fused_candidates: number;
  reranked: boolean;
  timings_ms: { vector: number; keyword: number; fusion: number; rerank: number; total: number };
  fusion: FusionOptions;
}

export interface ChunkSearchResult {
  hits: SearchHit[];
  debug: SearchDebug | null;
}

function toHit(row: ChunkSearchRow, extra: Partial<SearchHit>): SearchHit {
  return {
    chunkId: row.chunk_id,
    docId: row.doc_id,
    kbId: row.kb_id,
    filename: row.filename,
    content: row.content,
    headingPath: row.heading_path,
    startAt: row.start_at,
    endAt: row.end_at,
    score: row.score,
    vectorScore: null,
    keywordScore: null,
    source: 'hybrid',
    ...extra,
  };
}

/**
 * Run a retrieval. Never throws: an unconfigured embedding model or a failed
 * ANN lookup degrades to the keyword arm rather than erroring the request.
 */
export async function searchChunks(
  options: ChunkSearchOptions,
): Promise<ChunkSearchResult> {
  const started = Date.now();
  const limit = Math.max(1, Math.min(options.limit ?? 5, 200));
  const requestedMode: SearchMode = options.mode ?? 'hybrid';
  const fusion: FusionOptions = { ...DEFAULT_FUSION, ...options.fusion };
  const kbIds = options.kbIds.filter(Boolean);

  if (kbIds.length === 0 || !options.query.trim()) {
    return {
      hits: [],
      debug: options.debug
        ? {
            mode: requestedMode,
            effective_mode: requestedMode,
            pool_size: 0,
            vector_candidates: 0,
            keyword_candidates: 0,
            fused_candidates: 0,
            reranked: false,
            timings_ms: { vector: 0, keyword: 0, fusion: 0, rerank: 0, total: 0 },
            fusion,
          }
        : null,
    };
  }

  const pool = candidatePoolSize(limit);
  const wantVector = requestedMode !== 'keyword' && !!options.queryEmbedding;
  // Asked for vector-only but embedding is unavailable → fall back rather than
  // returning nothing.
  const effectiveMode: SearchMode =
    requestedMode === 'keyword' ? 'keyword' : wantVector ? requestedMode : 'keyword';

  let vectorRows: ChunkSearchRow[] = [];
  let vectorMs = 0;
  if (wantVector) {
    const t0 = Date.now();
    vectorRows = vectorSearchChunks(kbIds, options.queryEmbedding!, pool);
    vectorMs = Date.now() - t0;
  }

  let keywordRows: ChunkSearchRow[] = [];
  let keywordMs = 0;
  if (requestedMode !== 'vector') {
    const t0 = Date.now();
    keywordRows = keywordSearchChunks(kbIds, options.query, pool);
    keywordMs = Date.now() - t0;
  }

  const tFuse = Date.now();
  let hits: SearchHit[];

  if (effectiveMode === 'vector') {
    hits = vectorRows.map((r) =>
      toHit(r, { score: r.score, vectorScore: r.score, source: 'vector' }),
    );
  } else if (effectiveMode === 'keyword') {
    hits = keywordRows.map((r) =>
      toHit(r, { score: r.score, keywordScore: r.score, source: 'keyword' }),
    );
  } else {
    const fused = fuseRRF(
      vectorRows.map((r) => ({ item: r, score: r.score })),
      keywordRows.map((r) => ({ item: r, score: r.score })),
      (r) => r.chunk_id,
      fusion,
    );
    hits = fused.map((f) =>
      toHit(f.item, {
        score: f.score,
        vectorScore: f.vectorScore,
        keywordScore: f.keywordScore,
        source: f.source,
      }),
    );
  }

  // Only threshold in hybrid/vector mode: bm25 has no meaningful absolute scale.
  const minScore = options.minScore ?? 0;
  if (minScore > 0 && effectiveMode !== 'keyword') {
    hits = hits.filter((h) => h.score >= minScore);
  }
  hits = hits.slice(0, limit);
  const fusionMs = Date.now() - tFuse;

  let reranked = false;
  let rerankMs = 0;
  if (options.useRerank && isRerankConfigured() && hits.length > 1) {
    const t0 = Date.now();
    const head = hits.slice(0, MAX_RERANK_CANDIDATES);
    const scores = await rerankScores(
      options.query,
      head.map((h) => h.content),
    );
    if (scores) {
      const rescored = head.map((h, i) => ({ ...h, score: scores[i] }));
      rescored.sort((a, b) => b.score - a.score);
      hits = [...rescored, ...hits.slice(MAX_RERANK_CANDIDATES)];
      reranked = true;
    }
    rerankMs = Date.now() - t0;
  }

  const debug: SearchDebug | null = options.debug
    ? {
        mode: requestedMode,
        effective_mode: effectiveMode,
        pool_size: pool,
        vector_candidates: vectorRows.length,
        keyword_candidates: keywordRows.length,
        fused_candidates: hits.length,
        reranked,
        timings_ms: {
          vector: vectorMs,
          keyword: keywordMs,
          fusion: fusionMs,
          rerank: rerankMs,
          total: Date.now() - started,
        },
        fusion,
      }
    : null;

  return { hits, debug };
}

/**
 * Turn search hits into prompt context plus the citation list handed back to
 * the UI. Kept here so the retrieval and QA paths describe citations the same
 * way.
 */
export interface Citation {
  chunk_id: string;
  doc_id: string;
  kb_id: string;
  filename: string;
  heading_path: string | null;
  start_at: number;
  end_at: number;
  content: string;
  score: number;
}

export function buildCitations(hits: SearchHit[], maxChars = 600): Citation[] {
  return hits.map((h) => ({
    chunk_id: h.chunkId,
    doc_id: h.docId,
    kb_id: h.kbId,
    filename: h.filename,
    heading_path: h.headingPath,
    start_at: h.startAt,
    end_at: h.endAt,
    content: h.content.length > maxChars ? `${h.content.slice(0, maxChars)}…` : h.content,
    score: h.score,
  }));
}
