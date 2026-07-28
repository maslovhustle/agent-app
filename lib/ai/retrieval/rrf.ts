import type { FusedHit, RetrievalHit, RetrievalStrategy } from '@/lib/types';

/**
 * Reciprocal Rank Fusion.
 *
 * Dense cosine similarity and BM25's `ts_rank_cd` live on incompatible scales:
 * one is bounded in [0, 1] and clusters tightly around 0.7–0.9, the other is
 * unbounded and depends on corpus statistics. Normalising them into a shared
 * scale requires assumptions that break as the corpus grows.
 *
 * RRF sidesteps the problem by throwing away the scores entirely and fusing
 * *ranks*:
 *
 *     score(d) = Σ over strategies  weight_s / (k + rank_s(d))
 *
 * `k` (default 60, from Cormack et al. 2009) damps the influence of the very
 * top ranks, so a document that both strategies rank moderately well beats one
 * that a single strategy ranks first. That is exactly the behaviour we want:
 * agreement across retrieval modalities is a stronger relevance signal than
 * confidence within one.
 */

export interface RrfInput {
  strategy: RetrievalStrategy;
  hits: readonly RetrievalHit[];
  weight: number;
}

export interface RrfOptions {
  /** Rank-damping constant. Higher → flatter contribution across ranks. */
  k: number;
  /** Cap on the fused result set handed to the reranker. */
  limit: number;
}

export function reciprocalRankFusion(
  inputs: readonly RrfInput[],
  options: RrfOptions,
): FusedHit[] {
  const { k, limit } = options;
  const accumulator = new Map<string, FusedHit>();

  for (const { strategy, hits, weight } of inputs) {
    hits.forEach((hit, index) => {
      const rank = index + 1; // RRF is 1-indexed
      const contribution = weight / (k + rank);

      const existing = accumulator.get(hit.childId);

      if (existing) {
        existing.rrfScore += contribution;
        existing.ranks[strategy] = rank;
        return;
      }

      accumulator.set(hit.childId, {
        childId: hit.childId,
        parentId: hit.parentId,
        documentId: hit.documentId,
        content: hit.content,
        rrfScore: contribution,
        ranks: { [strategy]: rank },
      });
    });
  }

  return [...accumulator.values()]
    .sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
      // Deterministic tie-break so evals are reproducible run to run.
      return a.childId.localeCompare(b.childId);
    })
    .slice(0, limit);
}

/**
 * Collapses child-level hits to one row per parent, keeping the best-scoring
 * child as the representative.
 *
 * Without this, a single well-matched parent can occupy every slot in the
 * reranker's input window with near-duplicate children, starving the answer of
 * diverse evidence. This is the cheapest diversity control in the pipeline.
 */
export function dedupeByParent(hits: readonly FusedHit[]): FusedHit[] {
  const bestByParent = new Map<string, FusedHit>();

  for (const hit of hits) {
    const existing = bestByParent.get(hit.parentId);
    if (!existing || hit.rrfScore > existing.rrfScore) {
      bestByParent.set(hit.parentId, hit);
    }
  }

  return [...bestByParent.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}
