import type { UIMessage } from 'ai';

import type { AgentEvent, TraceSummary } from '@/lib/types';

/**
 * The typed contract between the streaming route and `useChat`.
 *
 * Beyond plain text, this stream carries two custom data-part channels:
 *
 *   `data-agent-event` — every planner decision, retrieval, and verification,
 *                        streamed live so the inspector drawer fills in while
 *                        the answer is still being written.
 *   `data-trace`       — one final summary with the Langfuse trace id,
 *                        latency, tokens and estimated cost.
 *
 * Declaring them here means the client gets full autocomplete on
 * `part.data` instead of casting from `unknown`.
 */
export type ResearchDataParts = {
  'agent-event': AgentEvent;
  trace: TraceSummary;
};

export type ResearchUIMessage = UIMessage<never, ResearchDataParts>;

/**
 * Flattens prior turns into a plain-text transcript for the planner and
 * synthesizer.
 *
 * Only the last few turns are kept: the retrieved context is what should
 * dominate the prompt, and an unbounded history slowly crowds it out — the
 * quiet way multi-turn RAG quality degrades.
 */
export function buildConversationContext(
  messages: readonly ResearchUIMessage[],
  maxTurns = 4,
): string {
  const priorTurns = messages.slice(0, -1).slice(-maxTurns * 2);

  return priorTurns
    .map((message) => {
      const text = extractText(message);
      if (!text) return null;
      const role = message.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${truncate(text, 600)}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** Pulls the latest user question out of the UI message list. */
export function extractLatestQuestion(messages: readonly ResearchUIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = extractText(message);
    if (text) return text;
  }
  return '';
}

function extractText(message: ResearchUIMessage): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
