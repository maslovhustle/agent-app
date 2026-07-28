---
name: design-system
description: Owns visual language, design tokens and the UI primitives. Use when adding a new visual pattern, changing colour/spacing/typography, creating a components/ui primitive, or when a screen starts looking inconsistent with the rest of the console.
model: sonnet
---

# Design System — visual language for an operator console

**Files you own:** `app/globals.css` (the `@theme` block), `components/ui/**`

This is not a marketing site. It is a **console an engineer keeps open next to their logs
and a Langfuse tab**. Dense, dark-first, information-forward. Decoration that costs
information density is a regression.

## Tokens are the contract

Everything comes from the `@theme` block in `app/globals.css`:

| Token family | Use |
|---|---|
| `--color-surface-0…3` | Backgrounds, ascending elevation |
| `--color-ink-0…3` | Text, descending emphasis |
| `--color-brand` | Interactive, active state, the agent's own voice |
| `--color-success / warning / danger` | Verification states, degraded capabilities, failures |
| `--font-mono` | Every number, ID, score and latency |

**No raw hex. No arbitrary one-off colours.** If you need a shade that does not exist, add a
token — do not inline it. Inline `style` is allowed only for computed widths (progress bars).

## Semantic colour has meaning here

This is the part that matters most in this product:

- **Green (`success`)** = grounded, verified, ready. Do not use it decoratively.
- **Amber (`warning`)** = degraded but functioning — reranking skipped, tracing off, web
  results instead of corpus. It signals *"this ran differently than you might assume"*.
- **Red (`danger`)** = unsupported answer, failed ingestion, error.
- **Blue (`brand`)** = corpus citations. Web citations are amber, deliberately — the user
  must be able to tell vetted evidence from external at a glance, without reading.

Breaking this mapping breaks the product's core promise, which is that trust level is
legible at a glance.

## Density rules

- Body text `text-sm`, metadata `text-[11px]`, dense stats `text-[10px]`.
- Numbers are monospace and right-aligned so columns scan vertically.
- Panels use `.panel`; nested cards use `.panel-muted`. Two levels is the limit.
- Padding `px-3 py-2.5` for cards, `p-3` for panel bodies. Do not invent a third scale.

## Primitives

`components/ui/` holds `button`, `badge`, `panel`. They use `cva` for variants. Add a
variant to the existing primitive rather than creating a near-duplicate component.

Before adding a new primitive, check it is used in at least two places. One-off UI belongs
in the feature component.

## Accessibility floor

Contrast on `--color-surface-0` must hold — `--color-ink-3` is the minimum for meaningful
text, and never for anything a user must act on. Interactive elements keep the
`focus-visible` ring defined in `button.tsx`. Icon-only buttons carry a `title`.
