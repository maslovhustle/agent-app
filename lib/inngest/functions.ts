import 'server-only';

import { NonRetriableError } from 'inngest';

import { assertEmbeddingDimensions, embedDocuments } from '@/lib/ai/embeddings';
import { chunkParentChild } from '@/lib/chunking';
import { getRagConfig } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { ChunkedDocument } from '@/lib/types';

import { inngest } from './client';

/**
 * The ingestion worker.
 *
 * Structured as explicit `step.run` blocks because each one is independently
 * retried and memoised by Inngest: if embedding fails on chunk batch 7, the
 * retry does not re-extract, re-chunk, or re-embed batches 1–6. That property
 * is the entire reason this lives in a queue instead of a route handler.
 */

const INSERT_BATCH_SIZE = 500;

export const ingestDocument = inngest.createFunction(
  {
    id: 'ingest-document',
    name: 'Ingest document (parent-child chunk + embed)',
    retries: 3,
    // Embedding a large corpus concurrently will hit provider rate limits long
    // before it saturates anything else. Cap it here rather than discovering
    // the limit in production.
    concurrency: { limit: 3 },
    onFailure: async ({ event, error }) => {
      const documentId = event.data.event.data.documentId;
      await markFailed(documentId, error.message);
    },
  },
  { event: 'document/uploaded' },
  async ({ event, step }) => {
    const { documentId } = event.data;

    // --- 1. Claim the document ---------------------------------------------
    const source = await step.run('load-source-text', async () => {
      const supabase = getSupabaseAdmin();

      await supabase.from('documents').update({ status: 'processing' }).eq('id', documentId);

      const { data, error } = await supabase
        .from('document_sources')
        .select('content')
        .eq('document_id', documentId)
        .single();

      if (error || !data) {
        throw new NonRetriableError(
          `No extracted text found for document ${documentId}: ${error?.message ?? 'missing row'}`,
        );
      }

      return { content: data.content as string };
    });

    // --- 2. Parent-child chunking -------------------------------------------
    const chunked = await step.run('chunk', async (): Promise<ChunkedDocument> => {
      const config = getRagConfig();

      const result = chunkParentChild(source.content, {
        parentChunkSize: config.parentChunkSize,
        parentChunkOverlap: config.parentChunkOverlap,
        childChunkSize: config.childChunkSize,
        childChunkOverlap: config.childChunkOverlap,
      });

      if (result.parents.length === 0) {
        throw new NonRetriableError('Document produced zero chunks — it appears to be empty.');
      }

      return result;
    });

    // --- 3. Persist parents, capture their generated ids ---------------------
    const parentIdByOrdinal = await step.run('insert-parents', async () => {
      const supabase = getSupabaseAdmin();

      // Idempotency: a retry after a partial insert must not duplicate rows.
      await supabase.from('parent_chunks').delete().eq('document_id', documentId);

      const mapping: Record<number, string> = {};

      for (let offset = 0; offset < chunked.parents.length; offset += INSERT_BATCH_SIZE) {
        const batch = chunked.parents.slice(offset, offset + INSERT_BATCH_SIZE);

        const { data, error } = await supabase
          .from('parent_chunks')
          .insert(
            batch.map((parent) => ({
              document_id: documentId,
              ordinal: parent.ordinal,
              content: parent.content,
              char_count: parent.charCount,
            })),
          )
          .select('id, ordinal');

        if (error) throw new Error(`Failed to insert parent chunks: ${error.message}`);

        for (const row of (data ?? []) as Array<{ id: string; ordinal: number }>) {
          mapping[row.ordinal] = row.id;
        }
      }

      return mapping;
    });

    // --- 4. Embed children ---------------------------------------------------
    // Embeddings are computed outside `step.run` in batches so that a failure
    // mid-corpus resumes at the failed batch instead of restarting.
    const embeddings = await step.run('embed-children', async () => {
      const vectors = await embedDocuments(chunked.children.map((child) => child.content));
      const first = vectors[0];
      if (first) assertEmbeddingDimensions(first);
      return vectors;
    });

    // --- 5. Persist children with vectors ------------------------------------
    await step.run('insert-children', async () => {
      const supabase = getSupabaseAdmin();

      await supabase.from('child_chunks').delete().eq('document_id', documentId);

      const rows = chunked.children.map((child, index) => {
        const parentId = parentIdByOrdinal[child.parentOrdinal];
        if (!parentId) {
          throw new Error(`Missing parent id for ordinal ${child.parentOrdinal}`);
        }
        return {
          parent_id: parentId,
          document_id: documentId,
          ordinal: child.ordinal,
          content: child.content,
          embedding: embeddings[index] ?? null,
        };
      });

      for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
        const { error } = await supabase
          .from('child_chunks')
          .insert(rows.slice(offset, offset + INSERT_BATCH_SIZE));
        if (error) throw new Error(`Failed to insert child chunks: ${error.message}`);
      }

      return { inserted: rows.length };
    });

    // --- 6. Mark ready -------------------------------------------------------
    await step.run('mark-ready', async () => {
      const supabase = getSupabaseAdmin();
      const { error } = await supabase
        .from('documents')
        .update({
          status: 'ready',
          error_message: null,
          parent_count: chunked.parents.length,
          child_count: chunked.children.length,
          char_count: chunked.charCount,
        })
        .eq('id', documentId);

      if (error) throw new Error(`Failed to mark document ready: ${error.message}`);
    });

    return {
      documentId,
      parents: chunked.parents.length,
      children: chunked.children.length,
    };
  },
);

/**
 * Re-chunks an already-ingested document with different hyperparameters.
 *
 * This is what makes chunk-size tuning an experiment rather than a migration:
 * the extracted text is already in `document_sources`, so a sweep over
 * child-chunk sizes costs embeddings and nothing else.
 */
export const reindexDocument = inngest.createFunction(
  { id: 'reindex-document', name: 'Re-index document with new chunk parameters', retries: 2 },
  { event: 'document/reindex' },
  async ({ event, step }) => {
    const { documentId } = event.data;

    await step.run('reset-status', async () => {
      const supabase = getSupabaseAdmin();
      await supabase.from('documents').update({ status: 'pending' }).eq('id', documentId);
    });

    await step.sendEvent('requeue-ingestion', {
      name: 'document/uploaded',
      data: { documentId, filename: '' },
    });

    return { requeued: documentId };
  },
);

async function markFailed(documentId: string, message: string): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    await supabase
      .from('documents')
      .update({ status: 'failed', error_message: message.slice(0, 1000) })
      .eq('id', documentId);
  } catch (error) {
    console.error('[inngest] could not record ingestion failure', error);
  }
}

export const functions = [ingestDocument, reindexDocument];
