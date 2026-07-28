# Contributing

`main` is protected. Nothing lands on it except through a reviewed, tested,
CI-green pull request.

## The flow

```
feature branch → agent review → tests → PR → CI green → approval → merge → deploy
```

### 1. Branch

Never commit to `main` directly. Branch names carry their type:

```bash
git switch -c feat/corpus-filter-presets
git switch -c fix/rerank-threshold-passthrough
git switch -c tune/child-chunk-size
git switch -c chore/bump-ai-sdk
```

### 2. Build it

The owning agent from [`.claude/agents/README.md`](.claude/agents/README.md) does the
work. One owner per PR — if two agents both seem to own it, the change is too big and
should be split.

### 3. Review → test, in that order

```
code-reviewer  → correctness by inspection
test-engineer  → correctness by execution
```

Review comes first on purpose: a reviewer who finds a design flaw saves you writing
tests for code that is about to be rewritten.

**Review is mandatory**, not discretionary, when the PR touches:

- `lib/ai/retrieval/**`
- `lib/ai/agent/state.ts`
- `lib/ai/agent/prompts.ts`
- anything crossing the server/client boundary

Those failures are silent. They produce worse answers rather than exceptions, so no
build and no test will catch them.

### 4. Verify locally before pushing

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Plus, by change type:

| Change | Additional gate |
|---|---|
| Retrieval / chunking | `pnpm evals` before/after, both configs reported, no regression |
| UI | seen working in a browser, streaming path included |
| Ingestion | a real file uploaded and reaching `ready` |
| Schema | migration idempotent; states whether it locks a table |

CI runs exactly these commands on a clean machine. Failing locally first is the faster
loop.

### 5. Open the PR

```bash
git push -u origin feat/corpus-filter-presets
```

Fill in the template honestly. Tick a stage only once it has actually completed — a
pre-ticked checklist is worse than an empty one, because it converts a gate into
decoration.

### 6. Merge

Requires: CI green **and** an approving review. Squash-merge; the PR title becomes the
commit message, so write it as one.

## Commit messages

```
<type>: <imperative summary>

Why this change, and the consequence it carries. Not what the diff shows —
the diff already shows that.
```

Types: `feat`, `fix`, `tune`, `refactor`, `docs`, `test`, `chore`.

## Deployment

Production deploys from `main` only. Because `main` is protected, the only path to
production runs through this document.

See [`.github/workflows/`](.github/workflows/) for the pipeline and the README's CI/CD
section for how the two workflows relate.

## The rules that get a PR rejected

From [`CLAUDE.md`](CLAUDE.md):

- `any`, or an `eslint-disable` on the no-any rule
- reading `process.env` outside `lib/env.ts`
- a `useState` mirroring data already on the message stream
- catching an error and returning empty data with no flag and no log
- changing the `[n]` citation format in one prompt but not all three
- embedding parent chunks — children are embedded, parents are read
