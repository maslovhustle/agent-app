'use client';

import { ChevronDown, FileText, Globe } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import type { RetrievedContext, WebSearchResult } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The evidence panel: every parent context the synthesizer was given, in the
 * order it was cited, with its rerank and RRF scores exposed.
 *
 * Showing both scores is the point. When a cross-encoder promotes a passage
 * that RRF ranked eighth, that gap is the reranker earning its latency — and
 * when the two disagree wildly, that is a signal to go tune something.
 */

interface SourceListProps {
  contexts: RetrievedContext[];
  webResults: WebSearchResult[];
  highlightedCitation: number | null;
}

export function SourceList({
  contexts,
  webResults,
  highlightedCitation,
}: SourceListProps): React.JSX.Element {
  if (contexts.length === 0 && webResults.length === 0) {
    return (
      <p className="px-4 py-6 text-xs text-[var(--color-ink-3)]">
        No sources yet. Retrieved passages appear here as the agent works.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {contexts.map((context) => (
        <SourceCard
          key={context.parentId}
          context={context}
          isHighlighted={highlightedCitation === context.citationIndex}
        />
      ))}

      {webResults.filter((result) => !result.isMock).length > 0 && (
        <>
          <div className="mt-2 flex items-center gap-2 px-1">
            <Globe className="size-3 text-[var(--color-warning)]" />
            <span className="text-[11px] font-medium text-[var(--color-warning)]">
              External web sources
            </span>
          </div>
          {webResults
            .filter((result) => !result.isMock)
            .map((result, index) => (
              <a
                key={result.url || index}
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="panel-muted block px-3 py-2.5 transition-colors hover:border-[var(--color-warning)]"
              >
                <p className="text-xs font-medium text-[var(--color-ink-0)]">{result.title}</p>
                <p className="mt-1 line-clamp-2 text-[11px] text-[var(--color-ink-3)]">
                  {result.snippet}
                </p>
              </a>
            ))}
        </>
      )}
    </div>
  );
}

function SourceCard({
  context,
  isHighlighted,
}: {
  context: RetrievedContext;
  isHighlighted: boolean;
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (isHighlighted) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setIsExpanded(true);
    }
  }, [isHighlighted]);

  return (
    <div
      ref={ref}
      id={`source-${context.citationIndex}`}
      className={cn(
        'panel-muted transition-colors',
        isHighlighted && 'border-[var(--color-brand)] bg-[oklch(0.72_0.16_255_/_0.08)]',
      )}
    >
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left"
      >
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border border-[oklch(0.72_0.16_255_/_0.4)] bg-[oklch(0.72_0.16_255_/_0.12)] text-[10px] font-semibold text-[var(--color-brand)]">
          {context.citationIndex}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <FileText className="size-3 shrink-0 text-[var(--color-ink-3)]" />
            <span className="truncate text-xs font-medium text-[var(--color-ink-0)]">
              {context.filename}
            </span>
            <span className="shrink-0 text-[10px] text-[var(--color-ink-3)]">
              §{context.ordinal + 1}
            </span>
          </span>

          {!isExpanded && (
            <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-[var(--color-ink-3)]">
              {context.content}
            </span>
          )}
        </span>

        <ChevronDown
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-[var(--color-ink-3)] transition-transform',
            isExpanded && 'rotate-180',
          )}
        />
      </button>

      {isExpanded && (
        <div className="border-t border-[var(--color-surface-3)] px-3 py-2.5">
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--color-ink-2)]">
            {context.content}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Badge tone="brand">rerank {context.rerankScore.toFixed(4)}</Badge>
            <Badge tone="neutral">RRF {context.rrfScore.toFixed(5)}</Badge>
            <Badge tone="neutral">{context.content.length} chars</Badge>
          </div>
        </div>
      )}
    </div>
  );
}
