'use client';

import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { deleteDocument, previewChunks, reindexDocument, type ChunkPreview } from '@/app/actions/documents';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DocumentRecord, DocumentStatus } from '@/lib/types';
import { cn, formatBytes } from '@/lib/utils';

/**
 * Corpus manager: ingestion status, chunk statistics and a chunk preview.
 *
 * The preview is the most useful diagnostic on this page. Bad retrieval is
 * usually bad chunking, and bad chunking is instantly visible once you read
 * three parent chunks — headings orphaned from their sections, tables shredded
 * mid-row, a 40-character fragment sitting alone.
 */

const STATUS_CONFIG: Record<
  DocumentStatus,
  { tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger'; icon: typeof Clock; label: string }
> = {
  pending: { tone: 'neutral', icon: Clock, label: 'queued' },
  processing: { tone: 'brand', icon: Loader2, label: 'indexing' },
  ready: { tone: 'success', icon: CheckCircle2, label: 'ready' },
  failed: { tone: 'danger', icon: AlertCircle, label: 'failed' },
};

export function DocumentList({ documents }: { documents: DocumentRecord[] }): React.JSX.Element {
  const router = useRouter();

  // Ingestion is asynchronous, so poll while anything is still in flight.
  const hasPendingWork = documents.some(
    (document) => document.status === 'pending' || document.status === 'processing',
  );

  React.useEffect(() => {
    if (!hasPendingWork) return;
    const interval = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(interval);
  }, [hasPendingWork, router]);

  if (documents.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-xs text-[var(--color-ink-3)]">
        No documents yet. Upload a policy, standard or regulation to build the corpus.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2 p-3">
      {documents.map((document) => (
        <DocumentRow key={document.id} document={document} />
      ))}
    </ul>
  );
}

function DocumentRow({ document }: { document: DocumentRecord }): React.JSX.Element {
  const router = useRouter();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [preview, setPreview] = React.useState<ChunkPreview[] | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const config = STATUS_CONFIG[document.status];
  const StatusIcon = config.icon;

  const loadPreview = async (): Promise<void> => {
    const next = !isExpanded;
    setIsExpanded(next);
    if (next && preview === null && document.status === 'ready') {
      try {
        setPreview(await previewChunks(document.id));
      } catch {
        setPreview([]);
      }
    }
  };

  return (
    <li className="panel-muted">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={() => void loadPreview()}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-[var(--color-ink-3)] transition-transform',
              isExpanded && 'rotate-90',
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-[var(--color-ink-0)]">
              {document.filename}
            </span>
            <span className="mt-0.5 block text-[10px] text-[var(--color-ink-3)]">
              {formatBytes(document.size_bytes)}
              {document.status === 'ready' &&
                ` · ${document.parent_count} parents · ${document.child_count} children · ${document.char_count.toLocaleString()} chars`}
            </span>
          </span>
        </button>

        <Badge tone={config.tone}>
          <StatusIcon className={cn('size-3', document.status === 'processing' && 'animate-spin')} />
          {config.label}
        </Badge>

        <Button
          variant="ghost"
          size="icon"
          title="Re-index with current chunk settings"
          disabled={isPending || document.status === 'processing'}
          onClick={() =>
            startTransition(async () => {
              await reindexDocument(document.id);
              router.refresh();
            })
          }
        >
          <RefreshCw className="size-3.5" />
        </Button>

        <Button
          variant="danger"
          size="icon"
          title="Delete document and all its chunks"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              await deleteDocument(document.id);
              router.refresh();
            })
          }
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {document.status === 'failed' && document.error_message && (
        <p className="border-t border-[var(--color-surface-3)] px-3 py-2 text-[11px] text-[var(--color-danger)]">
          {document.error_message}
        </p>
      )}

      {isExpanded && (
        <div className="border-t border-[var(--color-surface-3)] px-3 py-2.5">
          {document.status !== 'ready' ? (
            <p className="text-[11px] text-[var(--color-ink-3)]">
              Chunk preview becomes available once indexing finishes.
            </p>
          ) : preview === null ? (
            <p className="flex items-center gap-2 text-[11px] text-[var(--color-ink-3)]">
              <Loader2 className="size-3 animate-spin" /> Loading chunk preview…
            </p>
          ) : preview.length === 0 ? (
            <p className="text-[11px] text-[var(--color-ink-3)]">No chunks found.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[10px] uppercase tracking-wide text-[var(--color-ink-3)]">
                First {preview.length} parent chunks
              </p>
              {preview.map((chunk) => (
                <div
                  key={chunk.ordinal}
                  className="rounded border border-[var(--color-surface-3)] bg-[var(--color-surface-1)] px-2.5 py-2"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[10px] font-medium text-[var(--color-ink-2)]">
                      §{chunk.ordinal + 1}
                    </span>
                    <Badge tone="neutral">{chunk.charCount} chars</Badge>
                    <Badge tone="brand">{chunk.childCount} children</Badge>
                  </div>
                  <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--color-ink-3)]">
                    {chunk.content}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
