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
  vectorSearchChunkVariants,
  partitionKbIdsByType,
  getFaqEntriesByIds,
  type ChunkSearchRow,
} from '../db.js';
import { matchesNegativeQuestions, parseFaqMetadata } from './faq.js';
import { fuseRRF, candidatePoolSize, DEFAULT_FUSION, type FusionOptions } from './fusion.js';
import {
  rerankScores,
  isRerankConfigured,
  MAX_RERANK_CANDIDATES,
} from './rerank.js';
import { expandQueries, EXPANSION_CONCURRENCY_CAP } from './query-expansion.js';

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
  /**
   * When the first pass returns fewer hits than asked for, retry with locally
   * rewritten query variants, keyword arm only. Off by default — WeKnora gates
   * this behind `conversation.enable_query_expansion`, unset by default.
   */
  enableQueryExpansion?: boolean;
  /**
   * The user's own wording when `query` is a rewritten form of it. Seeded into the
   * expansion dedup set so a variant cannot echo it back.
   */
  originalQuery?: string;
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
  /** Local query variants tried after a short first pass. Empty when not triggered. */
  expansion_variants: string[];
  /** Hits the expansion pass added on top of the first pass. */
  expansion_added: number;
  /** Concurrency cap WeKnora uses for this stage; reported for parity (see query-expansion.ts). */
  expansion_concurrency_cap: number;
  /** FAQ hits vetoed by an exactly-matching negative question. */
  faq_negative_filtered: number;
  /** How the KB ids split into FAQ (vector-only) and document buckets. */
  kb_buckets: { faq: number; doc: number };
  timings_ms: { vector: number; keyword: number; fusion: number; rerank: number; total: number };
  fusion: FusionOptions;
}

export interface ChunkSearchResult {
  hits: SearchHit[];
  debug: SearchDebug | null;
}

/**
 * Collapse duplicate chunk ids, keeping the highest score. A FAQ entry can be
 * reached by its body vector and by several variant vectors at once; upstream
 * merges those into one result per chunk with `max` score
 * (`knowledgebase_search_fusion.go:99-112`).
 */
