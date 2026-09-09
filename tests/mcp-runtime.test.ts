import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@/lib/types';

/**
 * `createHeadlessRuntime` is the collect-instead-of-stream `AgentRuntime` the
 * MCP tools run the graph against: the graph itself is unmodified, so the
 * only thing worth testing here is that events are collected faithfully and
 * that `nodeTimings()` derives correctly from them. Langfuse is stubbed —
 * tracing is a degradable dependency per CLAUDE.md, and asserting against a
 * real `startTrace()` would mean asserting against Langfuse being configured.
 */

const traceEndCalls = vi.hoisted(() => [] as unknown[]);
const startTraceCalls = vi.hoisted(() => [] as unknown[]);

vi.mock('@/lib/ai/langfuse', () => ({
  startTrace: (params: unknown) => {
    startTraceCalls.push(params);
    return {
      id: null,
      url: null,
      enabled: false,
      span: () => ({ end: () => {} }),
      generation: () => {},
      recordUsage: () => {},
      summary: () => ({
        traceId: null,
        traceUrl: null,
        latencyMs: 0,
        promptTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        model: '',
        tracingEnabled: false,
      }),
      end: async (output?: unknown) => {
        traceEndCalls.push(output);
      },
    };
  },
}));

async function importRuntime() {
  return import('@/mcp/runtime');
}

function event(partial: AgentEvent): AgentEvent {
  return partial;
}

describe('createHeadlessRuntime', () => {
  it('starts a trace named for the mcp surface, tagged with the document filter', async () => {
    const { createHeadlessRuntime } = await importRuntime();

    createHeadlessRuntime({ question: 'What is the breach deadline?', documentIds: ['a', 'b'] });

    expect(startTraceCalls).toHaveLength(1);
    expect(startTraceCalls[0]).toMatchObject({
      name: 'mcp-ask-with-citations',
      input: { question: 'What is the breach deadline?', documentIds: ['a', 'b'] },
      metadata: { surface: 'mcp', documentFilterCount: 2 },
    });
  });

  it('tags documentFilterCount as 0 when no filter is supplied', async () => {
    const { createHeadlessRuntime } = await importRuntime();

    createHeadlessRuntime({ question: 'q' });

    expect(startTraceCalls.at(-1)).toMatchObject({ metadata: { documentFilterCount: 0 } });
  });

  it('collects every emitted event in order, unmodified', async () => {
    const { createHeadlessRuntime } = await importRuntime();
    const headless = createHeadlessRuntime({ question: 'q' });

    const e1 = event({ kind: 'node_start', node: 'planner', label: 'Planning', at: 1 });
    const e2 = event({ kind: 'node_end', node: 'planner', durationMs: 50, at: 2 });
    const e3 = event({ kind: 'error', node: 'retriever', message: 'boom', at: 3 });

    headless.runtime.emit(e1);
    headless.runtime.emit(e2);
    headless.runtime.emit(e3);

    expect(headless.events).toEqual([e1, e2, e3]);
  });

  it('ignores text deltas — there is nothing to stream them into', async () => {
    const { createHeadlessRuntime } = await importRuntime();
    const headless = createHeadlessRuntime({ question: 'q' });

    expect(() => headless.runtime.emitTextDelta('token')).not.toThrow();
    expect(headless.events).toEqual([]);
  });

  describe('nodeTimings', () => {
    it('derives one entry per node_end event, preserving order', async () => {
      const { createHeadlessRuntime } = await importRuntime();
      const headless = createHeadlessRuntime({ question: 'q' });

      headless.runtime.emit(event({ kind: 'node_start', node: 'planner', label: 'Planning', at: 0 }));
      headless.runtime.emit(event({ kind: 'node_end', node: 'planner', durationMs: 12, at: 1 }));
      headless.runtime.emit(
        event({ kind: 'node_end', node: 'retriever', durationMs: 340, at: 2 }),
      );
      headless.runtime.emit(
        event({ kind: 'node_end', node: 'synthesizer', durationMs: 900, at: 3 }),
      );

      expect(headless.nodeTimings()).toEqual([
        { node: 'planner', durationMs: 12 },
        { node: 'retriever', durationMs: 340 },
        { node: 'synthesizer', durationMs: 900 },
      ]);
    });

    it('is empty when the graph never reached a node_end', async () => {
      const { createHeadlessRuntime } = await importRuntime();
      const headless = createHeadlessRuntime({ question: 'q' });

      headless.runtime.emit(event({ kind: 'node_start', node: 'planner', label: 'Planning', at: 0 }));
      headless.runtime.emit(event({ kind: 'error', node: 'planner', message: 'boom', at: 1 }));

      expect(headless.nodeTimings()).toEqual([]);
    });

    it('excludes non-node_end kinds even when interleaved', async () => {
      const { createHeadlessRuntime } = await importRuntime();
      const headless = createHeadlessRuntime({ question: 'q' });

      headless.runtime.emit(event({ kind: 'node_end', node: 'planner', durationMs: 5, at: 0 }));
      headless.runtime.emit(
        event({
          kind: 'verification',
          verification: {
            status: 'grounded',
            confidence: 1,
            unsupportedClaims: [],
            reasoning: 'ok',
          },
          at: 1,
        }),
      );
      headless.runtime.emit(event({ kind: 'node_end', node: 'verifier', durationMs: 8, at: 2 }));

      expect(headless.nodeTimings()).toEqual([
        { node: 'planner', durationMs: 5 },
        { node: 'verifier', durationMs: 8 },
      ]);
    });
  });

  it('passes the trace end payload straight through to the stubbed trace handle', async () => {
    const { createHeadlessRuntime } = await importRuntime();
    const headless = createHeadlessRuntime({ question: 'q' });

    await headless.trace.end({ answer: 'done' });

    expect(traceEndCalls).toContainEqual({ answer: 'done' });
  });
});

describe('eventsOfKind', () => {
  it('narrows the event log to one kind, preserving order', async () => {
    const { eventsOfKind } = await importRuntime();
    const events: AgentEvent[] = [
      event({ kind: 'node_start', node: 'planner', label: 'Planning', at: 0 }),
      event({ kind: 'node_end', node: 'planner', durationMs: 1, at: 1 }),
      event({ kind: 'node_start', node: 'retriever', label: 'Retrieving', at: 2 }),
      event({ kind: 'node_end', node: 'retriever', durationMs: 2, at: 3 }),
    ];

    const ends = eventsOfKind(events, 'node_end');

    expect(ends.map((e) => e.node)).toEqual(['planner', 'retriever']);
  });

  it('returns an empty array when no event matches', async () => {
    const { eventsOfKind } = await importRuntime();
    const events: AgentEvent[] = [
      event({ kind: 'node_start', node: 'planner', label: 'Planning', at: 0 }),
    ];

    expect(eventsOfKind(events, 'error')).toEqual([]);
  });
});
