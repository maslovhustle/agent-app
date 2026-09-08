import type { AgentRuntime } from '@/lib/ai/agent';
import { startTrace, type TraceHandle } from '@/lib/ai/langfuse';
import type { AgentEvent, AgentNodeName } from '@/lib/types';

/**
 * A headless `AgentRuntime`.
 *
 * The graph was written to stream into a browser; MCP is request/response. The
 * only difference that makes is where the telemetry goes: instead of writing
 * `data-agent-event` parts onto an HTTP stream, we collect the same events in
 * an array and fold them into the tool result. The graph itself is untouched,
 * which is the point — the inspector drawer and an MCP client are two renders
 * of one event stream, not two implementations of one agent.
 */

export interface HeadlessRuntime {
  runtime: AgentRuntime;
  trace: TraceHandle;
  /** Every event the graph emitted, in order. */
  events: readonly AgentEvent[];
  /** Wall time per node, derived from the emitted `node_end` events. */
  nodeTimings(): Array<{ node: AgentNodeName; durationMs: number }>;
}

export function createHeadlessRuntime(params: {
  question: string;
  documentIds?: readonly string[];
}): HeadlessRuntime {
  const events: AgentEvent[] = [];

  const trace = startTrace({
    name: 'mcp-ask-with-citations',
    input: { question: params.question, documentIds: params.documentIds },
    metadata: {
      surface: 'mcp',
      documentFilterCount: params.documentIds?.length ?? 0,
    },
  });

  const runtime: AgentRuntime = {
    trace,
    emit(event) {
      events.push(event);
    },
    // Deltas exist so a chat panel can render tokens as they arrive. A tool
    // call has nothing to render them into, and the completed answer is on the
    // final graph state, so there is nothing useful to do with them here.
    emitTextDelta() {},
  };

  return {
    runtime,
    trace,
    events,
    nodeTimings: () =>
      events
        .filter((event): event is Extract<AgentEvent, { kind: 'node_end' }> =>
          event.kind === 'node_end',
        )
        .map((event) => ({ node: event.node, durationMs: event.durationMs })),
  };
}

/** Narrows the collected event log to one event kind. */
export function eventsOfKind<K extends AgentEvent['kind']>(
  events: readonly AgentEvent[],
  kind: K,
): Array<Extract<AgentEvent, { kind: K }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind,
  );
}
