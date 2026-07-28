import 'server-only';

import { END, START, StateGraph } from '@langchain/langgraph';
import { generateObject, streamText } from 'ai';

import { normalizeUsage, type TraceHandle } from '@/lib/ai/langfuse';
import { getModel, getModelId } from '@/lib/ai/models';
import { formatContextsForPrompt, hybridSearch } from '@/lib/ai/retrieval';
import { formatWebResultsForPrompt, webSearch } from '@/lib/ai/tools/web-search';
import {
  planSchema,
  verificationSchema,
  type AgentEvent,
  type AgentNodeName,
  type Plan,
} from '@/lib/types';

import {
  buildPlannerPrompt,
  buildSynthesisPrompt,
  buildVerificationPrompt,
  PLANNER_SYSTEM_PROMPT,
  SYNTHESIZER_SYSTEM_PROMPT,
  VERIFIER_SYSTEM_PROMPT,
} from './prompts';
import { ResearchState, type ResearchStateType, type ResearchStateUpdate } from './state';

/**
 * The investigative research agent.
 *
 *   START → planner → retriever ⇄ (loop over plan steps)
 *                        ├→ web_search → synthesizer
 *                        └→ synthesizer → verifier → END
 *
 * Why a graph rather than a tool-calling loop: the control flow here is known
 * in advance and must be *inspectable*. A compliance analyst needs to see that
 * the answer came from three specific retrievals and passed a grounding check
 * — not that an LLM decided, opaquely, to call a tool four times. The graph
 * makes the pipeline a diagram instead of a transcript.
 *
 * The graph is compiled per request so it can close over the request's runtime
 * (event emitter + Langfuse trace) with full type safety. Compilation is
 * object wiring — no I/O, no meaningful cost.
 */

export interface AgentRuntime {
  /** Streams a structured telemetry event to the inspector drawer. */
  emit(event: AgentEvent): void;
  /** Streams an answer token to the chat panel. */
  emitTextDelta(delta: string): void;
  trace: TraceHandle;
}

/**
 * Below this cross-encoder score, the corpus is judged not to actually cover
 * the question, and the agent escalates to web search rather than writing a
 * confident answer over weak evidence.
 */
const WEB_SEARCH_ESCALATION_THRESHOLD = 0.5;

