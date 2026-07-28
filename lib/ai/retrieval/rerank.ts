import 'server-only';

import { CohereClient } from 'cohere-ai';

import { getEnv } from '@/lib/env';

/**
 * Cohere cross-encoder reranking.
 *
 * Bi-encoders (what the vector index uses) embed the query and the document
 * independently, so they can only measure how close two summaries land in
 * vector space. A cross-encoder reads the query and the document *together*
 * in one forward pass and scores the pair directly. It is far more accurate
 * and far too slow to run over a corpus — which is precisely why it belongs
 * here, as a second stage over ~20 RRF survivors rather than a first-stage
 * index.
 *
 * This is the single highest-leverage precision win in the pipeline: it is
 * what turns "20 plausible chunks" into "the 4 that actually answer the
 * question".
 */

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankedItem {
  id: string;
  /** Normalised cross-encoder relevance in [0, 1]. */
  relevanceScore: number;
}

let cohere: CohereClient | null = null;

function getCohere(): CohereClient | null {
  const env = getEnv();
  if (!env.COHERE_API_KEY) return null;
  cohere ??= new CohereClient({ token: env.COHERE_API_KEY });
  return cohere;
}

export interface RerankResult {
  items: RerankedItem[];
  /** False when no COHERE_API_KEY is configured or the call failed. */
  applied: boolean;
}

/**
 * Reranks candidates and returns the top `topN`.
 *
 * Degrades rather than fails: without a Cohere key — or if the API errors —
 * the caller gets the candidates back in their original RRF order with
 * `applied: false`. A reranker outage should cost precision, not availability.
 */
export async function rerankCandidates(
  query: string,
  candidates: readonly RerankCandidate[],
  topN: number,
): Promise<RerankResult> {
  if (candidates.length === 0) {
    return { items: [], applied: false };
  }

  const client = getCohere();
  if (!client) {
    return { items: passthrough(candidates, topN), applied: false };
  }

  const env = getEnv();

  try {
    const response = await client.rerank({
      model: env.COHERE_RERANK_MODEL,
      query,
      documents: candidates.map((candidate) => ({ text: candidate.text })),
      topN: Math.min(topN, candidates.length),
      returnDocuments: false,
    });

    const items: RerankedItem[] = [];
    for (const result of response.results) {
      const candidate = candidates[result.index];
      if (!candidate) continue;
      items.push({ id: candidate.id, relevanceScore: result.relevanceScore });
    }

    return { items, applied: true };
  } catch (error) {
    // Observability picks this up via the surrounding Langfuse span; the
    // request itself continues on the RRF ordering.
    console.error('[rerank] Cohere rerank failed, falling back to RRF order', error);
    return { items: passthrough(candidates, topN), applied: false };
  }
}

/**
 * Fallback ordering. Scores are set to 0 rather than a fabricated value so
 * that nothing downstream mistakes RRF position for cross-encoder relevance —
 * `applied: false` is the flag callers must branch on.
 */
function passthrough(candidates: readonly RerankCandidate[], topN: number): RerankedItem[] {
  return candidates.slice(0, topN).map((candidate) => ({
    id: candidate.id,
    relevanceScore: 0,
  }));
}
