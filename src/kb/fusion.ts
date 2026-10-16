/**
 * Reciprocal Rank Fusion for hybrid retrieval.
 *
 * Mirrors WeKnora's `fuseWithRRF`
 * (internal/application/service/knowledgebase_search_fusion.go): each arm
 * contributes weight / (k + rank), ranks being 1-based.
 *
 * Rank fusion rather than score fusion is the point: bm25 is unbounded and
 * cosine is bounded to [-1, 1], so normalising them onto a common scale (what
 * the document-level hybrid search in db.ts does) lets a single arm's score
 * spread dominate the result. Ranks are comparable across arms by construction.
 */

export interface RankedHit<T> {
  item: T;
  /** Raw arm score, kept for display and thresholding — not used for fusion. */
  score: number;
}

export interface FusedHit<T> {
  item: T;
  /** Fused RRF score, higher is better. */
  score: number;
  vectorScore: number | null;
  keywordScore: number | null;
  vectorRank: number | null;
  keywordRank: number | null;
  source: 'vector' | 'keyword' | 'hybrid';
}

export interface FusionOptions {
  /** RRF constant. 60 is the value WeKnora defaults to. */
  k: number;
  vectorWeight: number;
  keywordWeight: number;
}

export const DEFAULT_FUSION: FusionOptions = {
  k: 60,
  vectorWeight: 0.7,
  keywordWeight: 0.3,
};

/**
 * Fuse two ranked arms by id. Hits present in both arms are marked `hybrid`;
 * a hit found by only one arm keeps that arm as its source. Ties break by id
 * so results are stable across runs.
 */
export function fuseRRF<T>(
  vectorHits: RankedHit<T>[],
  keywordHits: RankedHit<T>[],
  keyOf: (item: T) => string,
  options: Partial<FusionOptions> = {},
): FusedHit<T>[] {
  const opts: FusionOptions = { ...DEFAULT_FUSION, ...options };
  const k = Number.isFinite(opts.k) && opts.k >= 0 ? opts.k : DEFAULT_FUSION.k;

  interface Acc {
    item: T;
    score: number;
    vectorScore: number | null;
    keywordScore: number | null;
    vectorRank: number | null;
    keywordRank: number | null;
  }
  const acc = new Map<string, Acc>();

  vectorHits.forEach((hit, i) => {
    const key = keyOf(hit.item);
    const rank = i + 1;
    const entry = acc.get(key) ?? {
      item: hit.item,
      score: 0,
      vectorScore: null,
      keywordScore: null,
      vectorRank: null,
      keywordRank: null,
    };
    entry.score += opts.vectorWeight / (k + rank);
    entry.vectorScore = hit.score;
    entry.vectorRank = rank;
    acc.set(key, entry);
  });

  keywordHits.forEach((hit, i) => {
    const key = keyOf(hit.item);
    const rank = i + 1;
    const entry = acc.get(key) ?? {
      item: hit.item,
      score: 0,
      vectorScore: null,
      keywordScore: null,
      vectorRank: null,
      keywordRank: null,
    };
    entry.score += opts.keywordWeight / (k + rank);
    entry.keywordScore = hit.score;
    entry.keywordRank = rank;
    acc.set(key, entry);
  });

  const fused: FusedHit<T>[] = [];
  for (const [key, entry] of acc) {
    const source: FusedHit<T>['source'] =
      entry.vectorRank !== null && entry.keywordRank !== null
        ? 'hybrid'
        : entry.vectorRank !== null
          ? 'vector'
          : 'keyword';
    fused.push({
      item: entry.item,
      score: entry.score,
      vectorScore: entry.vectorScore,
      keywordScore: entry.keywordScore,
      vectorRank: entry.vectorRank,
      keywordRank: entry.keywordRank,
      source,
    });
    void key;
  }

  fused.sort((a, b) => b.score - a.score || keyOf(a.item).localeCompare(keyOf(b.item)));
  return fused;
}

/**
 * How many candidates each arm should fetch before fusion. Over-retrieving
 * matters because an item ranked just outside one arm's top-N can still win
 * the fusion on the strength of the other arm.
 */
export function candidatePoolSize(limit: number, max = 500): number {
  return Math.min(Math.max(limit * 5, 50), max);
}