export function createResearchGraph(runtime: AgentRuntime) {
  /** Wraps a node so timing, tracing and error reporting are uniform. */
  const instrument = <T>(
    node: AgentNodeName,
    label: string,
    fn: (state: ResearchStateType) => Promise<T>,
  ) => {
    return async (state: ResearchStateType): Promise<T> => {
      const startedAt = Date.now();
      runtime.emit({ kind: 'node_start', node, label, at: startedAt });
      const span = runtime.trace.span(node, { question: state.question });

      try {
        const result = await fn(state);
        span.end(result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        span.end({ error: message });
        runtime.emit({ kind: 'error', node, message, at: Date.now() });
        throw error;
      } finally {
        runtime.emit({
          kind: 'node_end',
          node,
          durationMs: Date.now() - startedAt,
          at: Date.now(),
        });
      }
    };
  };

  // -------------------------------------------------------------------------
  // Node: planner
  // -------------------------------------------------------------------------
  const planner = instrument<ResearchStateUpdate>(
    'planner',
    'Analyzing question and building a research plan',
    async (state) => {
      const model = getModelId('planner');

      const { object, usage } = await generateObject({
        model: getModel('planner'),
        schema: planSchema,
        system: PLANNER_SYSTEM_PROMPT,
        prompt: buildPlannerPrompt(state.question, state.conversationContext),
      });

      const normalized = normalizeUsage(usage);
      runtime.trace.generation({
        name: 'planner',
        model,
        input: state.question,
        output: object,
        usage: normalized,
      });

      const plan: Plan = object;
      runtime.emit({ kind: 'plan', plan, at: Date.now() });

      return { plan, currentStep: 0 };
    },
  );

  // -------------------------------------------------------------------------
  // Node: retriever — hybrid search + RRF + rerank for one plan step
  // -------------------------------------------------------------------------
  const retriever = instrument<ResearchStateUpdate>(
    'retriever',
    'Searching the knowledge base (hybrid + rerank)',
    async (state) => {
      const step = state.plan?.steps[state.currentStep];

      // Defensive: a planner that returned an empty plan must not deadlock the
      // graph. Fall back to the raw question.
      const query = step?.query ?? state.question;
      const stepId = step?.id ?? 'fallback';

      const result = await hybridSearch(query, {
        documentIds: state.documentIds,
      });

      runtime.emit({
        kind: 'retrieval',
        stepId,
        query,
        contexts: result.contexts,
        stats: result.stats,
        at: Date.now(),
      });

      return {
        contexts: result.contexts,
        retrievalStats: [result.stats],
        currentStep: state.currentStep + 1,
      };
    },
  );

  // -------------------------------------------------------------------------
  // Node: web_search — fallback when local evidence is thin
  // -------------------------------------------------------------------------
  const webSearchNode = instrument<ResearchStateUpdate>(
    'web_search',
    'Local corpus insufficient — searching the web',
    async (state) => {
      const results = await webSearch(state.question);
      runtime.emit({
        kind: 'web_search',
        query: state.question,
        results,
        at: Date.now(),
      });
      return { webResults: results };
    },
  );

  // -------------------------------------------------------------------------
  // Node: synthesizer — streams the answer token by token
  // -------------------------------------------------------------------------
  const synthesizer = instrument<ResearchStateUpdate>(
    'synthesizer',
    'Writing a cited answer',
    async (state) => {
      const model = getModelId('synthesizer');
      const contextBlock = formatContextsForPrompt(state.contexts);
      const webBlock =
        state.webResults.length > 0 ? formatWebResultsForPrompt(state.webResults) : null;

      const result = streamText({
        model: getModel('synthesizer'),
        system: SYNTHESIZER_SYSTEM_PROMPT,
        prompt: buildSynthesisPrompt({
          question: state.question,
          contextBlock,
          webBlock,
          conversationContext: state.conversationContext,
        }),
        temperature: 0.2,
      });

      let answer = '';
      for await (const delta of result.textStream) {
        answer += delta;
        runtime.emitTextDelta(delta);
      }

      const normalized = normalizeUsage(await result.usage);
      runtime.trace.generation({
        name: 'synthesizer',
        model,
        input: { question: state.question, contextCount: state.contexts.length },
        output: answer,
        usage: normalized,
      });

      return { answer };
    },
  );

  // -------------------------------------------------------------------------
  // Node: verifier — adversarial grounding check
  // -------------------------------------------------------------------------
  const verifier = instrument<ResearchStateUpdate>(
    'verifier',
    'Checking the answer against retrieved evidence',
    async (state) => {
      // Nothing was retrieved: there is nothing to be grounded in, and asking
      // the verifier would burn a call to learn what we already know.
      if (state.contexts.length === 0) {
        const verification = {
          status: 'unsupported' as const,
          confidence: 0,
          unsupportedClaims: [],
          reasoning:
            'No context was retrieved from the knowledge base, so no claim in the answer ' +
            'can be grounded in the corpus.',
        };
        runtime.emit({ kind: 'verification', verification, at: Date.now() });
        return { verification, verificationStatus: verification.status };
      }

      const model = getModelId('verifier');

      const { object, usage } = await generateObject({
        model: getModel('verifier'),
        schema: verificationSchema,
        system: VERIFIER_SYSTEM_PROMPT,
        prompt: buildVerificationPrompt({
          question: state.question,
          contextBlock: formatContextsForPrompt(state.contexts),
          answer: state.answer,
        }),
      });

      const normalized = normalizeUsage(usage);
      runtime.trace.generation({
        name: 'verifier',
        model,
        input: { answerLength: state.answer.length },
        output: object,
        usage: normalized,
      });

      runtime.emit({ kind: 'verification', verification: object, at: Date.now() });

      return { verification: object, verificationStatus: object.status };
    },
  );

  // -------------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------------

  /**
   * After each retrieval: keep looping while plan steps remain, then decide
   * whether the accumulated evidence justifies going straight to synthesis or
   * warrants a web-search escalation.
   */
  const routeAfterRetrieval = (
    state: ResearchStateType,
  ): 'retriever' | 'web_search' | 'synthesizer' => {
    const totalSteps = state.plan?.steps.length ?? 1;

    if (state.currentStep < totalSteps) {
      return 'retriever';
    }

    if (isEvidenceInsufficient(state)) {
      return 'web_search';
    }

    return 'synthesizer';
  };

  const graph = new StateGraph(ResearchState)
    .addNode('planner', planner)
    .addNode('retriever', retriever)
    .addNode('web_search', webSearchNode)
    .addNode('synthesizer', synthesizer)
    .addNode('verifier', verifier)
    .addEdge(START, 'planner')
    .addEdge('planner', 'retriever')
    .addConditionalEdges('retriever', routeAfterRetrieval, [
      'retriever',
      'web_search',
      'synthesizer',
    ])
    .addEdge('web_search', 'synthesizer')
    .addEdge('synthesizer', 'verifier')
    .addEdge('verifier', END);

  return graph.compile();
}

/**
 * Evidence sufficiency heuristic.
 *
 * Two ways the corpus can fail us: it returned nothing, or it returned
 * passages the cross-encoder scored as only loosely related. The second case
 * is the dangerous one — an LLM handed weak-but-topical context will happily
 * write a confident wrong answer. Escalating to web search is cheaper than
 * retracting one.
 *
 * The check is skipped when reranking is unavailable, because RRF scores are
 * not calibrated across queries and thresholding them means nothing.
 */
function isEvidenceInsufficient(state: ResearchStateType): boolean {
  if (state.contexts.length === 0) return true;

  const rerankWasApplied = state.retrievalStats.some((stat) => stat.rerankApplied);
  if (!rerankWasApplied) return false;

  const bestScore = Math.max(...state.contexts.map((context) => context.rerankScore));
  return bestScore < WEB_SEARCH_ESCALATION_THRESHOLD;
}

export { WEB_SEARCH_ESCALATION_THRESHOLD, isEvidenceInsufficient };
