# AI Knowledge & Compliance Research Agent

[![CI](https://github.com/maslovhustle/agent-app/actions/workflows/ci.yml/badge.svg)](https://github.com/maslovhustle/agent-app/actions/workflows/ci.yml)

A production-shaped Next.js 15 application that answers compliance questions against a
private document corpus — and shows its entire reasoning process while it does.

It exists to demonstrate what an *enterprise* AI product architecture actually looks like
once you go past "call the model with some context": advanced RAG, an agentic workflow,
hybrid search, cross-encoder reranking, grounding verification, and end-to-end
observability.

```
┌─────────────┐   ┌──────────────────────────────────────┐   ┌──────────────┐
│  Documents  │──▶│  Ingestion (Inngest, durable)        │──▶│   Postgres   │
│ PDF/MD/TXT  │   │  extract → parent-child chunk →      │   │  pgvector +  │
└─────────────┘   │  embed (text-embedding-3-small)      │   │   tsvector   │
                  └──────────────────────────────────────┘   └──────┬───────┘
                                                                    │
┌─────────────────────────────────────────────────────────────────┐ │
│  LangGraph agent                                                │ │
│                                                                 │ │
│  planner ──▶ retriever ⇄ (one pass per plan step) ◀──────────────┼─┘
│                 │          dense ∥ sparse → RRF → dedupe →      │
│                 │          Cohere rerank → hydrate parents      │
│                 ├──▶ web_search  (only if evidence is thin)     │
│                 └──▶ synthesizer ──▶ verifier ──▶ END           │
└──────────────────────────┬──────────────────────────────────────┘
                           │  one stream: text + agent events + trace
                           ▼
                  Chat UI · live inspector · trace drawer
```

---

## Table of contents

- [Quick start](#quick-start)
- [How it works](#how-it-works) — the concepts, explained
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Tuning and evaluation](#tuning-and-evaluation)
- [AI-assisted development setup](#ai-assisted-development-setup)
- [Production notes](#production-notes)

---

## Quick start

**Prerequisites:** Node ≥ 20.11, pnpm 10, a Supabase project, an OpenAI API key.

```bash
pnpm install
cp .env.example .env.local     # then fill in the required keys
```

Only two variables are strictly required: `OPENAI_API_KEY` and a Supabase URL +
service-role key. Cohere, Langfuse and Tavily are optional — the app degrades gracefully
and tells you in the UI when a capability is off.

**Apply the database schema.** Print it and paste into the Supabase SQL editor:

```bash
pnpm db:push
```

(This intentionally does not auto-apply: building an HNSW index locks the table, which is
a decision a human should make against a production database.)

**Run it** — two terminals:

```bash
pnpm dev
```

```bash
pnpm inngest:dev
```

The second one is the background worker. Without it, uploaded documents sit at `queued`
forever.

Then open http://localhost:3000/documents, upload a policy or regulation, wait for
`ready`, and go ask it something.

**Verify a change:**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

---

## How it works

This section is the point of the repository. Each piece below solves a specific failure
mode of naive RAG.

### 1. Parent-child chunking

**The problem.** Chunk size is a forced trade-off. Small chunks embed precisely — one
obligation, one definition, a tight unambiguous vector. Large chunks give the model enough
surrounding text to actually reason. You cannot get both from one chunk size.

**The fix.** Stop using one. Split each document twice:

- **Parent chunks (~1500 chars)** — what the LLM reads. Never embedded.
- **Child chunks (~300 chars)** — what gets embedded and searched.

Search the children, then hand the model their parents. Precision at retrieval time,
context at generation time.

> `lib/chunking/parent-child.ts`, `lib/chunking/text-splitter.ts`

The splitter is recursive: it tries the strongest semantic separator first (markdown
heading → paragraph → line → sentence → word) and only descends when a fragment is still
too big. Normalisation runs first, and matters more than it looks — PDF extraction emits
soft hyphens, non-breaking spaces and line-broken words that fragment Postgres lexemes and
quietly wreck keyword recall.

### 2. Hybrid search

**The problem.** Embeddings are semantic, which is usually a feature and occasionally a
disaster. Ask about "Article 32" and a vector search will happily return Article 33 —
they are nearly identical in meaning-space. Exact identifiers, control ids and defined
terms are precisely what compliance questions are made of.

**The fix.** Run both retrieval modes and fuse them:

- **Dense** — pgvector HNSW cosine ANN over child embeddings. Catches paraphrase.
- **Sparse** — Postgres `tsvector` with `ts_rank_cd`, BM25-style. Catches exact terms.

They execute concurrently — they are independent, so running them serially is pure latency
waste.

> `lib/ai/retrieval/search.ts`, `supabase/migrations/0001_init.sql`

Both live on the *same table*, so they return the same primary keys and can be fused
without a join. That is why `child_chunks` carries the vector and the tsvector on one row.

### 3. Reciprocal Rank Fusion

**The problem.** How do you merge a cosine similarity of `0.83` with a `ts_rank_cd` of
`0.0041`? They are different scales — one bounded and clustered, one unbounded and
corpus-dependent. Any normalisation you invent breaks as the corpus grows.

**The fix.** Throw the scores away. Fuse *ranks*:

```
score(d) = Σ over strategies  weight_s / (k + rank_s(d))
```

with `k = 60`. The constant damps the influence of the very top ranks, so a document both
strategies rank moderately well beats one a single strategy ranks first. That is exactly
right: **agreement across retrieval modalities is a stronger relevance signal than
confidence within one.**

> `lib/ai/retrieval/rrf.ts` — and `tests/rrf.test.ts` locks in the invariant that raw
> scores can never affect the outcome.

Then `dedupeByParent` collapses to one candidate per parent. Without it, a single verbose
parent floods the reranker window with near-duplicate children and starves the answer of
diverse evidence. It is the cheapest diversity control in the pipeline.

### 4. Cross-encoder reranking

**The problem.** Vector search uses a *bi-encoder*: query and document are embedded
independently, so it can only measure how close two summaries land. It is fast enough to
index millions of chunks and too coarse to pick the best four.

**The fix.** A *cross-encoder* reads the query and document **together** in one forward
pass and scores the pair directly. Far more accurate, far too slow to run over a corpus —
which is why it belongs here, as a second stage over ~20 survivors.

> `lib/ai/retrieval/rerank.ts`

This is the single highest-leverage precision win in the pipeline: it turns "20 plausible
chunks" into "the 4 that answer the question". It also degrades cleanly — no Cohere key,
or an API error, and you get RRF ordering with `rerankApplied: false`. A reranker outage
costs precision, not availability.

### 5. The agent graph

**The problem.** "Compare the breach-notification duties across these three frameworks"
is not one search. It is three, plus a synthesis. A single retrieval pass answers it badly.

**The fix.** A stateful LangGraph workflow:

| Node | Job |
|---|---|
| `planner` | Decide simple vs investigative; decompose into 1–4 searchable sub-queries. |
| `retriever` | Run the full hybrid pipeline for one plan step. Loops. |
| `web_search` | Escalation when local evidence is genuinely thin. |
| `synthesizer` | Write the answer, streaming, under a strict citation contract. |
| `verifier` | Adversarially check every claim against the context that was supplied. |

> `lib/ai/agent/graph.ts`, `lib/ai/agent/state.ts`

**Why a graph rather than a tool-calling loop?** Because the control flow is known in
advance and must be *inspectable*. A compliance analyst needs to see that an answer came
from three specific retrievals and passed a grounding check — not that a model opaquely
decided to call a tool four times. The graph makes the pipeline a diagram instead of a
transcript.

LangGraph state is not a mutable object. Each node returns a **partial update**, and a
per-channel **reducer** merges it. The `contexts` reducer is the interesting one: it
accumulates across steps, de-duplicates by parent, keeps the better score, and renumbers
citations contiguously — because the citation contract is only enforceable if the numbers
the model sees are the numbers the verifier checks.

### 6. Verification

Every answer is checked by a separate adversarial pass against the same contexts the
writer saw, and classified `grounded` / `partially_grounded` / `unsupported` with a
confidence score and a list of unsupported claims.

This is the difference between a demo and a tool someone can rely on. The synthesis prompt
also has no hedging escape hatch: a claim that cannot be tied to a passage must be
**omitted, not softened**, and "the knowledge base does not cover this" is a correct
answer.

The same honesty rule governs the web-search fallback: with no `TAVILY_API_KEY`, it
returns explicitly-labelled mock results that say so, and the prompt is told to treat them
as *no external evidence*. A demo that fabricates plausible sources teaches the wrong
lesson about what the system knows.

### 7. Streaming and observability

Everything travels on **one HTTP response**:

- answer tokens → the chat bubble
- `data-agent-event` → the live inspector (plan, retrievals, fusion stats, verification)
- `data-trace` → the trace drawer (latency, tokens, estimated cost, Langfuse link)

> `app/api/chat/route.ts`, `lib/ai/agent/messages.ts`

These are the AI SDK's **typed custom data parts**, so the client gets full autocomplete on
`part.data` instead of casting from `unknown`. There is exactly one source of truth per
turn and no polling — the inspector is derived state over `messages`.

Langfuse mirrors the graph structure: one trace per turn, one span per node, one generation
per LLM call. So a slow turn is attributable to a specific node instead of guessed at.
Tracing is never load-bearing: with no keys, every call becomes a no-op and the request
completes normally.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15 App Router, React 19 | Server Components + Server Actions + streaming route handlers |
| Language | TypeScript strict, `noUncheckedIndexedAccess` | `any` is banned and lint-enforced |
| UI | Tailwind v4, Radix primitives, Lucide | `@theme` tokens; dark-first operator console |
| LLM orchestration | Vercel AI SDK v5 | `useChat`, streaming, typed data parts, `generateObject` |
| Agent | LangGraph.js | Stateful graph with channel reducers and conditional edges |
| Vector + keyword | Supabase pgvector + `tsvector` | Both retrieval modes on one row, one transaction |
| Reranking | Cohere cross-encoder | Second-stage precision |
| Observability | Langfuse | Trace tree mirroring the graph |
| Background jobs | Inngest | Durable, memoised, retrying ingestion steps |
| Validation | Zod | Env, API bodies, Server Actions, structured LLM output |
| Tests | Vitest | Pure-logic units + a RAG eval harness |

---

## Project structure

```
├── CLAUDE.md                   Architecture contract for AI coding agents
├── .cursorrules / .clauderc    Cursor + Claude Code configuration
├── prompts/dev-agents/         Specialised sub-agent system prompts
│   ├── db-agent.md             pgvector schemas, migrations, SQL tuning
│   ├── evals-agent.md          RAG accuracy testing and regression gates
│   └── rag-tuner.md            Chunk sizes, RRF weights, rerank thresholds
├── app/
│   ├── api/chat/route.ts       LangGraph + AI SDK streaming endpoint
│   ├── api/inngest/route.ts    Background workers
│   ├── actions/documents.ts    Server Actions (upload, list, delete, reindex)
│   ├── documents/page.tsx      Corpus manager
│   └── page.tsx                Research console
├── components/
│   ├── chat/                   Workspace, message list, composer
│   ├── agent/                  Inspector, source list, trace drawer
│   ├── documents/              Upload panel, document list
│   └── ui/                     Shadcn-style primitives
├── lib/
│   ├── env.ts                  Zod-validated config — the ONLY reader of process.env
│   ├── types.ts                Shared domain types
│   ├── chunking/               Splitter, parent-child, extraction
│   ├── ai/
│   │   ├── models.ts           Model registry by role + cost table
│   │   ├── embeddings.ts       Batched embedding with dimension guards
│   │   ├── langfuse.ts         Tracing that no-ops when unconfigured
│   │   ├── retrieval/          search · rrf · rerank · hybrid
│   │   ├── agent/              state · prompts · graph · messages
│   │   └── tools/              Web-search fallback
│   └── inngest/                Client + durable ingestion functions
├── supabase/migrations/        pgvector + tsvector schema and RPCs
├── evals/                      Ground-truth dataset + retrieval metrics
├── scripts/                    Eval runner, migration printer
└── tests/                      Vitest suites
```

---

## Configuration

Every variable is parsed by Zod in `lib/env.ts`; the app refuses to boot on a bad config.
Nothing else in the codebase reads `process.env`. See `.env.example` for the full list.

**Required:** `OPENAI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

**Optional, with honest degradation:**

| Missing | Effect |
|---|---|
| `COHERE_API_KEY` | RRF ordering only; inspector shows `rerank: skipped` |
| `LANGFUSE_*` | Local timing only; trace drawer says tracing is off |
| `TAVILY_API_KEY` | Web search returns a labelled mock; prompt treats it as no evidence |
| `ANTHROPIC_API_KEY` | Only needed when `AGENT_PROVIDER=anthropic` |

---

## Tuning and evaluation

```bash
pnpm evals                                # baseline retrieval metrics
pnpm evals -- --sweep child=200,300,400   # sweep child chunk size
```

Measured separately, because RAG fails in two distinct places:

- **Retrieval** — hit rate, MRR, precision, recall. *Was the answer even in the context?*
- **Generation** — groundedness, citation validity. *Given good context, did it answer honestly?*

Conflating them is the classic mistake. If hit rate is 60%, no prompt change fixes the
other 40% — the evidence was never in the window.

`evals/dataset.json` matches on **phrases, not chunk ids**, so ground truth survives the
re-chunking experiments it exists to support. It ships with a **negative control**: a
question the corpus cannot answer. A pipeline that "finds evidence" for it is
over-retrieving.

Full methodology in `prompts/dev-agents/rag-tuner.md` and `prompts/dev-agents/evals-agent.md`.

---

## AI-assisted development setup

This repo is configured to be worked on *by* AI agents as well as with them:

- **`CLAUDE.md`** — build commands, architecture rules, type-safety rules, the three-tier
  error-handling protocol, and an explicit list of changes that get rejected.
- **`.cursorrules`** — condensed constraints for Cursor Agent mode.
- **`.clauderc`** — machine-readable project config, sub-agent registry, and guardrails
  (which paths each sub-agent owns, which files are never edited, what "done" means).
- **`prompts/dev-agents/*.md`** — deep system prompts for three single-purpose specialists
  (SQL/pgvector, RAG evaluation, hyperparameter tuning).

### Agent team

`.claude/agents/` defines a project-scoped team with explicit ownership boundaries and a
handoff protocol — see [`.claude/agents/README.md`](.claude/agents/README.md) for the
routing diagram.

| Agent | Owns |
|---|---|
| `delivery-lead` | routing, sequencing, the quality gate |
| `product-owner` | specs and acceptance criteria |
| `project-manager` | task state, blockers, cut scope |
| `architect` | structure, dependencies, boundaries |
| `rag-engineer` | `lib/ai/**`, `lib/chunking/**` |
| `backend-engineer` | routes, Server Actions, Inngest, Supabase, CI |
| `frontend-engineer` | `components/**`, pages, streaming UI |
| `design-system` | tokens, `components/ui/**` |
| `code-reviewer` | correctness by inspection |
| `test-engineer` | `tests/**`, `evals/**` — correctness by execution |

Verification runs in a fixed order — **review → test → CI → deploy**. Review first because
a reviewer who finds a design flaw saves writing tests for code about to be rewritten;
tests before CI because CI is the same evidence re-run on a clean machine.

The protocol's central rule: **review is mandatory for changes to retrieval, agent state
reducers, prompts, or the server/client boundary** — because failures there are silent.
They surface as worse answers, not as exceptions, so no build or test catches them.

---

## CI/CD

Both `dev` and `main` are protected. Two gates, not one:

```
feature/* ──PR──▶ dev ──PR──▶ main
                   │            │
                preview     production
```

The first PR asks *"is this change correct?"*; the second asks *"is the integrated
result ready to ship?"*. A change that passes in isolation can still break something it
was merged alongside — `dev` surfaces that on a preview URL instead of in production.

Full rules in [`CONTRIBUTING.md`](CONTRIBUTING.md).

**`.github/workflows/ci.yml`** — runs on every push and PR to `dev` and `main`:
typecheck → lint → test → build, ordered cheapest-first so a typo fails in seconds
rather than after a four-minute build. Every step runs even when an earlier one fails,
so one push surfaces every problem at once.

CI needs no secrets. `SKIP_ENV_VALIDATION=true` bypasses the Zod config gate — safe here
because CI never serves a request, and the *only* place that flag belongs.

**`.github/workflows/deploy.yml`** — deploys to Vercel, gated on the verify job.
`dev` → preview URL, `main` → production. Needs three repository secrets
(`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`) and skips cleanly when absent.

### Why `vercel.json` disables Vercel's Git deploys

Vercel's Git integration reacts to the push itself and **does not wait for GitHub
Actions**. Left enabled, it happily ships a commit whose test suite is red — which is
exactly what happened here before this was fixed: production went live while CI was
failing, because Vercel, not the workflow, was doing the deploying.

`vercel.json` sets `git.deploymentEnabled` to `false` for both branches, so `deploy.yml`
becomes the single path to either environment. One route, one set of checks.

---

## Production notes

**Security.** The service-role Supabase client is `server-only` — importing it from a
Client Component is a build error. RLS is enabled on every table with service-role-only
policies, so a leaked anon key reads nothing. Server Actions validate with Zod before
touching the database, because a Server Action is a public HTTP endpoint wearing a
function signature.

**Scale.** Ingestion is queued and step-memoised: if embedding fails on batch 7, the retry
does not redo batches 1–6. Embedding concurrency is capped at 3 to stay under provider
rate limits. Inserts are batched at 500 rows.

**Cost.** Roles map to tiers — planning and verification are classification-shaped tasks
and run on the fast model; synthesis decides answer quality and gets the reasoning model.
Per-turn cost is estimated from real usage reports and shown in the trace drawer.

**What is deliberately not here.** Authentication and multi-tenancy (add Supabase Auth and
a `tenant_id` on every table, then rewrite the RLS policies to key off it), OCR for scanned
PDFs, and a Pinecone implementation — the `VECTOR_STORE` switch is wired through config,
but only the Supabase path is built.

---

## License

MIT
