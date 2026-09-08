import 'server-only';

import { extractText, isSupportedFile, normalizeText } from '@/lib/chunking';
import { inngest } from '@/lib/inngest/client';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { DocumentStatus } from '@/lib/types';

/**
 * The ingestion front door, shared by every caller that can hand us bytes:
 * the upload Server Action and the `ingest_document` MCP tool.
 *
 * It owns the synchronous half of ingestion — validate, extract, persist,
 * enqueue — and deliberately stops there. Chunking and embedding belong to the
 * Inngest worker, which retries them; extraction failures are user-fixable and
 * must surface immediately at the call site instead.
 *
 * Transport concerns stay with the callers: the Server Action revalidates its
 * route, the MCP tool renders a tool result. Neither belongs in here, which is
 * why this module is importable from both.
 */

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Below this, extraction produced something that cannot be meaningfully
 * chunked — an encrypted PDF that yielded only whitespace, or a stub file.
 * Catching it here turns a mystifying empty-corpus bug into a clear rejection.
 */
const MIN_EXTRACTED_CHARS = 50;

export interface DocumentSourceInput {
  filename: string;
  /** May be empty — `extractText` falls back to the filename extension. */
  mimeType: string;
  bytes: ArrayBuffer;
}

export interface IngestedDocument {
  documentId: string;
  filename: string;
  status: DocumentStatus;
  /** Characters of extracted text handed to the chunker. */
  charCount: number;
  pageCount?: number;
}

/**
 * Validates a file, extracts its text, and queues it for chunking.
 *
 * Throws with a message the end user can act on. Once the `documents` row
 * exists, any later failure is also written back to that row before the throw
 * propagates, so a failed ingestion is visible in the documents panel rather
 * than only in a caller's stack trace.
 */
export async function ingestDocumentSource(
  input: DocumentSourceInput,
): Promise<IngestedDocument> {
  const { filename, mimeType, bytes } = input;

  assertIngestable({ filename, mimeType, byteLength: bytes.byteLength });

  const supabase = getSupabaseAdmin();

  const { data: document, error: insertError } = await supabase
    .from('documents')
    .insert({
      filename,
      mime_type: mimeType || 'application/octet-stream',
      size_bytes: bytes.byteLength,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError || !document) {
    throw new Error(
      `Could not create document record: ${insertError?.message ?? 'unknown error'}`,
    );
  }

  const documentId = document.id as string;

  try {
    const { text, pageCount } = await extractText(bytes, mimeType, filename);
    const normalized = normalizeText(text);

    if (normalized.length < MIN_EXTRACTED_CHARS) {
      throw new Error(
        `Extracted text is too short to index (under ${MIN_EXTRACTED_CHARS} characters)`,
      );
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
      data: { documentId, filename },
    });

    return {
      documentId,
      filename,
      status: 'pending',
      charCount: normalized.length,
      ...(pageCount === undefined ? {} : { pageCount }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markDocumentFailed(documentId, message);
    throw new Error(message);
  }
}

/** The user-fixable rejections, checked before anything is written. */
function assertIngestable(params: {
  filename: string;
  mimeType: string;
  byteLength: number;
}): void {
  const { filename, mimeType, byteLength } = params;

  if (byteLength === 0) {
    throw new Error(`${filename} is empty`);
  }

  if (byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `${filename} is ${(byteLength / 1024 / 1024).toFixed(1)} MB — the limit is 20 MB`,
    );
  }

  if (!isSupportedFile(mimeType, filename)) {
    throw new Error(`${filename}: only PDF, Markdown and plain text are supported`);
  }
}

/**
 * Best-effort: the caller is already throwing the real error, so a failure to
 * record it must not mask it.
 */
async function markDocumentFailed(documentId: string, message: string): Promise<void> {
  try {
    await getSupabaseAdmin()
      .from('documents')
      .update({ status: 'failed', error_message: message.slice(0, 1000) })
      .eq('id', documentId);
  } catch (error) {
    console.error('[ingest] could not mark document failed', error);
  }
}
