import { Annotation } from '@langchain/langgraph';

import type {
  Plan,
  RetrievalResult,
  RetrievedContext,
  Verification,
  VerificationStatus,
  WebSearchResult,
} from '@/lib/types';

/**
 * The agent's state channel definition.
 *
 * LangGraph state is not a mutable object you pass around — each node returns
 * a *partial update*, and the reducer declared per channel decides how that
 * update merges with what is already there. Getting the reducers right is most
 * of the work: `contexts` accumulates across retrieval steps, while `answer`
 * is last-write-wins.
 */

export const ResearchState = Annotation.Root({
  /** The user's question for this turn. */
  question: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => '',
  }),

  /** Flattened prior turns, used by the planner and synthesizer for pronouns. */
  conversationContext: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => '',
  }),

  /** Optional corpus filter chosen in the documents panel. */
  documentIds: Annotation<string[] | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),

  /** Produced by the planner node. */
  plan: Annotation<Plan | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),

  /** Index of the plan step the retriever is currently executing. */
  currentStep: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),

  /**
   * Accumulated across every retrieval step, de-duplicated by parent id.
   * Multi-step plans frequently surface the same clause from two angles;
   * without this reducer the context window fills with duplicates.
   */
  contexts: Annotation<RetrievedContext[]>({
    reducer: (current, update) => mergeContexts(current, update),
    default: () => [],
  }),

  /** Per-step retrieval telemetry, kept for the inspector drawer. */
  retrievalStats: Annotation<RetrievalResult['stats'][]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  /** Populated only when the retriever's evidence was judged insufficient. */
  webResults: Annotation<WebSearchResult[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  /** The synthesized answer. */
  answer: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => '',
  }),

  verification: Annotation<Verification | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),

  verificationStatus: Annotation<VerificationStatus>({
    reducer: (_current, update) => update,
    default: () => 'pending',
  }),
});

export type ResearchStateType = typeof ResearchState.State;
export type ResearchStateUpdate = typeof ResearchState.Update;

/**
 * Merges newly retrieved contexts into the accumulated set.
 *
 * De-duplicates by `parentId`, keeps the higher rerank score when the same
 * parent is found twice, and re-assigns `citationIndex` so the numbering the
 * synthesizer sees is contiguous starting at 1. Contiguity matters — the
 * citation contract in the prompt is only enforceable if the numbers the model
 * is shown are the numbers the verifier checks.
 */
export function mergeContexts(
  current: readonly RetrievedContext[],
  update: readonly RetrievedContext[],
): RetrievedContext[] {
  const byParent = new Map<string, RetrievedContext>();

  for (const context of [...current, ...update]) {
    const existing = byParent.get(context.parentId);
    if (!existing || context.rerankScore > existing.rerankScore) {
      byParent.set(context.parentId, context);
    }
  }

  return [...byParent.values()]
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .map((context, index) => ({ ...context, citationIndex: index + 1 }));
}
