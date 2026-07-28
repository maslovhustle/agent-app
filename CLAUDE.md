# CLAUDE.md — Project context for AI coding agents

This file is loaded automatically by Claude Code and read by Cursor/Windsurf agents.
It is the contract for how code in this repository gets written. Follow it over
your defaults.

---

## 1. What this project is

An **AI Knowledge & Compliance Research Agent**: a Next.js 15 application that answers
compliance questions against a private corpus, showing its work.

The four things that make it non-trivial, in the order they run:

1. **Parent-child ingestion** — documents are split into ~1500-char *parent* contexts and
   ~300-char *child* chunks. Children are embedded; parents are what the LLM reads.
2. **Hybrid retrieval** — pgvector HNSW (dense) and Postgres `tsvector` (sparse/BM25) run
   concurrently, then fuse via **Reciprocal Rank Fusion**, then a **Cohere cross-encoder**
   reranks ~20 survivors down to the top 4.
3. **A LangGraph agent** — `planner → retriever(×N) → [web_search] → synthesizer → verifier`.
4. **Observability** — one Langfuse trace per turn, one span per graph node, streamed to
   the UI as typed custom data parts.

---

## 2. Build & test commands

```bash
pnpm install            # pnpm only — do not use npm or yarn
pnpm dev                # dev server on :3000
pnpm inngest:dev        # background-job runner (required for document ingestion)
pnpm build              # production build; must pass before any PR
pnpm lint               # eslint flat config
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest (unit)
pnpm evals              # RAG quality metrics against evals/dataset.json
pnpm db:push            # print SQL migrations for psql / Supabase SQL editor
```

`SKIP_ENV_VALIDATION=true` bypasses env parsing — use it for CI lint/build jobs only,
never at runtime.

**Before you report a task complete, `pnpm typecheck && pnpm lint && pnpm test` must all pass.**
Run them. Do not assume.

---

## 3. Architecture rules

### Next.js App Router

- **Server Components by default.** Add `'use client'` only when the file needs state,
  effects, or browser APIs. Push the boundary as far down the tree as it will go.
- **Data mutations go through Server Actions** in `app/actions/*.ts`, not through API routes.
  Route handlers exist for exactly two things here: the streaming chat endpoint and the
  Inngest webhook.
- **`server-only` is mandatory** on any module touching the service-role Supabase client,
  Cohere, Langfuse, or the graph. If a Client Component can import it, it does not belong
  on the server side of that line.
- Server Actions must validate their inputs with Zod before touching the database. A
  Server Action is a public HTTP endpoint wearing a function signature.

### Streaming UI

- Chat streaming uses the **Vercel AI SDK v5** `useChat` hook with `DefaultChatTransport`.
- Agent telemetry travels as **typed custom data parts** (`data-agent-event`, `data-trace`)
  declared in `lib/ai/agent/messages.ts`. Do not invent a second channel — no polling
  endpoints, no websockets, no `useEffect` fetch loops for agent state.
- Inspector state is **derived** from `messages`. If you find yourself adding a `useState`
  that mirrors something already on the stream, you are introducing a desync bug.

### The retrieval pipeline

- Retrieval order is fixed: **embed → (dense ∥ sparse) → RRF → dedupe-by-parent → rerank →
  hydrate parents**. Do not reorder. Do not skip dedupe-by-parent; it is the only diversity
  control in the pipeline.
- **Every stage must degrade, not fail.** No Cohere key → RRF ordering with
  `rerankApplied: false`. Keyword search errors → dense-only, logged. This is why an
  outage in a dependency does not take down the endpoint.
- Never apply `RERANK_SCORE_THRESHOLD` to passthrough scores. Those are zeros, not
  relevance — the code branches on `rerankApplied` for exactly this reason.

### The agent graph

- Nodes are **pure-ish functions returning partial state updates**. Never mutate the state
  object you were handed; return a patch and let the channel reducer merge it.
- Reducers live in `lib/ai/agent/state.ts`. Changing one changes what the model reads —
  add a test in `tests/agent-state.test.ts` when you do.
- Every node goes through the `instrument()` wrapper so it emits `node_start`/`node_end`
  and opens a Langfuse span. A node that skips it is invisible in the inspector.

---

## 4. Type-safety rules

- **`any` is banned.** ESLint enforces `@typescript-eslint/no-explicit-any` as an error.
  Use `unknown` plus a type guard, or a Zod schema, at every boundary.
