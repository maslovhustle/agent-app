import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { createResearchGraph } from '@/lib/ai/agent';
import { hybridSearch } from '@/lib/ai/retrieval';
import { ingestDocumentSource } from '@/lib/documents/ingest';
import { getRagConfig } from '@/lib/env';
import type { Verification } from '@/lib/types';

import { deriveRerankApplied, renderAnswer, renderPassages, toPassage } from './format';
import { createHeadlessRuntime } from './runtime';

/**
 * The three tools this server exposes.
 *
 * `search_documents` is the thin one — `hybridSearch` already has a tool-shaped
 * signature. `ask_with_citations` is the one worth having: it runs the whole
 * graph, so what comes back has been through an adversarial grounding check and
 * carries the verdict. A client agent calling a typical RAG server gets prose
 * and has to decide for itself whether to believe it; here the answer arrives
 * pre-labelled, and an ungrounded one arrives as a refusal instead of prose.
 */

const passageShape = {
  citation: z.number().int().describe('The [n] marker this passage is cited as.'),
  documentId: z.string(),
  parentId: z.string(),
  filename: z.string(),
  section: z.number().int().describe('1-indexed parent-chunk ordinal within the document.'),
  score: z.number(),
  scoreKind: z
    .enum(['rerank', 'rrf'])
    .describe(
      'Which scale `score` is on. "rerank" is cross-encoder relevance in [0,1] and is ' +
        'comparable across queries; "rrf" is a fusion rank score and is not.',
    ),
  content: z.string(),
};

const statsShape = {
  denseHits: z.number().int(),
  sparseHits: z.number().int(),
  fusedCandidates: z.number().int(),
  rerankApplied: z.boolean(),
  droppedBelowThreshold: z.number().int(),
  durationMs: z.number(),
};

export function registerTools(server: McpServer): void {
  registerSearchDocuments(server);
  registerAskWithCitations(server);
  registerIngestDocument(server);
}

// ---------------------------------------------------------------------------
// search_documents
// ---------------------------------------------------------------------------

