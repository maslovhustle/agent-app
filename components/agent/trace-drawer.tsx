'use client';

import { Activity, ExternalLink, Info } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { StatRow } from '@/components/ui/panel';
import type { AgentEvent, TraceSummary } from '@/lib/types';
import { formatDuration, formatUsd } from '@/lib/utils';

/**
 * Langfuse trace summary for the last completed turn.
 *
 * Cost and latency are shown next to the per-node breakdown so the expensive
 * part of a turn is obvious at a glance — usually synthesis tokens, sometimes a
 * planner that decomposed a simple question into four retrievals.
 */

interface TraceDrawerProps {
  trace: TraceSummary | null;
  events: AgentEvent[];
}

export function TraceDrawer({ trace, events }: TraceDrawerProps): React.JSX.Element {
  if (!trace) {
    return (
      <p className="px-4 py-6 text-xs text-[var(--color-ink-3)]">
        Trace metadata — latency, token usage and estimated cost — appears here once a turn
        completes.
      </p>
    );
  }

  const nodeTimings = events
    .filter((event): event is Extract<AgentEvent, { kind: 'node_end' }> => event.kind === 'node_end')
    .reduce<Record<string, number>>((accumulator, event) => {
      accumulator[event.node] = (accumulator[event.node] ?? 0) + event.durationMs;
      return accumulator;
    }, {});

  const slowestNode = Object.entries(nodeTimings).sort(([, a], [, b]) => b - a)[0];

  return (
    <div className="flex flex-col gap-3 p-3">
      {!trace.tracingEnabled && (
        <div className="flex items-start gap-2 rounded-lg border border-[oklch(0.79_0.15_85_/_0.35)] bg-[oklch(0.79_0.15_85_/_0.1)] px-3 py-2">
          <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warning)]" />
          <p className="text-[11px] leading-relaxed text-[var(--color-warning)]">
            Langfuse is not configured. Latency and token counts below are measured locally;
            no trace was recorded. Set <code>LANGFUSE_PUBLIC_KEY</code> and{' '}
            <code>LANGFUSE_SECRET_KEY</code> to enable full tracing.
          </p>
        </div>
      )}

      <div className="panel-muted px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <Activity className="size-3 text-[var(--color-brand)]" />
          <span className="text-xs font-medium text-[var(--color-ink-0)]">Turn summary</span>
        </div>

        <StatRow label="Total latency" value={formatDuration(trace.latencyMs)} mono />
        <StatRow label="Model" value={trace.model || '—'} mono />
        <StatRow label="Prompt tokens" value={trace.promptTokens.toLocaleString()} mono />
        <StatRow label="Output tokens" value={trace.outputTokens.toLocaleString()} mono />
        <StatRow
          label="Estimated cost"
          value={<span className="text-[var(--color-brand)]">{formatUsd(trace.totalCostUsd)}</span>}
          mono
        />
      </div>

      {Object.keys(nodeTimings).length > 0 && (
        <div className="panel-muted px-3 py-2.5">
          <p className="mb-1.5 text-xs font-medium text-[var(--color-ink-0)]">Latency by node</p>
          {Object.entries(nodeTimings)
            .sort(([, a], [, b]) => b - a)
            .map(([node, duration]) => (
              <div key={node} className="py-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-[var(--color-ink-2)]">{node}</span>
                  <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--color-ink-1)]">
                    {formatDuration(duration)}
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
                  <div
                    className="h-full rounded-full bg-[var(--color-brand)]"
                    style={{
                      width: `${slowestNode ? (duration / slowestNode[1]) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
        </div>
      )}

      {trace.traceId && (
        <div className="panel-muted px-3 py-2.5">
          <p className="mb-1.5 text-xs font-medium text-[var(--color-ink-0)]">Langfuse trace</p>
          <p className="break-all font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-ink-3)]">
            {trace.traceId}
          </p>
          {trace.traceUrl && (
            <a
              href={trace.traceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-brand)] hover:underline"
            >
              Open execution tree
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Badge tone={trace.tracingEnabled ? 'success' : 'warning'}>
          {trace.tracingEnabled ? 'tracing on' : 'tracing off'}
        </Badge>
      </div>
    </div>
  );
}