- `strict: true` and `noUncheckedIndexedAccess: true` are on. Array access yields
  `T | undefined` — handle it; do not reach for `!`.
- **Zod validates every boundary**: environment variables (`lib/env.ts`), API request
  bodies, Server Action arguments, and all structured LLM output.
- LLM structured output uses `generateObject` with a Zod schema. Never parse JSON out of
  a text completion by hand.
- Types shared across layers belong in `lib/types.ts`. Do not redeclare a shape locally
  because importing felt inconvenient.

---

## 5. Error-handling protocol

Three tiers, and the tier decides the handling:

| Tier | Example | Handling |
|---|---|---|
| **User-fixable** | unsupported file type, empty PDF, 20 MB limit | Throw from the Server Action with a message the user can act on. Surface it in the UI. |
| **Transient infrastructure** | embedding API 429, DB timeout during ingestion | Let it throw inside an Inngest `step.run`. Inngest retries with backoff. Do not catch. |
| **Degradable dependency** | Cohere down, Tavily missing, Langfuse unreachable | Catch, `console.error` with a `[module]` prefix, continue with reduced quality, and set the flag that tells the UI (`rerankApplied`, `isMock`, `tracingEnabled`). |

Additional rules:

- **Never swallow an error silently.** If you catch it, either log it with context or
  attach it to a Langfuse span.
- Failures inside a graph node are recorded on the node's span, emitted as an
  `{ kind: 'error' }` agent event, and then rethrown. The user sees which node failed.
- `createUIMessageStream`'s `onError` intentionally returns the real message. This is a
  developer tool; a generic "An error occurred" defeats its purpose.
- Never log secrets, full document text, or full user questions at `error` level.

---

## 6. Conventions

- **Tailwind v4** with the `@theme` block in `app/globals.css`. Use the CSS custom
  properties (`var(--color-brand)`, `var(--color-ink-2)`) — no raw hex, no arbitrary
  one-off colours.
- Shadcn-style primitives live in `components/ui/`. Compose them; do not fork them per page.
- File names are `kebab-case.tsx`; components are `PascalCase`; hooks are `useCamelCase`.
- Import order: node builtins → external → `@/lib` → `@/components` → relative.
- **Comments explain *why*, never *what*.** The codebase is dense with non-obvious
  trade-offs (why RRF instead of score normalisation, why children are embedded but
  parents are read). Preserve those. Do not add comments that restate the code.

---

## 7. Where things live

```
app/
  api/chat/route.ts        Streaming endpoint: graph + text + telemetry on one response
  api/inngest/route.ts     Durable background-job webhook
  actions/documents.ts     Server Actions: upload, list, delete, reindex, preview
lib/
  env.ts                   Zod-validated config. The ONLY module that reads process.env
  types.ts                 Shared domain types and schemas
  chunking/                Recursive splitter + parent-child algorithm + extraction
  ai/
    models.ts              Model registry by role + cost table
    embeddings.ts          Batched embedding with dimension guards
    langfuse.ts            Tracing wrapper that no-ops when unconfigured
    retrieval/             search · rrf · rerank · hybrid (the orchestrator)
    agent/                 state · prompts · graph · messages
    tools/web-search.ts    Tavily fallback with an honest mock
  inngest/                 Client + durable ingestion functions
supabase/migrations/       pgvector + tsvector schema and RPCs
evals/                     Ground-truth dataset and retrieval metrics
prompts/dev-agents/        System prompts for the specialised sub-agents
```

---

## 8. Specialised sub-agents

For focused work, load the matching prompt from `prompts/dev-agents/`:

- **`db-agent.md`** — Supabase/pgvector schema changes, migrations, SQL function tuning.
- **`evals-agent.md`** — RAG accuracy test suites and Langfuse-based evaluation.
- **`rag-tuner.md`** — chunk sizes, overlap ratios, RRF weights, rerank thresholds.

---

## 9. Things that will get a change rejected

- Adding `any`, or an `eslint-disable` on the no-any rule.
- Reading `process.env` outside `lib/env.ts`.
- A `useEffect` that polls for agent state instead of reading the message stream.
- Catching an error and returning empty data with no flag and no log — a silent quality
  regression is worse than a loud failure.
- Changing the `[n]` citation format in one prompt without changing the synthesizer
  prompt, the verifier prompt, and `formatContextsForPrompt` together.
- Embedding parent chunks. Children are embedded. Parents are read. That asymmetry is the
  whole design.
