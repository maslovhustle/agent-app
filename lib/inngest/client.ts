import { EventSchemas, Inngest } from 'inngest';

/**
 * Inngest client and event catalogue.
 *
 * Ingestion is queued rather than done inline because chunking + embedding a
 * real regulation runs for minutes and makes thousands of API calls — well
 * past any serverless request budget. Inngest gives us durable steps, retries
 * with backoff, and a replayable history of every failed ingestion.
 */

type IngestionEvents = {
  'document/uploaded': {
    data: {
      documentId: string;
      filename: string;
    };
  };
  'document/reindex': {
    data: {
      documentId: string;
      /** Optional hyperparameter overrides, used by the RAG tuner agent. */
      overrides?: {
        parentChunkSize?: number;
        parentChunkOverlap?: number;
        childChunkSize?: number;
        childChunkOverlap?: number;
      };
    };
  };
};

export const inngest = new Inngest({
  id: 'compliance-research-agent',
  schemas: new EventSchemas().fromRecord<IngestionEvents>(),
});

export type { IngestionEvents };
