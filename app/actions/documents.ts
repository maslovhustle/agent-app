'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { extractText, isSupportedFile, normalizeText } from '@/lib/chunking';
import { inngest } from '@/lib/inngest/client';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { DocumentRecord, UploadResult } from '@/lib/types';

/**
 * Server Actions for the document panel.
 *
 * Text extraction happens here, synchronously, while chunking and embedding
 * are queued. That split is deliberate: extraction is fast and its failures
 * (encrypted PDF, scanned image, wrong file type) are things the user must see
 * immediately and can fix by uploading a different file. Embedding failures
 * are transient infrastructure problems that belong to a retrying worker.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function uploadDocument(formData: FormData): Promise<UploadResult> {
  const file = formData.get('file');

  if (!(file instanceof File)) {
    throw new Error('No file provided');
  }

  if (file.size === 0) {
    throw new Error(`${file.name} is empty`);
  }

  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 20 MB`,
    );
  }

  if (!isSupportedFile(file.type, file.name)) {
    throw new Error(`${file.name}: only PDF, Markdown and plain text are supported`);
  }

  const supabase = getSupabaseAdmin();

  const { data: document, error: insertError } = await supabase
    .from('documents')
    .insert({
      filename: file.name,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError || !document) {
    throw new Error(`Could not create document record: ${insertError?.message ?? 'unknown error'}`);
  }

  const documentId = document.id as string;

  try {
    const buffer = await file.arrayBuffer();
    const { text, pageCount } = await extractText(buffer, file.type, file.name);
    const normalized = normalizeText(text);

    if (normalized.length < 50) {
      throw new Error('Extracted text is too short to index (under 50 characters)');
    }

    const { error: sourceError } = await supabase
      .from('document_sources')
      .insert({ document_id: documentId, content: normalized });

    if (sourceError) {
      throw new Error(`Could not store extracted text: ${sourceError.message}`);
    }

    await supabase
      .from('documents')
      .update({
        char_count: normalized.length,
        metadata: pageCount ? { pageCount } : {},
      })
      .eq('id', documentId);

    // Hand off to the durable worker.
    await inngest.send({
      name: 'document/uploaded',
      data: { documentId, filename: file.name },
    });

    revalidatePath('/documents');

    return { documentId, filename: file.name, status: 'pending' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from('documents')
      .update({ status: 'failed', error_message: message.slice(0, 1000) })
      .eq('id', documentId);
    revalidatePath('/documents');
    throw new Error(message);
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
