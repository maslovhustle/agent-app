import { describe, expect, it } from 'vitest';

import { dedupeByParent, reciprocalRankFusion } from '@/lib/ai/retrieval/rrf';
import type { FusedHit, RetrievalHit } from '@/lib/types';

function hit(id: string, parentId: string, score: number): RetrievalHit {
  return { childId: id, parentId, documentId: 'doc-1', content: `content ${id}`, score };
}

const OPTIONS = { k: 60, limit: 20 };

describe('reciprocalRankFusion', () => {
  it('scores a single-strategy result by 1/(k + rank)', () => {
    const [first, second] = reciprocalRankFusion(
      [{ strategy: 'dense', hits: [hit('a', 'p1', 0.9), hit('b', 'p2', 0.8)], weight: 1 }],
      OPTIONS,
    );

    expect(first?.rrfScore).toBeCloseTo(1 / 61, 10);
    expect(second?.rrfScore).toBeCloseTo(1 / 62, 10);
  });

  it('rewards agreement between strategies over a single high rank', () => {
    // "b" is 2nd in both lists; "a" is 1st in dense but absent from sparse.
    const fused = reciprocalRankFusion(
      [
        { strategy: 'dense', hits: [hit('a', 'p1', 0.99), hit('b', 'p2', 0.7)], weight: 1 },
        { strategy: 'sparse', hits: [hit('c', 'p3', 5), hit('b', 'p2', 4)], weight: 1 },
      ],
      OPTIONS,
    );

    expect(fused[0]?.childId).toBe('b');
    expect(fused[0]?.ranks).toEqual({ dense: 2, sparse: 2 });
  });

  it('applies per-strategy weights', () => {
    const denseHeavy = reciprocalRankFusion(
      [
        { strategy: 'dense', hits: [hit('a', 'p1', 0.9)], weight: 1 },
        { strategy: 'sparse', hits: [hit('b', 'p2', 9)], weight: 0.5 },
      ],
      OPTIONS,
    );

    expect(denseHeavy[0]?.childId).toBe('a');
    expect(denseHeavy[1]?.rrfScore).toBeCloseTo(0.5 / 61, 10);
  });

  it('ignores raw scores entirely — only rank position matters', () => {
    const tiny = reciprocalRankFusion(
      [{ strategy: 'dense', hits: [hit('a', 'p1', 0.0001), hit('b', 'p2', 0.00001)], weight: 1 }],
      OPTIONS,
    );
    const huge = reciprocalRankFusion(
      [{ strategy: 'dense', hits: [hit('a', 'p1', 9999), hit('b', 'p2', 1000)], weight: 1 }],
      OPTIONS,
    );

    expect(tiny.map((entry) => entry.rrfScore)).toEqual(huge.map((entry) => entry.rrfScore));
  });

  it('records provenance for every contributing strategy', () => {
    const fused = reciprocalRankFusion(
      [
        { strategy: 'dense', hits: [hit('a', 'p1', 0.9)], weight: 1 },
        { strategy: 'sparse', hits: [hit('a', 'p1', 3)], weight: 1 },
      ],
      OPTIONS,
    );

    expect(fused).toHaveLength(1);
    expect(fused[0]?.ranks).toEqual({ dense: 1, sparse: 1 });
  });

  it('respects the limit', () => {
    const hits = Array.from({ length: 50 }, (_, i) => hit(`c${i}`, `p${i}`, 1 - i / 100));
    const fused = reciprocalRankFusion([{ strategy: 'dense', hits, weight: 1 }], {
      k: 60,
      limit: 10,
    });
    expect(fused).toHaveLength(10);
  });

  it('is deterministic when scores tie', () => {
    const inputs = [
      { strategy: 'dense' as const, hits: [hit('b', 'p1', 1)], weight: 1 },
      { strategy: 'sparse' as const, hits: [hit('a', 'p2', 1)], weight: 1 },
    ];
    const first = reciprocalRankFusion(inputs, OPTIONS).map((entry) => entry.childId);
    const second = reciprocalRankFusion(inputs, OPTIONS).map((entry) => entry.childId);

    expect(first).toEqual(second);
    expect(first).toEqual(['a', 'b']); // tie broken by id, ascending
  });

  it('handles both strategies returning nothing', () => {
    expect(
      reciprocalRankFusion(
        [
          { strategy: 'dense', hits: [], weight: 1 },
          { strategy: 'sparse', hits: [], weight: 1 },
        ],
        OPTIONS,
      ),
    ).toEqual([]);
  });
});

describe('dedupeByParent', () => {
  const fused: FusedHit[] = [
    { childId: 'c1', parentId: 'p1', documentId: 'd', content: 'low', rrfScore: 0.01, ranks: {} },
    { childId: 'c2', parentId: 'p1', documentId: 'd', content: 'high', rrfScore: 0.05, ranks: {} },
    { childId: 'c3', parentId: 'p2', documentId: 'd', content: 'other', rrfScore: 0.03, ranks: {} },
  ];

  it('keeps only the best-scoring child per parent', () => {
    const result = dedupeByParent(fused);
    expect(result).toHaveLength(2);
    expect(result[0]?.childId).toBe('c2');
    expect(result[0]?.content).toBe('high');
  });

  it('sorts by descending fused score', () => {
    const scores = dedupeByParent(fused).map((entry) => entry.rrfScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('is a no-op when every parent is distinct', () => {
    const distinct = fused.map((entry, index) => ({ ...entry, parentId: `p${index}` }));
    expect(dedupeByParent(distinct)).toHaveLength(3);
  });
});
