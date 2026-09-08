'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ingestDocumentSource } from '@/lib/documents/ingest';
import { inngest } from '@/lib/inngest/client';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { DocumentRecord, UploadResult } from '@/lib/types';

/**
 * Server Actions for the document panel.
 *
 * Ingestion itself lives in `lib/documents/ingest`, because the MCP server
 * enqueues documents through the same path and neither caller should own it.
 * What stays here is the part that is genuinely Next-specific: unwrapping
 * `FormData` and revalidating the route.
 */

export async function uploadDocument(formData: FormData): Promise<UploadResult> {
  const file = formData.get('file');

  if (!(file instanceof File)) {
    throw new Error('No file provided');
  }

  try {
    const { documentId, filename, status } = await ingestDocumentSource({
      filename: file.name,
      mimeType: file.type,
      bytes: await file.arrayBuffer(),
    });

    return { documentId, filename, status };
  } finally {
    // The panel must re-render either way: a rejected upload leaves a `failed`
    // row behind, which is as much of an update as a queued one.
    revalidatePath('/documents');
  }
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('documents')
    .select(
      'id, filename, mime_type, size_bytes, status, error_message, parent_count, child_count, char_count, metadata, created_at, updated_at',
    )
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`Could not list documents: ${error.message}`);
  }

  return (data ?? []) as DocumentRecord[];
}

const deleteSchema = z.object({ documentId: z.string().uuid() });

export async function deleteDocument(documentId: string): Promise<void> {
  const parsed = deleteSchema.safeParse({ documentId });
  if (!parsed.success) {
    throw new Error('Invalid document id');
  }

  const supabase = getSupabaseAdmin();

  // Chunks and source text cascade from the FK constraints.
  const { error } = await supabase.from('documents').delete().eq('id', parsed.data.documentId);

  if (error) {
    throw new Error(`Could not delete document: ${error.message}`);
  }

  revalidatePath('/documents');
}

export async function reindexDocument(documentId: string): Promise<void> {
  const parsed = deleteSchema.safeParse({ documentId });
  if (!parsed.success) {
    throw new Error('Invalid document id');
  }

  await inngest.send({
    name: 'document/reindex',
    data: { documentId: parsed.data.documentId },
  });

  revalidatePath('/documents');
}

export interface ChunkPreview {
  ordinal: number;
  content: string;
  charCount: number;
  childCount: number;
}

/** Powers the chunk-preview panel — the fastest way to spot bad chunking. */
export async function previewChunks(documentId: string, limit = 5): Promise<ChunkPreview[]> {
  const parsed = deleteSchema.safeParse({ documentId });
  if (!parsed.success) {
    throw new Error('Invalid document id');
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('parent_chunks')
    .select('id, ordinal, content, char_count')
    .eq('document_id', parsed.data.documentId)
    .order('ordinal', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Could not load chunk preview: ${error.message}`);
  }

  const parents = (data ?? []) as Array<{
    id: string;
    ordinal: number;
    content: string;
    char_count: number;
  }>;

  const counts = await Promise.all(
    parents.map(async (parent) => {
      const { count } = await supabase
        .from('child_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('parent_id', parent.id);
      return count ?? 0;
    }),
  );

  return parents.map((parent, index) => ({
    ordinal: parent.ordinal,
    content: parent.content,
    charCount: parent.char_count,
    childCount: counts[index] ?? 0,
  }));
}
