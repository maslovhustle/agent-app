'use client';

import {
  AlertTriangle,
  Check,
  CircleDot,
  Globe,
  ListTree,
  Loader2,
  PenLine,
  Search,
  ShieldCheck,
} from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { StatRow } from '@/components/ui/panel';
import type { AgentEvent, AgentNodeName } from '@/lib/types';
import { cn, formatDuration } from '@/lib/utils';

/**
 * The live agent trace.
 *
 * This is the panel that makes an agent debuggable instead of magical: which
 * node is running, what plan it produced, what each retrieval actually
 * returned, and how the fusion/rerank funnel narrowed 20 candidates to 4.
 * It fills in while the answer is still streaming.
 */

const NODE_META: Record<AgentNodeName, { label: string; icon: typeof Search }> = {
  planner: { label: 'Planner', icon: ListTree },
  retriever: { label: 'Retriever', icon: Search },
  web_search: { label: 'Web Search', icon: Globe },
  synthesizer: { label: 'Synthesizer', icon: PenLine },
  verifier: { label: 'Verifier', icon: ShieldCheck },
};

interface AgentInspectorProps {
  events: AgentEvent[];
  isStreaming: boolean;
}

export function AgentInspector({
  events,
  isStreaming,
}: AgentInspectorProps): React.JSX.Element {
  if (events.length === 0) {
    return (
      <p className="px-4 py-6 text-xs text-[var(--color-ink-3)]">
        The agent&apos;s execution trace appears here — plan, retrievals, fusion statistics and
        the grounding check.
      </p>
    );
  }

  const nodeRuns = collectNodeRuns(events);

  return (
    <div className="flex flex-col gap-2 p-3">
      {nodeRuns.map((run, index) => (
        <NodeRunCard
          key={`${run.node}-${index}`}
          run={run}
          isActive={run.durationMs === null && isStreaming}
        />
      ))}
    </div>
  );
}

interface NodeRun {
  node: AgentNodeName;
  label: string;
  durationMs: number | null;
  events: AgentEvent[];
}

/**
 * Folds the flat event stream into per-node runs. The retriever appears once
 * per plan step, which is exactly how a multi-step investigation should read.
 */
function collectNodeRuns(events: readonly AgentEvent[]): NodeRun[] {
  const runs: NodeRun[] = [];

  for (const event of events) {
    if (event.kind === 'node_start') {
      runs.push({ node: event.node, label: event.label, durationMs: null, events: [] });
      continue;
    }

    if (event.kind === 'node_end') {
      // Close the most recent open run for this node.
      for (let index = runs.length - 1; index >= 0; index--) {
        const run = runs[index];
        if (run && run.node === event.node && run.durationMs === null) {
          run.durationMs = event.durationMs;
          break;
        }
      }
      continue;
    }

    runs[runs.length - 1]?.events.push(event);
  }

  return runs;
}