function dedupeByChunk(rows: ChunkSearchRow[]): ChunkSearchRow[] {
  const best = new Map<string, ChunkSearchRow>();
  for (const row of rows) {
    const prior = best.get(row.chunk_id);
    if (!prior || row.score > prior.score) best.set(row.chunk_id, row);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
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
            expansion_variants: [],
            expansion_added: 0,
            expansion_concurrency_cap: EXPANSION_CONCURRENCY_CAP,
            faq_negative_filtered: 0,
            kb_buckets: { faq: 0, doc: 0 },
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

  // ── FAQ / 文档分流 ──────────────────────────────────────────────────────
  //
  // 上游把 KB 分成三桶后才构造检索参数（`buildRetrievalParams`），FAQ 库**只**
  // 进向量桶 —— "FAQ KBs are retrieved exclusively via the FAQ vector index and
  // have no keyword index"。这条分流就是 FAQ 不参与关键词检索的全部机制，检索
  // 器内部没有任何按类型过滤的逻辑，所以必须在入口处分好桶。
  const buckets = partitionKbIdsByType(kbIds);
  const hasFaq = buckets.faq.length > 0;

  let vectorRows: ChunkSearchRow[] = [];
  let vectorMs = 0;
  if (wantVector) {
    const t0 = Date.now();
    vectorRows = [
      ...vectorSearchChunks(buckets.doc, options.queryEmbedding!, pool),
      ...vectorSearchChunks(buckets.faq, options.queryEmbedding!, pool),
      // 两类额外条目：FAQ 的相似问变体、Doc2Query 的预生成问题。它们各有独立
      // 的索引条目（上游靠 SourceID 后缀区分），但都带父 chunk_id，所以命中后
      // 按 chunk 归并、取最高分即可 —— 上游 `deduplicateByScore`
      // （knowledgebase_search_fusion.go:99-112）就是按 ChunkID 去重的。
      ...vectorSearchChunkVariants(buckets.faq, options.queryEmbedding!, pool, 'faq_variant'),
      ...vectorSearchChunkVariants(buckets.doc, options.queryEmbedding!, pool, 'generated_question'),
    ];
    vectorRows = dedupeByChunk(vectorRows);
    vectorMs = Date.now() - t0;
  }

  let keywordRows: ChunkSearchRow[] = [];
  let keywordMs = 0;
  // FAQ 桶刻意不传给关键词臂：它没有关键词索引，也不应该有一条。
  if (requestedMode !== 'vector' && buckets.doc.length > 0) {
    const t0 = Date.now();
    keywordRows = keywordSearchChunks(buckets.doc, options.query, pool);
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

  // ── FAQ 负向问题过滤 ────────────────────────────────────────────────────
  //
  // 放在这里（融合之后、扩展与 rerank 之前），与上游 `applyFAQPostProcessing`
  // 的位置一致。负向问题**不参与索引**，只在这一步做事后否决：精确相等（两侧
  // 小写+trim），不是子串匹配。metadata 解析失败的条目**保留**——上游也是
  // 保留，宁可多一条结果也不要因为脏数据静默吞掉正确命中。
  let faqNegativeFiltered = 0;
  if (hasFaq) {
    const faqHits = hits.filter((h) => buckets.faq.includes(h.kbId));
    if (faqHits.length > 0) {
      const metas = new Map(
        getFaqEntriesByIds(faqHits.map((h) => h.chunkId)).map((row) => [
          row.id,
          parseFaqMetadata(row.metadata),
        ]),
      );
      hits = hits.filter((h) => {
        if (!buckets.faq.includes(h.kbId)) return true;
        const meta = metas.get(h.chunkId);
        if (!meta || !matchesNegativeQuestions(options.query, meta.negative_questions)) {
          return true;
        }
        faqNegativeFiltered++;
        return false;
      });
    }
  }

  // ── Query expansion: rescue a short first pass ──────────────────────────
  //
  // WeKnora's trigger is `EnableQueryExpansion && len(SearchResult) < max(1, EmbeddingTopK)`;
  // since limit is always ≥ 1 here, `max(1, limit)` is just `limit`. `requestedMode === 'vector'`
  // is this codebase's "keyword matching is off", which upstream also short-circuits on.
  let expansionVariants: string[] = [];
  let expansionAdded = 0;
  if (
    options.enableQueryExpansion &&
    requestedMode !== 'vector' &&
    hits.length < limit
  ) {
    expansionVariants = expandQueries(options.query, { originalQuery: options.originalQuery });
    if (expansionVariants.length > 0) {
      const seen = new Set(hits.map((h) => h.chunkId));
      // Expansion variants only add keyword recall, so this pass is keyword-only —
      // no re-embedding and no second vector lookup. The existing hits are ahead of
      // these and limit is applied after, so a variant can only fill the shortfall.
      for (const variant of expansionVariants) {
        // 同样只打文档桶：扩展是关键词臂的救援手段，而 FAQ 没有关键词索引。
        for (const row of keywordSearchChunks(buckets.doc, variant, limit)) {
          if (seen.has(row.chunk_id)) continue;
          seen.add(row.chunk_id);
          hits.push(toHit(row, { score: row.score, keywordScore: row.score, source: 'keyword' }));
          expansionAdded++;
        }
      }
      // bm25 has no absolute scale, so minScore is deliberately not re-applied here —
      // same rule the keyword arm follows above.
      hits = hits.slice(0, limit);
    }
  }

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
        expansion_variants: expansionVariants,
        expansion_added: expansionAdded,
        expansion_concurrency_cap: EXPANSION_CONCURRENCY_CAP,
        faq_negative_filtered: faqNegativeFiltered,
        kb_buckets: { faq: buckets.faq.length, doc: buckets.doc.length },
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