function registerSearchDocuments(server: McpServer): void {
  server.registerTool(
    'search_documents',
    {
      title: 'Search the compliance corpus',
      description:
        'Hybrid retrieval over the private corpus: dense pgvector search and sparse ' +
        'tsvector search run concurrently, fuse via Reciprocal Rank Fusion, dedupe to one ' +
        'candidate per parent, and are reranked by a Cohere cross-encoder. Returns the ' +
        'winning passages with ranking telemetry. This is raw evidence with no answer ' +
        'synthesis and no grounding check — use ask_with_citations when you want a ' +
        'verified answer rather than passages to reason over yourself.',
      inputSchema: {
        query: z.string().min(1).describe('Natural-language search query.'),
        topK: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('How many passages to return. Defaults to the server RERANK_TOP_N.'),
        documentIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Restrict the search to these documents. Omit to search the whole corpus.'),
      },
      outputSchema: {
        passages: z.array(z.object(passageShape)),
        stats: z.object(statsShape),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, topK, documentIds }) => {
      const config = getRagConfig();
      const limit = topK ?? config.rerankTopN;

      const { contexts, stats } = await hybridSearch(query, {
        documentIds,
        overrides: {
          rerankTopN: limit,
          // The reranker can only rank what fusion handed it, and
          // dedupe-by-parent shrinks that pool further. Widening the candidate
          // set keeps a large topK from quietly returning fewer passages than
          // were asked for.
          candidates: Math.max(config.candidates, limit * 3),
        },
      });

      const passages = contexts.map((context) => toPassage(context, stats.rerankApplied));

      return {
        content: [{ type: 'text' as const, text: renderPassages(passages, stats) }],
        structuredContent: { passages, stats },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// ask_with_citations
// ---------------------------------------------------------------------------

function registerAskWithCitations(server: McpServer): void {
  server.registerTool(
    'ask_with_citations',
    {
      title: 'Ask the compliance agent (verified answer)',
      description:
        'Runs the full research agent: plan → retrieve (once per plan step) → optional web ' +
        'search when local evidence is thin → synthesize a cited answer → verify every claim ' +
        'against the retrieved passages. Returns the answer, its citations, and a grounding ' +
        'verdict of grounded | partially_grounded | unsupported with a confidence score. ' +
        'When the verdict is "unsupported" the agent DECLINES to answer: `answer` is null and ' +
        'the ungrounded draft is returned separately as `withheldDraft` so it cannot be ' +
        'mistaken for a supported result. Prefer this over search_documents whenever you ' +
        'intend to act on or repeat what comes back.',
      inputSchema: {
        question: z.string().min(1).describe('The compliance question to research.'),
        documentIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Restrict retrieval to these documents. Omit to use the whole corpus.'),
      },
      outputSchema: {
        verdict: z.object({
          status: z.enum(['grounded', 'partially_grounded', 'unsupported']),
          confidence: z.number(),
          unsupportedClaims: z.array(z.string()),
          reasoning: z.string(),
        }),
        answer: z
          .string()
          .nullable()
          .describe('Null when the verdict is "unsupported" — the agent refused to answer.'),
        withheldDraft: z
          .string()
          .nullable()
          .describe('The ungrounded draft, present only when the agent refused. Do not repeat it.'),
        citations: z.array(z.object(passageShape)),
        plan: z
          .object({
            isSimple: z.boolean(),
            steps: z.array(
              z.object({ id: z.string(), query: z.string(), rationale: z.string() }),
            ),
          })
          .nullable(),
        webSearch: z.object({
          used: z.boolean(),
          isMock: z.boolean().describe('True when TAVILY_API_KEY is unset and results are mocked.'),
          results: z.array(
            z.object({ title: z.string(), url: z.string(), snippet: z.string() }),
          ),
        }),
        retrieval: z.object({
          rerankApplied: z.boolean(),
          steps: z.array(z.object(statsShape)),
        }),
        trace: z.object({
          traceId: z.string().nullable(),
          traceUrl: z.string().nullable(),
          tracingEnabled: z.boolean(),
          latencyMs: z.number(),
          promptTokens: z.number(),
          outputTokens: z.number(),
          totalCostUsd: z.number(),
          model: z.string(),
        }),
        nodeTimings: z.array(z.object({ node: z.string(), durationMs: z.number() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ question, documentIds }) => {
      const headless = createHeadlessRuntime({ question, documentIds });
      const graph = createResearchGraph(headless.runtime);

      let state;
      try {
        state = await graph.invoke(
          { question, conversationContext: '', documentIds },
          // One retriever visit per plan step; the ceiling bounds a
          // pathological planner rather than a normal 4-step plan.
          { recursionLimit: 24 },
        );
      } catch (error) {
        await headless.trace.end({
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const verdict: Verification = state.verification ?? {
        status: 'unsupported',
        confidence: 0,
        unsupportedClaims: [],
        reasoning: 'The verifier did not run, so nothing in this answer has been checked.',
      };

      const refused = verdict.status === 'unsupported';

      const rerankApplied = deriveRerankApplied(state.retrievalStats);
      const citations = state.contexts.map((context) => toPassage(context, rerankApplied));

      const structuredContent = {
        verdict,
        answer: refused ? null : state.answer,
        withheldDraft: refused ? state.answer : null,
        citations,
        plan: state.plan,
        webSearch: {
          used: state.webResults.length > 0,
          isMock: state.webResults.some((result) => result.isMock),
          results: state.webResults.map(({ title, url, snippet }) => ({ title, url, snippet })),
        },
        retrieval: { rerankApplied, steps: state.retrievalStats },
        trace: headless.trace.summary(),
        nodeTimings: headless.nodeTimings(),
      };

      await headless.trace.end({ answer: state.answer, verification: verdict });

      return {
        content: [
          { type: 'text' as const, text: renderAnswer(structuredContent, citations) },
        ],
        structuredContent,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// ingest_document
// ---------------------------------------------------------------------------

function registerIngestDocument(server: McpServer): void {
  server.registerTool(
    'ingest_document',
    {
      title: 'Add a document to the corpus',
      description:
        'Extracts text from a PDF, Markdown or plain-text file, stores it, and queues ' +
        'parent-child chunking and embedding on the Inngest worker. Returns immediately with ' +
        'a document id: indexing is asynchronous, and the document is not searchable until ' +
        'its status reaches "ready". Read the compliance://document/{id} resource to check. ' +
        'Supply exactly one of `path` (a file on this machine) or `content` (inline text).',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Path to a local file, absolute or relative to the server working directory.'),
        content: z.string().optional().describe('Inline document text. Requires `filename`.'),
        filename: z
          .string()
          .optional()
          .describe('Name to store the document under. Required with `content`.'),
      },
      outputSchema: {
        documentId: z.string(),
        filename: z.string(),
        status: z.string(),
        charCount: z.number().int(),
        pageCount: z.number().int().nullable(),
        resourceUri: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ path: filePath, content, filename }) => {
      const source = await resolveSource({ filePath, content, filename });
      const result = await ingestDocumentSource(source);
      const resourceUri = `compliance://document/${result.documentId}`;

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Queued "${result.filename}" for indexing (${result.charCount.toLocaleString()} ` +
              `characters of extracted text).\n\n` +
              `document id: ${result.documentId}\n` +
              `status: ${result.status} — chunking and embedding run on the background ` +
              `worker, so the document is not searchable yet.\n` +
              `Read ${resourceUri} to check whether it has reached "ready".`,
          },
        ],
        structuredContent: {
          documentId: result.documentId,
          filename: result.filename,
          status: result.status,
          charCount: result.charCount,
          pageCount: result.pageCount ?? null,
          resourceUri,
        },
      };
    },
  );
}

async function resolveSource(input: {
  filePath?: string;
  content?: string;
  filename?: string;
}): Promise<{ filename: string; mimeType: string; bytes: ArrayBuffer }> {
  const { filePath, content, filename } = input;

  if ((filePath === undefined) === (content === undefined)) {
    throw new Error('Supply exactly one of `path` or `content`.');
  }

  if (filePath !== undefined) {
    const resolved = path.resolve(filePath);
    const buffer = await readFile(resolved);
    return {
      filename: filename ?? path.basename(resolved),
      // Left empty on purpose: `extractText` classifies by extension, which is
      // more reliable than any MIME type we could guess from a bare path.
      mimeType: '',
      bytes: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer,
    };
  }

  if (!filename) {
    throw new Error('`filename` is required when passing inline `content`.');
  }

  return {
    filename,
    mimeType: 'text/plain',
    bytes: new TextEncoder().encode(content).buffer as ArrayBuffer,
  };
}
