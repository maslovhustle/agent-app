import type { RetrievedContext } from '@/lib/types';

/**
 * Retrieval quality metrics.
 *
 * These are the numbers to move when tuning the pipeline. They are computed
 * over a ground-truth dataset (`evals/dataset.json`) that maps each question
 * to the phrases a correct context must contain.
 *
 * Phrase matching rather than chunk-id matching is deliberate: chunk ids change
 * every time you touch a chunking hyperparameter, which would make the ground
 * truth useless for exactly the experiments it exists to support.
 */

export interface EvalCase {
  id: string;
  question: string;
  /** A retrieved context is "relevant" if it contains any of these phrases. */
  expectedPhrases: string[];
  /** Substrings a correct final answer should contain. */
  expectedAnswerContains?: string[];
  /** Optional filename hint, checked only when present. */
  expectedSource?: string;
}

export interface CaseResult {
  caseId: string;
  hit: boolean;
  /** 1-indexed rank of the first relevant context; 0 when none was found. */
  firstRelevantRank: number;
  precisionAtK: number;
  recall: number;
  reciprocalRank: number;
  retrievedCount: number;
}

function isRelevant(context: RetrievedContext, phrases: readonly string[]): boolean {
  const haystack = context.content.toLowerCase();
  return phrases.some((phrase) => haystack.includes(phrase.toLowerCase()));
}

export function scoreCase(
  evalCase: EvalCase,
  contexts: readonly RetrievedContext[],
): CaseResult {
  const relevantFlags = contexts.map((context) => isRelevant(context, evalCase.expectedPhrases));
  const firstRelevantIndex = relevantFlags.indexOf(true);
  const relevantCount = relevantFlags.filter(Boolean).length;

  // Recall here is "how many of the expected phrases were covered at all",
  // which is what actually matters for answerability — a single context
  // containing every required phrase is a complete retrieval.
  const coveredPhrases = evalCase.expectedPhrases.filter((phrase) =>
    contexts.some((context) => context.content.toLowerCase().includes(phrase.toLowerCase())),
  ).length;

  return {
    caseId: evalCase.id,
    hit: firstRelevantIndex >= 0,
    firstRelevantRank: firstRelevantIndex + 1,
    precisionAtK: contexts.length === 0 ? 0 : relevantCount / contexts.length,
    recall:
      evalCase.expectedPhrases.length === 0
        ? 1
        : coveredPhrases / evalCase.expectedPhrases.length,
    reciprocalRank: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
    retrievedCount: contexts.length,
  };
}

export interface AggregateMetrics {
  cases: number;
  /** Fraction of questions where at least one relevant context was retrieved. */
  hitRate: number;
  /** Mean Reciprocal Rank — rewards putting the right context first. */
  mrr: number;
  meanPrecision: number;
  meanRecall: number;
}

export function aggregate(results: readonly CaseResult[]): AggregateMetrics {
  if (results.length === 0) {
    return { cases: 0, hitRate: 0, mrr: 0, meanPrecision: 0, meanRecall: 0 };
  }

  const mean = (pick: (result: CaseResult) => number): number =>
    results.reduce((sum, result) => sum + pick(result), 0) / results.length;

  return {
    cases: results.length,
    hitRate: results.filter((result) => result.hit).length / results.length,
    mrr: mean((result) => result.reciprocalRank),
    meanPrecision: mean((result) => result.precisionAtK),
    meanRecall: mean((result) => result.recall),
  };
}

/**
 * Cheap, deterministic groundedness proxy: what fraction of the answer's
 * citation markers point at a context that was actually supplied.
 *
 * This is not a replacement for the LLM verifier node — it cannot tell whether
 * a cited passage supports the claim. It catches the coarser failure the
 * verifier sometimes misses: a model inventing `[7]` when it was handed four
 * contexts.
 */
export function citationValidity(answer: string, contextCount: number): number {
  const markers = [...answer.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));

  if (markers.length === 0) return 0;

  const valid = markers.filter((marker) => marker >= 1 && marker <= contextCount).length;
  return valid / markers.length;
}
