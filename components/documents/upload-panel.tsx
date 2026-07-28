'use client';

import { CloudUpload, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { uploadDocument } from '@/app/actions/documents';
import { Button } from '@/components/ui/button';
import { cn, formatBytes } from '@/lib/utils';

/**
 * Multi-file upload with drag-and-drop.
 *
 * Files are uploaded one at a time rather than in parallel: each one runs a
 * synchronous PDF extraction inside a Server Action, and firing ten of those at
 * once is a reliable way to exhaust the server's memory on large documents.
 */

interface UploadState {
  filename: string;
  size: number;
  status: 'uploading' | 'queued' | 'failed';
  error?: string;
}

export function UploadPanel(): React.JSX.Element {
  const router = useRouter();
  const [isDragging, setIsDragging] = React.useState(false);
  const [uploads, setUploads] = React.useState<UploadState[]>([]);
  const [isBusy, setIsBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;

    const list = Array.from(files);
    setIsBusy(true);
    setUploads(
      list.map((file) => ({ filename: file.name, size: file.size, status: 'uploading' as const })),
    );

    for (const [index, file] of list.entries()) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        await uploadDocument(formData);

        setUploads((current) =>
          current.map((upload, i) => (i === index ? { ...upload, status: 'queued' } : upload)),
        );
      } catch (error) {
        setUploads((current) =>
          current.map((upload, i) =>
            i === index
              ? {
                  ...upload,
                  status: 'failed',
                  error: error instanceof Error ? error.message : String(error),
                }
              : upload,
          ),
        );
      }
    }

    setIsBusy(false);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          void handleFiles(event.dataTransfer.files);
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-10 transition-colors',
          isDragging
            ? 'border-[var(--color-brand)] bg-[oklch(0.72_0.16_255_/_0.08)]'
            : 'border-[var(--color-surface-3)] bg-[var(--color-surface-2)]',
        )}
      >
        <span className="flex size-10 items-center justify-center rounded-xl bg-[oklch(0.72_0.16_255_/_0.12)] text-[var(--color-brand)]">
          {isBusy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CloudUpload className="size-4" />
          )}
        </span>

        <div className="text-center">
          <p className="text-sm font-medium text-[var(--color-ink-0)]">
            Drop PDF, Markdown or text files
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-3)]">
            Extraction runs immediately; chunking and embedding are queued to a background worker.
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.md,.markdown,.txt,application/pdf,text/plain,text/markdown"
          className="hidden"
          onChange={(event) => {
            void handleFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={isBusy}>
          Choose files
        </Button>
      </div>

      {uploads.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {uploads.map((upload, index) => (
            <li
              key={`${upload.filename}-${index}`}
              className="panel-muted flex items-center gap-2 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-ink-1)]">
                {upload.filename}
              </span>
              <span className="shrink-0 text-[10px] text-[var(--color-ink-3)]">
                {formatBytes(upload.size)}
              </span>
              <span
                className={cn(
                  'shrink-0 text-[10px] font-medium',
                  upload.status === 'queued' && 'text-[var(--color-success)]',
                  upload.status === 'uploading' && 'text-[var(--color-ink-3)]',
                  upload.status === 'failed' && 'text-[var(--color-danger)]',
                )}
                title={upload.error}
              >
                {upload.status === 'queued'
                  ? 'queued for indexing'
                  : upload.status === 'uploading'
                    ? 'extracting…'
                    : (upload.error ?? 'failed')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
