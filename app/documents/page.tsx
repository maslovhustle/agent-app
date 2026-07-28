import { FileText, Layers } from 'lucide-react';
import * as React from 'react';

import { listDocuments } from '@/app/actions/documents';
import { DocumentList } from '@/components/documents/document-list';
import { UploadPanel } from '@/components/documents/upload-panel';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import type { DocumentRecord } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function DocumentsPage(): Promise<React.JSX.Element> {
  let documents: DocumentRecord[] = [];
  let loadError: string | null = null;

  try {
    documents = await listDocuments();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  const ready = documents.filter((document) => document.status === 'ready');
  const totalChildren = ready.reduce((sum, document) => sum + document.child_count, 0);
  const totalParents = ready.reduce((sum, document) => sum + document.parent_count, 0);

  return (
    <div className="grid h-full grid-cols-1 gap-3 p-3 lg:grid-cols-[400px_minmax(0,1fr)]">
      <Panel>
        <PanelHeader>
          <PanelTitle>
            <Layers className="size-3.5 text-[var(--color-brand)]" />
            Ingest
          </PanelTitle>
        </PanelHeader>

        <PanelBody className="p-3">
          <UploadPanel />

          <div className="panel-muted mt-3 px-3 py-2.5">
            <p className="mb-2 text-xs font-medium text-[var(--color-ink-0)]">Corpus</p>
            <dl className="flex flex-col gap-1">
              <div className="flex justify-between text-xs">
                <dt className="text-[var(--color-ink-3)]">Indexed documents</dt>
                <dd className="font-[family-name:var(--font-mono)] text-[var(--color-ink-1)]">
                  {ready.length}
                </dd>
              </div>
              <div className="flex justify-between text-xs">
                <dt className="text-[var(--color-ink-3)]">Parent contexts</dt>
                <dd className="font-[family-name:var(--font-mono)] text-[var(--color-ink-1)]">
                  {totalParents.toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between text-xs">
                <dt className="text-[var(--color-ink-3)]">Embedded children</dt>
                <dd className="font-[family-name:var(--font-mono)] text-[var(--color-ink-1)]">
                  {totalChildren.toLocaleString()}
                </dd>
              </div>
            </dl>
          </div>

          <p className="mt-3 px-1 text-[11px] leading-relaxed text-[var(--color-ink-3)]">
            Each document is split into ~1500-character parent contexts and ~300-character child
            chunks. Children are embedded and searched; parents are what the model reads.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>
            <FileText className="size-3.5 text-[var(--color-brand)]" />
            Documents
          </PanelTitle>
          <span className="text-[11px] text-[var(--color-ink-3)]">
            {documents.length} total · {ready.length} ready
          </span>
        </PanelHeader>

        <PanelBody>
          {loadError ? (
            <p className="m-3 rounded-lg border border-[oklch(0.68_0.19_25_/_0.35)] bg-[oklch(0.68_0.19_25_/_0.1)] px-3 py-2.5 text-[11px] text-[var(--color-danger)]">
              Could not load documents: {loadError}
            </p>
          ) : (
            <DocumentList documents={documents} />
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
