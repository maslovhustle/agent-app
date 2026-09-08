import type { RetrievalResult, RetrievedContext, Verification } from '@/lib/types';

/**
 * How results are shaped and rendered for a client agent.
 *
 * Kept apart from the tool wiring because this is where the judgement lives:
 * an MCP tool result carries both a structured payload and a block of text,
 * and the text is what a model actually reads. Everything below is written on
 * the assumption that the reader is another agent deciding whether to trust
 * and repeat what it was handed.
 */

/**
 * Parent chunks default to ~1500 characters, so this only bites on a corpus
 * tuned for much larger contexts. It exists so one pathological document
 * cannot blow up a client's context window.
 */
export const MAX_PASSAGE_CHARS = 4000;

export interface Passage {
  citation: number;
  documentId: string;
  parentId: string;
  filename: string;
  section: number;
  score: number;
  scoreKind: 'rerank' | 'rrf';
  content: string;
}

export function toPassage(context: RetrievedContext, rerankApplied: boolean): Passage {
  return {
    citation: context.citationIndex,
    documentId: context.documentId,
    parentId: context.parentId,
    filename: context.filename,
    // Matches `formatContextsForPrompt`, so a citation the model wrote and a
    // citation we report point at the same section number.
    section: context.ordinal + 1,
    score: context.rerankScore,
    // `rerankScore` silently falls back to the RRF score when Cohere is
    // unavailable. Saying which scale a number is on is the difference between
    // a client thresholding relevance and a client thresholding noise.
    scoreKind: rerankApplied ? 'rerank' : 'rrf',
    content: truncate(context.content, MAX_PASSAGE_CHARS),
  };
}

export function renderPassages(
  passages: readonly Passage[],
  stats: RetrievalResult['stats'],
): string {
  const header =
    `${passages.length} passage(s) in ${stats.durationMs} ms — ` +
    `${stats.denseHits} dense, ${stats.sparseHits} sparse, rerank ` +
    `${
      stats.rerankApplied
        ? 'applied'
        : 'UNAVAILABLE (scores are fusion ranks, not calibrated relevance)'
    }.`;

  if (passages.length === 0) {
    return `${header}\n\nThe corpus returned nothing for this query.`;
  }

  const body = passages
    .map(
      (passage) =>
        `[${passage.citation}] ${passage.filename} § ${passage.section} ` +
        `(${passage.scoreKind} ${passage.score.toFixed(3)})\n${passage.content}`,
    )
    .join('\n\n---\n\n');

  return `${header}\n\n${body}`;
}

export interface RenderedAnswer {
  verdict: Verification;
  answer: string | null;
  webSearch: { used: boolean; isMock: boolean };
}

/**
 * Renders the answer a client agent reads.
 *
 * The verdict goes first, before any prose, because a model that has already
 * read three paragraphs of confident text will not revise its belief on
 * reaching a caveat at the bottom. When the agent refused, the draft does not
 * appear here at all — it is available on the structured payload as
 * `withheldDraft` for a caller that explicitly wants it, but it never arrives
 * in the position where it would read as an answer.
 */
export function renderAnswer(payload: RenderedAnswer, citations: readonly Passage[]): string {
  const { verdict } = payload;
  const confidence = verdict.confidence.toFixed(2);

  if (payload.answer === null) {
    return (
      `GROUNDING VERDICT: unsupported (confidence ${confidence})\n\n` +
      'The agent declines to answer. Nothing it drafted could be traced back to the corpus, ' +
      'so the draft has been withheld rather than returned as prose — do not repeat it.\n\n' +
      `Verifier reasoning: ${verdict.reasoning}\n\n` +
      `Passages retrieved: ${citations.length}.`
    );
  }

  const lines = [`GROUNDING VERDICT: ${verdict.status} (confidence ${confidence})`];

  if (verdict.unsupportedClaims.length > 0) {
    lines.push(
      '',
      'These claims could not be tied back to a citation. Treat them as unverified:',
      ...verdict.unsupportedClaims.map((claim) => `  • ${claim}`),
    );
  }

  if (payload.webSearch.used) {
    lines.push(
      '',
      payload.webSearch.isMock
        ? 'Local evidence was thin, so the agent escalated to web search — but TAVILY_API_KEY ' +
          'is unset, so those results are MOCK data and carry no authority.'
        : 'Local evidence was thin, so parts of this answer draw on web search rather than ' +
          'the private corpus.',
    );
  }

  lines.push('', payload.answer);

  if (citations.length > 0) {
    lines.push(
      '',
      '── Citations ──',
      ...citations.map(
        (citation) =>
          `[${citation.citation}] ${citation.filename} § ${citation.section} ` +
          `(${citation.scoreKind} ${citation.score.toFixed(3)})`,
      ),
    );
  }

  return lines.join('\n');
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} characters]`;
}