function NodeRunCard({ run, isActive }: { run: NodeRun; isActive: boolean }): React.JSX.Element {
  const meta = NODE_META[run.node];
  const Icon = meta.icon;

  return (
    <div
      className={cn(
        'panel-muted px-3 py-2.5',
        isActive && 'border-[var(--color-brand)] bg-[oklch(0.72_0.16_255_/_0.06)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded',
            isActive
              ? 'bg-[oklch(0.72_0.16_255_/_0.18)] text-[var(--color-brand)]'
              : 'bg-[var(--color-surface-3)] text-[var(--color-ink-2)]',
          )}
        >
          <Icon className="size-3" />
        </span>

        <span className="flex-1 text-xs font-medium text-[var(--color-ink-0)]">{meta.label}</span>

        {run.durationMs === null ? (
          isActive ? (
            <Loader2 className="size-3 animate-spin text-[var(--color-brand)]" />
          ) : (
            <CircleDot className="size-3 text-[var(--color-ink-3)]" />
          )
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-ink-3)]">
            <Check className="size-3 text-[var(--color-success)]" />
            {formatDuration(run.durationMs)}
          </span>
        )}
      </div>

      <p className="mt-1 pl-7 text-[11px] text-[var(--color-ink-3)]">{run.label}</p>

      {run.events.length > 0 && (
        <div className="mt-2 flex flex-col gap-2 pl-7">
          {run.events.map((event, index) => (
            <EventDetail key={index} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventDetail({ event }: { event: AgentEvent }): React.JSX.Element | null {
  switch (event.kind) {
    case 'plan':
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Badge tone={event.plan.isSimple ? 'neutral' : 'brand'}>
              {event.plan.isSimple ? 'simple lookup' : 'investigative'}
            </Badge>
            <span className="text-[10px] text-[var(--color-ink-3)]">
              {event.plan.steps.length} step{event.plan.steps.length === 1 ? '' : 's'}
            </span>
          </div>
          <ol className="flex flex-col gap-1">
            {event.plan.steps.map((step, index) => (
              <li key={step.id} className="text-[11px] text-[var(--color-ink-2)]">
                <span className="text-[var(--color-ink-3)]">{index + 1}.</span> {step.query}
                <span className="mt-0.5 block text-[10px] italic text-[var(--color-ink-3)]">
                  {step.rationale}
                </span>
              </li>
            ))}
          </ol>
        </div>
      );

    case 'retrieval':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-ink-2)]">
            &ldquo;{event.query}&rdquo;
          </p>
          <div className="rounded border border-[var(--color-surface-3)] bg-[var(--color-surface-1)] px-2 py-1.5">
            <StatRow label="Dense hits (pgvector)" value={event.stats.denseHits} mono />
            <StatRow label="Sparse hits (BM25)" value={event.stats.sparseHits} mono />
            <StatRow label="After RRF + dedupe" value={event.stats.fusedCandidates} mono />
            <StatRow
              label="Cohere rerank"
              value={
                event.stats.rerankApplied ? (
                  <span className="text-[var(--color-success)]">applied</span>
                ) : (
                  <span className="text-[var(--color-warning)]">skipped</span>
                )
              }
            />
            {event.stats.droppedBelowThreshold > 0 && (
              <StatRow
                label="Dropped below threshold"
                value={event.stats.droppedBelowThreshold}
                mono
              />
            )}
            <StatRow label="Selected contexts" value={event.contexts.length} mono />
            <StatRow label="Retrieval latency" value={formatDuration(event.stats.durationMs)} mono />
          </div>
        </div>
      );

    case 'web_search':
      return (
        <div className="flex flex-col gap-1">
          {event.results.every((result) => result.isMock) ? (
            <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-warning)]">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              No search provider configured — no external evidence retrieved.
            </p>
          ) : (
            event.results.map((result, index) => (
              <p key={index} className="truncate text-[11px] text-[var(--color-ink-2)]">
                {result.title}
              </p>
            ))
          )}
        </div>
      );

    case 'verification':
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Badge
              tone={
                event.verification.status === 'grounded'
                  ? 'success'
                  : event.verification.status === 'partially_grounded'
                    ? 'warning'
                    : 'danger'
              }
            >
              {event.verification.status.replace('_', ' ')}
            </Badge>
            <span className="text-[10px] text-[var(--color-ink-3)]">
              confidence {Math.round(event.verification.confidence * 100)}%
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--color-ink-3)]">
            {event.verification.reasoning}
          </p>
          {event.verification.unsupportedClaims.length > 0 && (
            <ul className="flex flex-col gap-1 border-l-2 border-[var(--color-danger)] pl-2">
              {event.verification.unsupportedClaims.map((claim, index) => (
                <li key={index} className="text-[10px] text-[var(--color-danger)]">
                  {claim}
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case 'error':
      return (
        <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {event.message}
        </p>
      );

    default:
      return null;
  }
}
