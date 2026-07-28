/**
 * Recursive character text splitter.
 *
 * Splits on the most semantically meaningful separator that still yields
 * chunks under `chunkSize`, walking down a priority list: sections →
 * paragraphs → lines → sentences → words → characters. Only when a fragment
 * is still too large at the current level does it recurse to a finer one.
 *
 * This is a deliberate reimplementation rather than a LangChain import: the
 * splitter is the single most impactful RAG hyperparameter, and the tuner
 * agent needs to be able to read and modify it without indirection.
 */

export interface SplitOptions {
  chunkSize: number;
  chunkOverlap: number;
  /** Ordered by decreasing semantic strength. */
  separators?: string[];
}

const DEFAULT_SEPARATORS = [
  '\n## ', // markdown section
  '\n### ',
  '\n\n', // paragraph
  '\n', // line
  '. ', // sentence
  '? ',
  '! ',
  '; ',
  ', ',
  ' ', // word
  '', // character (last resort)
];

export function splitText(text: string, options: SplitOptions): string[] {
  const { chunkSize, chunkOverlap, separators = DEFAULT_SEPARATORS } = options;

  if (chunkOverlap >= chunkSize) {
    throw new Error(
      `chunkOverlap (${chunkOverlap}) must be smaller than chunkSize (${chunkSize})`,
    );
  }

  const normalized = text.trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= chunkSize) return [normalized];

  const pieces = recursiveSplit(normalized, chunkSize, separators);
  return mergePieces(pieces, chunkSize, chunkOverlap);
}

/** Break text into fragments that each fit under `chunkSize` where possible. */
function recursiveSplit(text: string, chunkSize: number, separators: string[]): string[] {
  if (text.length <= chunkSize) return [text];

  const [separator, ...rest] = separators;

  // Exhausted every separator: hard-cut on character boundaries.
  if (separator === undefined) {
    return hardSplit(text, chunkSize);
  }

  if (separator === '') {
    return hardSplit(text, chunkSize);
  }

  const parts = splitKeepingSeparator(text, separator);

  // Separator not present — try the next, finer one.
  if (parts.length <= 1) {
    return recursiveSplit(text, chunkSize, rest);
  }

  const output: string[] = [];
  for (const part of parts) {
    if (part.length <= chunkSize) {
      output.push(part);
    } else {
      output.push(...recursiveSplit(part, chunkSize, rest));
    }
  }
  return output.filter((part) => part.length > 0);
}

/**
 * Splits on `separator` but keeps it attached to the *following* fragment, so
 * a markdown heading stays glued to the section it introduces.
 */
function splitKeepingSeparator(text: string, separator: string): string[] {
  const segments = text.split(separator);
  if (segments.length <= 1) return [text];

  const result: string[] = [];
  segments.forEach((segment, index) => {
    if (index === 0) {
      if (segment.length > 0) result.push(segment);
      return;
    }
    result.push(separator + segment);
  });
  return result;
}

function hardSplit(text: string, chunkSize: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    out.push(text.slice(i, i + chunkSize));
  }
  return out;
}

/**
 * Greedily packs fragments up to `chunkSize`, then carries `chunkOverlap`
 * characters of tail into the next chunk so a clause split across a boundary
 * is still retrievable from at least one side.
 */
function mergePieces(pieces: string[], chunkSize: number, chunkOverlap: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) return;
    const chunk = current.join('').trim();
    if (chunk.length > 0) chunks.push(chunk);
  };

  for (const piece of pieces) {
    if (currentLength + piece.length > chunkSize && currentLength > 0) {
      flush();

      // Rebuild the buffer from the tail of what we just emitted.
      const overlapBuffer: string[] = [];
      let overlapLength = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const tail = current[i];
        if (tail === undefined) continue;
        if (overlapLength + tail.length > chunkOverlap) break;
        overlapBuffer.unshift(tail);
        overlapLength += tail.length;
      }

      current = overlapBuffer;
      currentLength = overlapLength;
    }

    current.push(piece);
    currentLength += piece.length;
  }

  flush();
  return chunks;
}

/**
 * Rough token estimate (~4 chars/token for English prose). Good enough for
 * context-budget arithmetic; not a substitute for a real tokenizer at billing
 * time — that number comes from the provider's usage response.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
