import type { ChildChunk, ChunkedDocument, ParentChunk } from '@/lib/types';

import { splitText } from './text-splitter';

/**
 * Parent-child (a.k.a. "small-to-big") chunking.
 *
 * The core insight: the ideal unit for *finding* a passage and the ideal unit
 * for *reasoning about* it are different sizes. A 300-character child chunk
 * embeds into a tight, unambiguous vector — a single obligation, one
 * definition. A 1500-character parent carries the surrounding clause,
 * exceptions and cross-references the model needs to answer correctly.
 *
 * So we embed children, search children, then hand the LLM their parents.
 */

export interface ParentChildOptions {
  parentChunkSize: number;
  parentChunkOverlap: number;
  childChunkSize: number;
  childChunkOverlap: number;
}

export function chunkParentChild(text: string, options: ParentChildOptions): ChunkedDocument {
  const normalized = normalizeText(text);

  if (normalized.length === 0) {
    return { parents: [], children: [], charCount: 0 };
  }

  const parentTexts = splitText(normalized, {
    chunkSize: options.parentChunkSize,
    chunkOverlap: options.parentChunkOverlap,
  });

  const parents: ParentChunk[] = [];
  const children: ChildChunk[] = [];

  parentTexts.forEach((parentText, parentOrdinal) => {
    parents.push({
      ordinal: parentOrdinal,
      content: parentText,
      charCount: parentText.length,
    });

    const childTexts = splitText(parentText, {
      chunkSize: options.childChunkSize,
      chunkOverlap: options.childChunkOverlap,
    });

    // A parent shorter than childChunkSize yields exactly one child equal to
    // itself, which is correct: the probe and the context coincide.
    childTexts.forEach((childText, ordinal) => {
      children.push({ parentOrdinal, ordinal, content: childText });
    });
  });

  return { parents, children, charCount: normalized.length };
}

/**
 * Normalisation matters more than it looks. PDF extraction produces soft
 * hyphens, non-breaking spaces and page-break artefacts that fragment the
 * `tsvector` lexemes and quietly degrade BM25 recall.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ') // non-breaking space
    .replace(/­/g, '') // soft hyphen
    .replace(/[​-‍﻿]/g, '') // zero-width characters
    // De-hyphenate words broken across a line: "compli-\nance" → "compliance".
    .replace(/(\w)-\n(\w)/g, '$1$2')
    // Collapse runs of 3+ newlines into a paragraph break.
    .replace(/\n{3,}/g, '\n\n')
    // Collapse horizontal whitespace but preserve newlines.
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
