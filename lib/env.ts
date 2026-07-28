import { z } from 'zod';

/**
 * Single source of truth for runtime configuration.
 *
 * Every value the application reads from `process.env` passes through this
 * schema. Nothing else in the codebase is allowed to touch `process.env`
 * directly — that rule is what keeps "works on my machine" bugs out of the
 * retrieval pipeline, where a silently-missing key degrades answer quality
 * instead of throwing.
 */

const booleanish = z
  .string()
  .transform((value) => value === 'true' || value === '1')
  .pipe(z.boolean());

const numeric = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().finite());

const serverSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Models
    OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required for embeddings'),
    ANTHROPIC_API_KEY: z.string().optional(),
    AGENT_PROVIDER: z.enum(['openai', 'anthropic']).default('openai'),

    // Vector store selection
    VECTOR_STORE: z.enum(['supabase', 'pinecone']).default('supabase'),

    NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

    PINECONE_API_KEY: z.string().optional(),
    PINECONE_INDEX: z.string().optional(),

    // Reranking
    COHERE_API_KEY: z.string().optional(),
    COHERE_RERANK_MODEL: z.string().default('rerank-english-v3.0'),

    // Observability
    LANGFUSE_PUBLIC_KEY: z.string().optional(),
    LANGFUSE_SECRET_KEY: z.string().optional(),
    LANGFUSE_BASE_URL: z.string().url().default('https://cloud.langfuse.com'),

    // Background jobs
    INNGEST_EVENT_KEY: z.string().optional(),
    INNGEST_SIGNING_KEY: z.string().optional(),

    // Web search fallback
    TAVILY_API_KEY: z.string().optional(),

    // RAG hyperparameters
    PARENT_CHUNK_SIZE: numeric(1500),
    PARENT_CHUNK_OVERLAP: numeric(200),
    CHILD_CHUNK_SIZE: numeric(300),
    CHILD_CHUNK_OVERLAP: numeric(60),
    RRF_K: numeric(60),
    RRF_DENSE_WEIGHT: numeric(1.0),
    RRF_SPARSE_WEIGHT: numeric(0.8),
    RETRIEVAL_CANDIDATES: numeric(20),
    RERANK_TOP_N: numeric(4),
    RERANK_SCORE_THRESHOLD: numeric(0.25),

    SKIP_ENV_VALIDATION: booleanish.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.VECTOR_STORE === 'supabase') {
      if (!value.NEXT_PUBLIC_SUPABASE_URL || !value.SUPABASE_SERVICE_ROLE_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'VECTOR_STORE=supabase requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
          path: ['NEXT_PUBLIC_SUPABASE_URL'],
        });
      }
    }

    if (value.VECTOR_STORE === 'pinecone') {
      if (!value.PINECONE_API_KEY || !value.PINECONE_INDEX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'VECTOR_STORE=pinecone requires PINECONE_API_KEY and PINECONE_INDEX',
          path: ['PINECONE_API_KEY'],
        });
      }
    }

    if (value.AGENT_PROVIDER === 'anthropic' && !value.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AGENT_PROVIDER=anthropic requires ANTHROPIC_API_KEY',
        path: ['ANTHROPIC_API_KEY'],
      });
    }

    if (value.CHILD_CHUNK_SIZE >= value.PARENT_CHUNK_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'CHILD_CHUNK_SIZE must be smaller than PARENT_CHUNK_SIZE — parent-child retrieval ' +
          'depends on children being precise probes into larger parent contexts',
        path: ['CHILD_CHUNK_SIZE'],
      });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

/**
 * `next build` statically analyses route modules without a populated `.env`.
 * Validation is therefore lazy: the first real request pays for it, the build
 * does not. Set `SKIP_ENV_VALIDATION=true` to bypass entirely (CI lint jobs).
 */
let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;

  if (process.env.SKIP_ENV_VALIDATION === 'true' || process.env.SKIP_ENV_VALIDATION === '1') {
    cached = serverSchema.parse({
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'sk-placeholder',
      VECTOR_STORE: 'supabase',
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'placeholder',
    });
    return cached;
  }

  const parsed = serverSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }

  cached = parsed.data;
  return cached;
}

/** Feature flags derived from which optional credentials are actually present. */
export function getCapabilities() {
  const env = getEnv();
  return {
    rerankEnabled: Boolean(env.COHERE_API_KEY),
    tracingEnabled: Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY),
    webSearchEnabled: Boolean(env.TAVILY_API_KEY),
    anthropicEnabled: Boolean(env.ANTHROPIC_API_KEY),
  } as const;
}

/** Retrieval hyperparameters, grouped for the tuner agent and eval harness. */
export function getRagConfig() {
  const env = getEnv();
  return {
    parentChunkSize: env.PARENT_CHUNK_SIZE,
    parentChunkOverlap: env.PARENT_CHUNK_OVERLAP,
    childChunkSize: env.CHILD_CHUNK_SIZE,
    childChunkOverlap: env.CHILD_CHUNK_OVERLAP,
    rrfK: env.RRF_K,
    rrfDenseWeight: env.RRF_DENSE_WEIGHT,
    rrfSparseWeight: env.RRF_SPARSE_WEIGHT,
    candidates: env.RETRIEVAL_CANDIDATES,
    rerankTopN: env.RERANK_TOP_N,
    rerankScoreThreshold: env.RERANK_SCORE_THRESHOLD,
  } as const;
}

export type RagConfig = ReturnType<typeof getRagConfig>;
export type Capabilities = ReturnType<typeof getCapabilities>;
