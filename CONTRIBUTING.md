# Contributing

Both `dev` and `main` are protected. Nothing lands on either except through a
reviewed, tested, CI-green pull request.

## Branch model

```
feature/*  →  dev  →  main
   PR #1      PR #2
              ↓         ↓
           preview   production
```

| Branch | Role | Deploys to |
|---|---|---|
| `feature/*`, `fix/*`, `tune/*` | where work happens | nothing |
| `dev` | integration — changes meet each other here first | preview URL |
| `main` | production | production URL |

Two gates, not one. The first PR asks *"is this change correct?"*; the second asks
*"is the integrated result ready to ship?"*. A change that passes in isolation can
still break something it was merged alongside, and `dev` is where that surfaces —
on a preview URL rather than in production.

## The flow

```
feature branch → code-reviewer → test-engineer → PR to dev → CI green → approval
  → merge to dev → verify on preview → PR dev→main → CI green → approval
  → merge to main → production deploy
```

### 1. Branch off `dev`, never `main`

```bash
git switch dev && git pull
git switch -c feat/corpus-filter-presets
```

Branch names carry their type: `feat/`, `fix/`, `tune/`, `refactor/`, `docs/`,
`test/`, `chore/`.

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

### 5. Open the PR into `dev`

```bash
git push -u origin feat/corpus-filter-presets
```

Base branch is **`dev`**. Fill in the template honestly — tick a stage only once it has
actually completed. A pre-ticked checklist is worse than an empty one, because it
converts a gate into decoration.

Requires CI green **and** an approving review. Squash-merge; the PR title becomes the
commit message, so write it as one.

### 6. Verify on preview

Merging to `dev` deploys a preview URL. Check the change there against the *integrated*
state — this is the step that catches conflicts between two individually-correct
changes.

### 7. Promote `dev` → `main`

Open a second PR, `dev` into `main`. Its description is a release note: what is being
shipped and what to watch after deploy. Same gates — CI green, approving review.

Merging to `main` deploys production. That is the only way anything reaches it.

## Commit messages

```
<type>: <imperative summary>

Why this change, and the consequence it carries. Not what the diff shows —
the diff already shows that.
```

Types: `feat`, `fix`, `tune`, `refactor`, `docs`, `test`, `chore`.

## Deployment

`dev` deploys to preview, `main` deploys to production — both only through
`.github/workflows/deploy.yml`, which is gated on its verify job.

`vercel.json` disables Vercel's own Git deployments for both branches. Without that,
Vercel would deploy on push without waiting for GitHub Actions, and a red test suite
could reach production — which is exactly what happened once before this was fixed.

## The rules that get a PR rejected

From [`CLAUDE.md`](CLAUDE.md):

- `any`, or an `eslint-disable` on the no-any rule
- reading `process.env` outside `lib/env.ts`
- a `useState` mirroring data already on the message stream
- catching an error and returning empty data with no flag and no log
- changing the `[n]` citation format in one prompt but not all three
- embedding parent chunks — children are embedded, parents are read
