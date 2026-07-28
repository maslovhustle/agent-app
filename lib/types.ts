import { z } from 'zod';

/**
 * Domain types shared by the ingestion pipeline, the retrieval engine, the
 * agent graph and the UI. These are the contracts the whole system is typed
 * against — if a shape changes here, TypeScript walks you through every call
 * site that needs updating.
 */

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const documentStatusSchema = z.enum(['pending', 'processing', 'ready', 'failed']);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'text/markdown',
  'text/plain',
  'text/x-markdown',
] as const;

export const documentRecordSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  status: documentStatusSchema,
  error_message: z.string().nullable(),
  parent_count: z.number(),
  child_count: z.number(),
  char_count: z.number(),
  metadata: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

export type DocumentRecord = z.infer<typeof documentRecordSchema>;

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface ParentChunk {
  /** Position of this parent within its source document. */
  ordinal: number;
  content: string;
  charCount: number;
}

export interface ChildChunk {
  /** Ordinal of the owning parent chunk. */
  parentOrdinal: number;
  /** Position of this child within its parent. */
  ordinal: number;
  content: string;
}

export interface ChunkedDocument {
  parents: ParentChunk[];
  children: ChildChunk[];
  charCount: number;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** A single ranked hit from one retrieval strategy, before fusion. */
export interface RetrievalHit {
  childId: string;
  parentId: string;
  documentId: string;
  content: string;
  /** Strategy-native score: cosine similarity for dense, ts_rank_cd for sparse. */
  score: number;
}

export type RetrievalStrategy = 'dense' | 'sparse';

/** A hit after Reciprocal Rank Fusion, carrying provenance for the inspector. */
export interface FusedHit {
  childId: string;
  parentId: string;
  documentId: string;
  content: string;
  rrfScore: number;
  /** Which strategies surfaced this chunk, and at what rank (1-indexed). */
  ranks: Partial<Record<RetrievalStrategy, number>>;
}

/** A parent context selected for the LLM, after reranking. */
export interface RetrievedContext {
  parentId: string;
  documentId: string;
  filename: string;
  ordinal: number;
  content: string;
  /** Cohere cross-encoder relevance in [0, 1]; falls back to the RRF score. */
  rerankScore: number;
  rrfScore: number;
  /** 1-indexed citation marker used in the synthesized answer, e.g. [2]. */
  citationIndex: number;
}

export interface RetrievalResult {
  contexts: RetrievedContext[];
  stats: {
    denseHits: number;
    sparseHits: number;
    fusedCandidates: number;
    rerankApplied: boolean;
    /** Candidates dropped for scoring below RERANK_SCORE_THRESHOLD. */
    droppedBelowThreshold: number;
    durationMs: number;
  };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const planStepSchema = z.object({
  id: z.string(),
  /** The sub-question this step answers. */
  query: z.string(),
  /** Why this step is needed — surfaced in the inspector, not sent to the LLM. */
  rationale: z.string(),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const planSchema = z.object({
  steps: z.array(planStepSchema).min(1).max(5),
  /** True when the planner judges the question answerable from one lookup. */
  isSimple: z.boolean(),
});
export type Plan = z.infer<typeof planSchema>;

export const verificationSchema = z.object({
  status: z.enum(['grounded', 'partially_grounded', 'unsupported']),
  /** 0–1 confidence that every claim traces to a supplied context. */
  confidence: z.number().min(0).max(1),
  /** Claims the verifier could not tie back to a citation. */
  unsupportedClaims: z.array(z.string()),
  reasoning: z.string(),
});
export type Verification = z.infer<typeof verificationSchema>;

export type VerificationStatus = Verification['status'] | 'pending' | 'skipped';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** True when returned by the deterministic mock (no TAVILY_API_KEY set). */
  isMock: boolean;
}

export type AgentNodeName =
  | 'planner'
  | 'retriever'
  | 'web_search'
  | 'synthesizer'
  | 'verifier';

// ---------------------------------------------------------------------------
// Streamed agent telemetry (custom AI SDK data parts)
// ---------------------------------------------------------------------------

/**
 * Everything the agent tells the UI while it works. These are streamed as
 * AI SDK custom data parts (`data-agent-event`), which is what powers the
 * real-time inspector drawer.
 */
export type AgentEvent =
  | { kind: 'node_start'; node: AgentNodeName; label: string; at: number }
  | { kind: 'node_end'; node: AgentNodeName; durationMs: number; at: number }
  | { kind: 'plan'; plan: Plan; at: number }
  | {
      kind: 'retrieval';
      stepId: string;
      query: string;
      contexts: RetrievedContext[];
      stats: RetrievalResult['stats'];
      at: number;
    }
  | { kind: 'web_search'; query: string; results: WebSearchResult[]; at: number }
  | { kind: 'verification'; verification: Verification; at: number }
  | { kind: 'error'; node: AgentNodeName; message: string; at: number };

/** Trace metadata streamed once the turn is finished. */
export interface TraceSummary {
  traceId: string | null;
  traceUrl: string | null;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  model: string;
  tracingEnabled: boolean;
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export const chatRequestSchema = z.object({
  messages: z.array(z.unknown()),
  /** Restrict retrieval to a subset of the corpus. */
  documentIds: z.array(z.string().uuid()).optional(),
  sessionId: z.string().optional(),
});

export const uploadResultSchema = z.object({
  documentId: z.string().uuid(),
  filename: z.string(),
  status: documentStatusSchema,
});
export type UploadResult = z.infer<typeof uploadResultSchema>;
