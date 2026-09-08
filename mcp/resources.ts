import {
  ResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/sdk/server/mcp.js';

import { getCapabilities, getRagConfig } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { DocumentStatus } from '@/lib/types';

import { truncate } from './format';

/**
 * The corpus, exposed as resources rather than tools.
 *
 * The distinction is the one MCP draws: a tool is a decision the model makes,
 * a resource is context the client can attach. Listing documents and reading
 * one are not decisions — they are the client's own bookkeeping, and modelling
 * them as tools would burn a round trip of model reasoning on each.
 *
 * `compliance://config` is here for a subtler reason. Retrieval degrades
 * silently by design: without a Cohere key the pipeline still answers, but
 * scores stop being calibrated relevance. A client that can read the live
 * config knows how much to trust the numbers it gets back.
 */

/** Documents can be book-length; a resource read is not the place to ship one. */
const MAX_DOCUMENT_CHARS = 100_000;

interface DocumentRow {
  id: string;
  filename: string;
  status: DocumentStatus;
  parent_count: number;
  child_count: number;
  char_count: number;
  error_message: string | null;
  created_at: string;
}

const DOCUMENT_COLUMNS =
  'id, filename, status, parent_count, child_count, char_count, error_message, created_at';

export function registerResources(server: McpServer): void {
  registerCorpusIndex(server);
  registerConfig(server);
  registerDocuments(server);
}

function registerCorpusIndex(server: McpServer): void {
  server.registerResource(
    'corpus',
    'compliance://corpus',
    {
      title: 'Corpus index',
      description:
        'Every document in the knowledge base with its indexing status and chunk counts. ' +
        'Only documents with status "ready" are searchable.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const documents = await listDocumentRows();

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                documentCount: documents.length,
                readyCount: documents.filter((document) => document.status === 'ready').length,
                documents: documents.map((document) => ({
                  uri: `compliance://document/${document.id}`,
                  documentId: document.id,
                  filename: document.filename,
                  status: document.status,
                  parentChunks: document.parent_count,
                  childChunks: document.child_count,
                  charCount: document.char_count,
                  errorMessage: document.error_message,
                  createdAt: document.created_at,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

function registerConfig(server: McpServer): void {
  server.registerResource(
    'config',
    'compliance://config',
    {
      title: 'Live retrieval configuration',
      description:
        'The retrieval hyperparameters and optional dependencies this server is actually ' +
        'running with. Read it to know whether reranking is active — when it is not, ' +
        'passage scores are fusion ranks rather than calibrated relevance.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            { retrieval: getRagConfig(), capabilities: getCapabilities() },
            null,
            2,
          ),
        },
      ],
    }),
  );
}

function registerDocuments(server: McpServer): void {
  server.registerResource(
    'document',
    new ResourceTemplate('compliance://document/{documentId}', {
      list: async () => {
        // `resources/list` enumerates every registered resource in one
        // response, so throwing here would hide the static ones too. A client
        // that cannot see `compliance://config` cannot even discover that
        // retrieval is degraded — which is exactly when it needs to.
        const documents = await listDocumentRows().catch((error: unknown) => {
          console.error('[mcp] could not enumerate the corpus, listing none', error);
          return [];
        });

        return {
          resources: documents.map((document) => ({
            uri: `compliance://document/${document.id}`,
            name: document.filename,
            description:
              `${document.status} · ${document.parent_count} parent chunks · ` +
              `${document.char_count.toLocaleString()} characters`,
            mimeType: 'text/plain',
          })),
        };
      },
    }),
    {
      title: 'Document source text',
      description: 'The extracted text of one document, as it was handed to the chunker.',
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      const documentId = Array.isArray(variables.documentId)
        ? variables.documentId[0]
        : variables.documentId;

      if (!documentId) {
        throw new Error('No document id in resource URI');
      }

      const supabase = getSupabaseAdmin();

      const { data: document, error: documentError } = await supabase
        .from('documents')
        .select(DOCUMENT_COLUMNS)
        .eq('id', documentId)
        .single();

      if (documentError || !document) {
        throw new Error(
          `No document ${documentId}: ${documentError?.message ?? 'not found'}`,
        );
      }

      const row = document as DocumentRow;

      const { data: source } = await supabase
        .from('document_sources')
        .select('content')
        .eq('document_id', documentId)
        .single();

      // A document still being chunked, or one that failed extraction, has no
      // source row. Returning its status beats returning an opaque error.
      const body =
        typeof source?.content === 'string'
          ? truncate(source.content, MAX_DOCUMENT_CHARS)
          : `(no extracted text — document status is "${row.status}"` +
            `${row.error_message ? `: ${row.error_message}` : ''})`;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/plain',
            text:
              `# ${row.filename}\n` +
              `status: ${row.status} · ${row.parent_count} parent chunks · ` +
              `${row.child_count} child chunks\n\n${body}`,
          },
        ],
      };
    },
  );
}

async function listDocumentRows(): Promise<DocumentRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('documents')
    .select(DOCUMENT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    throw new Error(`Could not list the corpus: ${error.message}`);
  }

  return (data ?? []) as DocumentRow[];
}
