import 'server-only';

import { Langfuse } from 'langfuse';

import { estimateCostUsd } from '@/lib/ai/models';
import { getEnv } from '@/lib/env';
import type { TraceSummary } from '@/lib/types';

/**
 * Observability wrapper around Langfuse.
 *
 * Two design rules:
 *
 *  1. **Tracing is never load-bearing.** If Langfuse is unconfigured or its
 *     API is down, every call here becomes a no-op and the request completes
 *     normally. An observability outage must not become a product outage.
 *
 *  2. **The trace mirrors the graph.** One trace per chat turn; one span per
 *     LangGraph node; one generation per LLM call. That way the Langfuse
 *     execution tree and the agent inspector drawer show the same structure,
 *     and a slow turn can be attributed to a specific node without guessing.
 */

let client: Langfuse | null = null;

function getClient(): Langfuse | null {
  const env = getEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;

  client ??= new Langfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL,
    flushAt: 1,
  });

  return client;
}

export interface UsageDelta {
  promptTokens: number;
  outputTokens: number;
  model: string;
}

export interface SpanHandle {
  end(output?: unknown): void;
}

export interface TraceHandle {
  readonly id: string | null;
  readonly url: string | null;
  readonly enabled: boolean;
  span(name: string, input?: unknown): SpanHandle;
  generation(params: {
    name: string;
    model: string;
    input: unknown;
    output: unknown;
    usage: { promptTokens: number; outputTokens: number };
  }): void;
  recordUsage(delta: UsageDelta): void;
  summary(): TraceSummary;
  end(output?: unknown): Promise<void>;
}

const NOOP_SPAN: SpanHandle = { end: () => undefined };

export interface StartTraceParams {
  name: string;
  input: unknown;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export function startTrace(params: StartTraceParams): TraceHandle {
  const startedAt = Date.now();
  const langfuse = getClient();
  const env = getEnv();

  let promptTokens = 0;
  let outputTokens = 0;
  let totalCostUsd = 0;
  // A turn calls multiple roles (planner/synthesizer/verifier), which can
  // resolve to different model ids under the fast/reasoning tiering in
  // lib/ai/models.ts. Tracking the full set — rather than just the first
  // call's model — is what keeps the trace drawer's cost story honest.
  const modelsUsed = new Set<string>();

  const recordUsage = (delta: UsageDelta): void => {
    promptTokens += delta.promptTokens;
    outputTokens += delta.outputTokens;
    totalCostUsd += estimateCostUsd(delta.model, delta.promptTokens, delta.outputTokens);
    if (delta.model) modelsUsed.add(delta.model);
  };

  const modelsLabel = (): string => [...modelsUsed].join(' + ');

  // --- Disabled path: a fully-typed handle that does nothing --------------
  if (!langfuse) {
    return {
      id: null,
      url: null,
      enabled: false,
      span: () => NOOP_SPAN,
      generation: (generationParams) =>
        recordUsage({
          model: generationParams.model,
          promptTokens: generationParams.usage.promptTokens,
          outputTokens: generationParams.usage.outputTokens,
        }),
      recordUsage,
      summary: () => ({
        traceId: null,
        traceUrl: null,
        latencyMs: Date.now() - startedAt,
        promptTokens,
        outputTokens,
        totalCostUsd,
        model: modelsLabel(),
        tracingEnabled: false,
      }),
      end: async () => undefined,
    };
  }

  // --- Enabled path --------------------------------------------------------
  const trace = langfuse.trace({
    name: params.name,
    input: params.input,
    sessionId: params.sessionId,
    metadata: {
      ...params.metadata,
      provider: env.AGENT_PROVIDER,
      vectorStore: env.VECTOR_STORE,
    },
  });

  const traceUrl = `${env.LANGFUSE_BASE_URL.replace(/\/$/, '')}/trace/${trace.id}`;

  return {
    id: trace.id,
    url: traceUrl,
    enabled: true,

    span(name, input) {
      const span = trace.span({ name, input });
      return {
        end(output) {
          span.end({ output });
        },
      };
    },

    generation(generationParams) {
      trace.generation({
        name: generationParams.name,
        model: generationParams.model,
        input: generationParams.input,
        output: generationParams.output,
        usage: {
          promptTokens: generationParams.usage.promptTokens,
          completionTokens: generationParams.usage.outputTokens,
        },
      });
      recordUsage({
        model: generationParams.model,
        promptTokens: generationParams.usage.promptTokens,
        outputTokens: generationParams.usage.outputTokens,
      });
    },

    recordUsage,

    summary: () => ({
      traceId: trace.id,
      traceUrl,
      latencyMs: Date.now() - startedAt,
      promptTokens,
      outputTokens,
      totalCostUsd,
      model: modelsLabel(),
      tracingEnabled: true,
    }),

    async end(output) {
      try {
        trace.update({ output });
        await langfuse.flushAsync();
      } catch (error) {
        console.error('[langfuse] flush failed (request unaffected)', error);
      }
    },
  };
}

/**
 * Normalises the AI SDK's usage object, whose token fields have shifted names
 * across versions. Missing values become 0 rather than NaN so cost arithmetic
 * stays finite.
 */
export function normalizeUsage(usage: unknown): { promptTokens: number; outputTokens: number } {
  if (typeof usage !== 'object' || usage === null) {
    return { promptTokens: 0, outputTokens: 0 };
  }

  const record = usage as Record<string, unknown>;
  const read = (...keys: string[]): number => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
  };

  return {
    promptTokens: read('inputTokens', 'promptTokens'),
    outputTokens: read('outputTokens', 'completionTokens'),
  };
}
