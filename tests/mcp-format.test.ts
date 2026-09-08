import { describe, expect, it } from 'vitest';

import { renderAnswer, renderPassages, toPassage, truncate } from '@/mcp/format';
import type { RetrievalResult, RetrievedContext, Verification } from '@/lib/types';

const context = (overrides: Partial<RetrievedContext> = {}): RetrievedContext => ({
  parentId: 'parent-1',
  documentId: 'doc-1',
  filename: 'gdpr.pdf',
  ordinal: 4,
  content: 'Personal data shall be kept for no longer than is necessary.',
  rerankScore: 0.91,
  rrfScore: 0.033,
  citationIndex: 1,
  ...overrides,
});

const stats = (overrides: Partial<RetrievalResult['stats']> = {}): RetrievalResult['stats'] => ({
  denseHits: 20,
  sparseHits: 14,
  fusedCandidates: 9,
  rerankApplied: true,
  droppedBelowThreshold: 2,
  durationMs: 312,
  ...overrides,
});

const verification = (overrides: Partial<Verification> = {}): Verification => ({
  status: 'grounded',
  confidence: 0.92,
  unsupportedClaims: [],
  reasoning: 'Every claim maps to a cited passage.',
  ...overrides,
});

describe('toPassage', () => {
  it('reports the same section number the synthesizer was shown', () => {
    // `formatContextsForPrompt` renders `section ${ordinal + 1}`, so a citation
    // the model wrote must point at the section a client is told about.
    expect(toPassage(context({ ordinal: 0 }), true).section).toBe(1);
    expect(toPassage(context({ ordinal: 4 }), true).section).toBe(5);
  });

  it('labels the score scale so a client cannot threshold fusion ranks as relevance', () => {
    expect(toPassage(context(), true).scoreKind).toBe('rerank');
    expect(toPassage(context(), false).scoreKind).toBe('rrf');
  });
});

describe('renderPassages', () => {
  it('says so loudly when reranking was unavailable', () => {
    const passages = [toPassage(context(), false)];
    const text = renderPassages(passages, stats({ rerankApplied: false }));

    expect(text).toContain('UNAVAILABLE');
    expect(text).not.toContain('rerank applied');
  });

  it('reports an empty corpus result rather than rendering nothing', () => {
    expect(renderPassages([], stats())).toContain('returned nothing');
  });
});

describe('renderAnswer', () => {
  const citations = [toPassage(context(), true)];

  it('leads with the verdict, before any prose', () => {
    const text = renderAnswer(
      {
        verdict: verification(),
        answer: 'Retention is limited to what is necessary [1].',
        webSearch: { used: false, isMock: false },
      },
      citations,
    );

    expect(text.startsWith('GROUNDING VERDICT: grounded (confidence 0.92)')).toBe(true);
    expect(text).toContain('Retention is limited');
    expect(text).toContain('[1] gdpr.pdf § 5 (rerank 0.910)');
  });

  it('withholds the draft entirely when the agent refused', () => {
    const draft = 'Fabricated obligation with no support in the corpus.';

    const text = renderAnswer(
      {
        verdict: verification({
          status: 'unsupported',
          confidence: 0.05,
          reasoning: 'No retrieved passage mentions retention.',
        }),
        // A refusal is signalled by a null answer; the draft travels on the
        // structured payload instead, never in the rendered text.
        answer: null,
        webSearch: { used: false, isMock: false },
      },
      [],
    );

    expect(text).toContain('declines to answer');
    expect(text).not.toContain(draft);
    expect(text).toContain('No retrieved passage mentions retention.');
  });

  it('enumerates unverified claims on a partially grounded answer', () => {
    const text = renderAnswer(
      {
        verdict: verification({
          status: 'partially_grounded',
          confidence: 0.6,
          unsupportedClaims: ['The retention period is exactly 30 days.'],
        }),
        answer: 'Data must not be kept longer than necessary [1].',
        webSearch: { used: false, isMock: false },
      },
      citations,
    );

    expect(text).toContain('Treat them as unverified');
    expect(text).toContain('• The retention period is exactly 30 days.');
  });

  it('flags mocked web results as carrying no authority', () => {
    const text = renderAnswer(
      {
        verdict: verification(),
        answer: 'Answer drawing on the web.',
        webSearch: { used: true, isMock: true },
      },
      citations,
    );

    expect(text).toContain('MOCK data');
  });
});

describe('truncate', () => {
  it('leaves short text alone and annotates what it cut', () => {
    expect(truncate('short', 100)).toBe('short');
    expect(truncate('abcdef', 3)).toBe('abc\n…[truncated 3 characters]');
  });
});
