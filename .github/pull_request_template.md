# What changed

<!-- One paragraph. What this changes and why. Link the spec or issue. -->

## PR type

- [ ] **`feature/* → dev`** — a change entering integration. Fill in everything below.
- [ ] **`dev → main`** — a release. Treat the description as a release note: what ships,
      what to watch after deploy. The per-change gates were already met upstream; what
      matters here is that the *integrated* result was verified on the preview URL.

## Owner

<!-- The agent from .claude/agents/README.md whose ownership map covers these paths. -->

- [ ] `rag-engineer` — `lib/ai/**`, `lib/chunking/**`
- [ ] `backend-engineer` — `app/api/**`, `app/actions/**`, `lib/inngest/**`, `lib/supabase/**`
- [ ] `frontend-engineer` — `components/**`, pages
- [ ] `design-system` — `app/globals.css`, `components/ui/**`
- [ ] `architect` — structure, dependencies, boundaries

---

## Verification chain

The order is fixed: **review → test → CI → deploy**. Tick each stage that has
actually completed. Do not tick ahead.

- [ ] **`code-reviewer` passed** — correctness by inspection
- [ ] **`test-engineer` passed** — correctness by execution
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green locally
- [ ] CI green on this PR
- [ ] *(`dev → main` only)* verified on the preview URL after the `dev` merge

### Mandatory review paths

Review is **not optional** when this PR touches any of these, because failures
there are silent — they surface as worse answers, not as exceptions:

- [ ] `lib/ai/retrieval/**` — pipeline order, fusion, thresholds
- [ ] `lib/ai/agent/state.ts` — reducers decide what the model reads
- [ ] `lib/ai/agent/prompts.ts` — the citation contract spans three prompts
- [ ] server/client boundary
- [ ] None of the above

---

## Evidence

### Retrieval / chunking changes — numbers or it did not happen

<!-- Delete this block if not applicable. -->

| Metric | Before | After |
|---|---|---|
| hit rate | | |
| MRR | | |
| precision | | |
| citation validity | | must be 1.0 |

Config before: `parent=… child=… k=… candidates=… topN=…`
Config after:  `parent=… child=… k=… candidates=… topN=…`

- [ ] Re-indexed after changing chunk sizes (otherwise the numbers mix two configs)
- [ ] Negative-control cases still retrieve nothing convincing

### UI changes

- [ ] Seen working in a browser, streaming path included

### Ingestion changes

- [ ] A real file uploaded and reached `ready`

---

## Out of scope

<!-- What this PR deliberately does NOT do. The most useful section for a reviewer. -->
