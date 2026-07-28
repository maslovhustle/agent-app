import * as React from 'react';

import { listDocuments } from '@/app/actions/documents';
import { ResearchWorkspace } from '@/components/chat/research-workspace';
import type { DocumentRecord } from '@/lib/types';

/**
 * The research console.
 *
 * Server Component: the document list is fetched on the server and handed to
 * the client workspace as props, so the corpus filter is populated on first
 * paint with no loading flash and no client-side fetch waterfall.
 */
export const dynamic = 'force-dynamic';

export default async function ResearchPage(): Promise<React.JSX.Element> {
  let documents: DocumentRecord[] = [];
  let loadError: string | null = null;

  try {
    documents = await listDocuments();
  } catch (error) {
    // A missing Supabase config should not white-screen the console — the chat
    // is still useful, and the error belongs on screen where it can be fixed.
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <>
      {loadError && (
        <div className="mx-3 mt-3 rounded-lg border border-[oklch(0.68_0.19_25_/_0.35)] bg-[oklch(0.68_0.19_25_/_0.1)] px-3 py-2.5 text-[11px] text-[var(--color-danger)]">
          Could not load documents: {loadError}
        </div>
      )}
      <ResearchWorkspace documents={documents} />
    </>
  );
}
