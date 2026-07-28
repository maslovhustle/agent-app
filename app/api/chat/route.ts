import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { z } from 'zod';

import {
  buildConversationContext,
  createResearchGraph,
  extractLatestQuestion,
  type AgentRuntime,
  type ResearchUIMessage,
} from '@/lib/ai/agent';
import { startTrace } from '@/lib/ai/langfuse';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { AgentEvent } from '@/lib/types';

/**
 * The single chat endpoint.
 *
 * It streams three interleaved things over one HTTP response:
 *   • answer tokens          → the chat bubble
 *   • `data-agent-event`s    → the live agent inspector
 *   • a final `data-trace`   → the Langfuse trace drawer
 *
 * Node runtime (not Edge) because the graph reaches Postgres, `unpdf` and the
 * Langfuse SDK, all of which want Node APIs.
 */
export const runtime = 'nodejs';
export const maxDuration = 120;

const requestSchema = z.object({
  messages: z.array(z.unknown()),
  documentIds: z.array(z.string().uuid()).optional(),
  sessionId: z.string().optional(),
  /** Sent by useChat when the client regenerates; accepted and ignored. */
  id: z.string().optional(),
  trigger: z.string().optional(),
  messageId: z.string().optional(),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid request', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const messages = parsed.data.messages as ResearchUIMessage[];
  const question = extractLatestQuestion(messages);

  if (!question) {
    return Response.json({ error: 'No user message found' }, { status: 400 });
  }

  const conversationContext = buildConversationContext(messages);
  const sessionId = parsed.data.sessionId;

  const trace = startTrace({
    name: 'compliance-research-turn',
    input: { question, documentIds: parsed.data.documentIds },
    sessionId,
    metadata: { documentFilterCount: parsed.data.documentIds?.length ?? 0 },
  });

  const stream = createUIMessageStream<ResearchUIMessage>({
    // Surface the real reason a turn failed. This app is a developer tool; the
    // default opaque "An error occurred." would hide exactly the information
    // the inspector exists to show.
    onError: (error) => (error instanceof Error ? error.message : 'Unknown agent error'),

    execute: async ({ writer }) => {
      const textId = crypto.randomUUID();
      let textStarted = false;

      const agentRuntime: AgentRuntime = {
        trace,
        emit(event: AgentEvent) {
          writer.write({ type: 'data-agent-event', data: event });
        },
        emitTextDelta(delta: string) {
          if (!textStarted) {
            writer.write({ type: 'text-start', id: textId });
            textStarted = true;
          }
          writer.write({ type: 'text-delta', id: textId, delta });
        },
      };

      const graph = createResearchGraph(agentRuntime);

      try {
        const finalState = await graph.invoke(
          {
            question,
            conversationContext,
            documentIds: parsed.data.documentIds,
          },
          {
            // Each plan step is one retriever visit; the ceiling bounds a
            // pathological planner rather than a normal 4-step plan.
            recursionLimit: 24,
          },
        );

        if (textStarted) {
          writer.write({ type: 'text-end', id: textId });
        }

        const summary = trace.summary();
        writer.write({ type: 'data-trace', data: summary });

        await persistTrace({
          summary,
          question,
          sessionId,
          verification: finalState.verificationStatus,
        });

        await trace.end({
          answer: finalState.answer,
          verification: finalState.verification,
        });
      } catch (error) {
        if (textStarted) {
          writer.write({ type: 'text-end', id: textId });
        }
        await trace.end({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

/**
 * Mirrors the trace summary into Postgres so the UI can show a turn's cost and
 * latency without a round trip to Langfuse — and so cost analytics survive a
 * change of observability vendor. Failure here is logged, never propagated:
 * the user already has their answer.
 */
async function persistTrace(params: {
  summary: { traceId: string | null; latencyMs: number; promptTokens: number; outputTokens: number; totalCostUsd: number };
  question: string;
  sessionId: string | undefined;
  verification: string;
}): Promise<void> {
  if (!params.summary.traceId) return;

  try {
    const supabase = getSupabaseAdmin();
    await supabase.from('chat_traces').insert({
      trace_id: params.summary.traceId,
      session_id: params.sessionId ?? null,
      question: params.question.slice(0, 2000),
      latency_ms: params.summary.latencyMs,
      prompt_tokens: params.summary.promptTokens,
      output_tokens: params.summary.outputTokens,
      total_cost_usd: params.summary.totalCostUsd,
      verification: params.verification,
    });
  } catch (error) {
    console.error('[chat] failed to persist trace summary', error);
  }
}
