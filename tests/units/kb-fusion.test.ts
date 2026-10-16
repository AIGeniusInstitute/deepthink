import { describe, it, expect } from 'vitest';
import { fuseRRF, candidatePoolSize, DEFAULT_FUSION } from '../../src/kb/fusion.js';

const key = (s: string): string => s;

describe('fuseRRF', () => {
  it('scores a hit found by both arms as the sum of both contributions', () => {
    const fused = fuseRRF(
      [{ item: 'a', score: 0.9 }],
      [{ item: 'a', score: 12 }],
      key,
      { k: 60, vectorWeight: 0.7, keywordWeight: 0.3 },
    );
    expect(fused).toHaveLength(1);
    expect(fused[0].score).toBeCloseTo(0.7 / 61 + 0.3 / 61, 10);
    expect(fused[0].source).toBe('hybrid');
    expect(fused[0].vectorRank).toBe(1);
    expect(fused[0].keywordRank).toBe(1);
  });

  it('labels single-arm hits with the arm that found them', () => {
    const fused = fuseRRF([{ item: 'v', score: 1 }], [{ item: 'k', score: 1 }], key);
    const byKey = Object.fromEntries(fused.map((f) => [f.item, f]));
    expect(byKey['v'].source).toBe('vector');
    expect(byKey['k'].source).toBe('keyword');
    expect(byKey['v'].keywordScore).toBeNull();
    expect(byKey['k'].vectorScore).toBeNull();
  });

  it('raises a hit that only one arm liked when the other arm ranks it too', () => {
    // 'x' is second in the vector arm and first in the keyword arm, so it
    // should outrank 'y' which is first in vector but absent from keyword.
    const fused = fuseRRF(
      [
        { item: 'y', score: 0.99 },
        { item: 'x', score: 0.5 },
      ],
      [{ item: 'x', score: 3 }],
      key,
      { k: 60, vectorWeight: 0.7, keywordWeight: 0.3 },
    );
    expect(fused[0].item).toBe('x');
  });

  it('is insensitive to score scale — only ranks matter', () => {
    const smallScale = fuseRRF(
      [{ item: 'a', score: 0.001 }],
      [{ item: 'b', score: 0.001 }],
      key,
    );
    const largeScale = fuseRRF(
      [{ item: 'a', score: 999_999 }],
      [{ item: 'b', score: 999_999 }],
      key,
    );
    expect(smallScale.map((f) => f.item)).toEqual(largeScale.map((f) => f.item));
    expect(smallScale[0].score).toBeCloseTo(largeScale[0].score, 10);
  });

  it('orders by fused score descending and breaks ties deterministically', () => {
    const fused = fuseRRF(
      [
        { item: 'b', score: 1 },
        { item: 'a', score: 1 },
      ],
      [],
      key,
    );
    expect(fused.map((f) => f.item)).toEqual(['b', 'a']); // rank order preserved
    // A genuine tie resolves by key, not by arm iteration order.
    const tied = fuseRRF([{ item: 'b', score: 1 }], [{ item: 'a', score: 1 }], key, {
      k: 0,
      vectorWeight: 1,
      keywordWeight: 1,
    });
    expect(tied[0].score).toBeCloseTo(tied[1].score, 10);
    expect(tied.map((f) => f.item)).toEqual(['a', 'b']);
  });

  it('returns an empty list when both arms are empty', () => {
    expect(fuseRRF([], [], key)).toEqual([]);
  });

  it('honours custom weights and k', () => {
    const fused = fuseRRF([{ item: 'a', score: 1 }], [], key, { k: 0, vectorWeight: 1 });
    expect(fused[0].score).toBeCloseTo(1, 10);
  });

  it('exposes WeKnora-aligned defaults', () => {
    expect(DEFAULT_FUSION).toEqual({ k: 60, vectorWeight: 0.7, keywordWeight: 0.3 });
  });
});

describe('candidatePoolSize', () => {
  it('over-retrieves relative to the requested limit', () => {
    expect(candidatePoolSize(5)).toBe(50);
    expect(candidatePoolSize(20)).toBe(100);
  });

  it('caps the pool so a large limit cannot blow up the query', () => {
    expect(candidatePoolSize(1_000)).toBe(500);
    expect(candidatePoolSize(1_000, 100)).toBe(100);
  });
});
