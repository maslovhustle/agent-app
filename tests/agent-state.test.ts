import { describe, expect, it } from 'vitest';

import { mergeContexts } from '@/lib/ai/agent/state';
import type { RetrievedContext } from '@/lib/types';

/**
 * `mergeContexts` is the `contexts` channel reducer — the highest-risk piece
 * of pure logic in the graph. It decides what the synthesizer actually reads,
 * and a bug here shows up as "the model ignored source 3" rather than as an
 * exception.
 */

function context(parentId: string, rerankScore: number, citationIndex = 1): RetrievedContext {
  return {
    parentId,
    documentId: 'doc-1',
    filename: 'gdpr.pdf',
    ordinal: 0,
    content: `content for ${parentId}`,
    rerankScore,
    rrfScore: 0.02,
    citationIndex,
  };
}

describe('mergeContexts', () => {
  it('accumulates contexts across retrieval steps', () => {
    const merged = mergeContexts([context('p1', 0.9)], [context('p2', 0.8)]);
    expect(merged.map((entry) => entry.parentId).sort()).toEqual(['p1', 'p2']);
  });

  it('de-duplicates the same parent found by two plan steps, keeping the better score', () => {
    const merged = mergeContexts([context('p1', 0.6)], [context('p1', 0.9)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.rerankScore).toBe(0.9);
  });

  it('does not downgrade a parent when a later step scores it lower', () => {
    const merged = mergeContexts([context('p1', 0.9)], [context('p1', 0.2)]);
    expect(merged[0]?.rerankScore).toBe(0.9);
  });

  it('renumbers citations contiguously from 1 after merging', () => {
    const merged = mergeContexts(
      [context('p1', 0.9, 1), context('p2', 0.7, 2)],
      [context('p3', 0.8, 1)],
    );

    expect(merged.map((entry) => entry.citationIndex)).toEqual([1, 2, 3]);
  });

  it('orders contexts by descending rerank score', () => {
    const merged = mergeContexts([context('p1', 0.3)], [context('p2', 0.95), context('p3', 0.6)]);
    expect(merged.map((entry) => entry.parentId)).toEqual(['p2', 'p3', 'p1']);
  });

  it('returns an empty set when nothing was retrieved', () => {
    expect(mergeContexts([], [])).toEqual([]);
  });

  it('is idempotent when the same update arrives twice', () => {
    const first = mergeContexts([], [context('p1', 0.9), context('p2', 0.5)]);
    const second = mergeContexts(first, [context('p1', 0.9), context('p2', 0.5)]);
    expect(second).toEqual(first);
  });
});
