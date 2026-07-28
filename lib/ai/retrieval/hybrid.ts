import 'server-only';

import { embedQuery } from '@/lib/ai/embeddings';
import { getRagConfig } from '@/lib/env';
import type { RetrievalResult, RetrievedContext } from '@/lib/types';

import { dedupeByParent, reciprocalRankFusion } from './rrf';
import { rerankCandidates } from './rerank';
import { fetchParentContexts, keywordSearch, vectorSearch } from './search';

/**
 * The full retrieval pipeline, in one place:
 *
 *   1. Embed the query.
 *   2. Run dense (pgvector HNSW) and sparse (tsvector BM25) search
 *      CONCURRENTLY — they are independent, so paying for both serially is
 *      pure latency waste.
 *   3. Fuse the two rankings with Reciprocal Rank Fusion.
 *   4. Collapse to one candidate per parent (diversity control).
 *   5. Rerank the survivors with a Cohere cross-encoder.
 *   6. Hydrate the winners into full parent contexts and assign citation
 *      indices.
 *
 * Each stage is individually degradable: a dead keyword index, a missing
 * Cohere key, or a query that matches no lexemes all reduce quality without
 * taking the endpoint down.
 */

export interface HybridSearchOptions {
  documentIds?: readonly string[];
  /** Overrides for the eval harness / tuner agent. */
  overrides?: Partial<ReturnType<typeof getRagConfig>>;
}

export async function hybridSearch(
  query: string,
  options: HybridSearchOptions = {},
): Promise<RetrievalResult> {
  const startedAt = Date.now();
  const config = { ...getRagConfig(), ...options.overrides };

  const searchOptions = {
    limit: config.candidates,
    documentIds: options.documentIds,
  };

  // --- Stages 1 & 2: dense and sparse, concurrently ------------------------
  const [queryEmbedding, sparseHits] = await Promise.all([
    embedQuery(query),
    keywordSearch(query, searchOptions).catch((error: unknown) => {
      console.error('[hybrid] sparse retrieval failed, continuing dense-only', error);
      return [];
    }),
  ]);

  const denseHits = await vectorSearch(queryEmbedding, searchOptions);

  if (denseHits.length === 0 && sparseHits.length === 0) {
    return {
      contexts: [],
      stats: {
        denseHits: 0,
        sparseHits: 0,
        fusedCandidates: 0,
        rerankApplied: false,
        droppedBelowThreshold: 0,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  // --- Stage 3: Reciprocal Rank Fusion -------------------------------------
  const fused = reciprocalRankFusion(
    [
      { strategy: 'dense', hits: denseHits, weight: config.rrfDenseWeight },
      { strategy: 'sparse', hits: sparseHits, weight: config.rrfSparseWeight },
    ],
    { k: config.rrfK, limit: config.candidates },
  );

  // --- Stage 4: one candidate per parent -----------------------------------
  const candidates = dedupeByParent(fused);

  // --- Stage 5: cross-encoder rerank ---------------------------------------
  const { items: reranked, applied: rerankApplied } = await rerankCandidates(
    query,
    candidates.map((candidate) => ({ id: candidate.parentId, text: candidate.content })),
    config.rerankTopN,
  );

  // The threshold only means something when a real cross-encoder produced the
  // scores. Applying it to passthrough zeros would empty the context window.
  const selected = rerankApplied
    ? reranked.filter((item) => item.relevanceScore >= config.rerankScoreThreshold)
    : reranked;

  const droppedBelowThreshold = reranked.length - selected.length;

  // If the threshold rejected everything, the honest answer is "the corpus
  // does not cover this" — which the agent handles by escalating to web
  // search. Returning weak contexts anyway is how RAG systems hallucinate.
  const finalItems = selected;

  // --- Stage 6: hydrate parents --------------------------------------------
  const parentMap = await fetchParentContexts(finalItems.map((item) => item.id));
  const fusedByParent = new Map(candidates.map((candidate) => [candidate.parentId, candidate]));

  const contexts: RetrievedContext[] = [];

  finalItems.forEach((item, index) => {
    const parent = parentMap.get(item.id);
    const fusedHit = fusedByParent.get(item.id);
    if (!parent || !fusedHit) return;

    contexts.push({
      parentId: parent.id,
      documentId: parent.document_id,
      filename: parent.filename,
      ordinal: parent.ordinal,
      content: parent.content,
      rerankScore: rerankApplied ? item.relevanceScore : fusedHit.rrfScore,
      rrfScore: fusedHit.rrfScore,
      citationIndex: index + 1,
    });
  });

  return {
    contexts,
    stats: {
      denseHits: denseHits.length,
      sparseHits: sparseHits.length,
      fusedCandidates: candidates.length,
      rerankApplied,
      droppedBelowThreshold,
      durationMs: Date.now() - startedAt,
    },
  };
}

/**
 * Renders contexts into the exact block the synthesizer sees.
 *
 * The `[n]` markers are load-bearing: the synthesis prompt requires every
 * sentence to carry one, and the verifier checks claims against these same
 * numbers. Changing this format means changing both prompts.
 */
export function formatContextsForPrompt(contexts: readonly RetrievedContext[]): string {
  if (contexts.length === 0) {
    return 'NO CONTEXT RETRIEVED. The knowledge base returned no passages for this query.';
  }

  return contexts
    .map(
      (context) =>
        `[${context.citationIndex}] source: ${context.filename} (section ${context.ordinal + 1})\n` +
        `${context.content}`,
    )
    .join('\n\n---\n\n');
}
