import { embed, embedMany } from 'ai';

import { EMBEDDING_DIMENSIONS, getEmbeddingModel } from './models';

/**
 * Embedding helpers.
 *
 * `embedMany` batches internally, but the ingestion worker can hand us tens of
 * thousands of child chunks, so we chunk the batches ourselves to keep each
 * request well under the provider's payload limit and to give the worker a
 * natural place to report progress.
 */

const EMBED_BATCH_SIZE = 96;

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value: text,
  });
  return embedding;
}

export interface EmbedBatchOptions {
  onProgress?: (completed: number, total: number) => void;
}

export async function embedDocuments(
  texts: readonly string[],
  options: EmbedBatchOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const vectors: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
    const { embeddings } = await embedMany({
      model: getEmbeddingModel(),
      values: [...batch],
    });
    vectors.push(...embeddings);
    options.onProgress?.(vectors.length, texts.length);
  }

  return vectors;
}

/**
 * Guards against a silent dimension mismatch — the failure mode where someone
 * swaps the embedding model, the insert succeeds because Postgres coerces
 * nothing, and retrieval quality quietly collapses.
 */
export function assertEmbeddingDimensions(vector: readonly number[]): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${vector.length}. ` +
        'The pgvector column is declared vector(1536); changing the embedding model requires a migration.',
    );
  }
}
