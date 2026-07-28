import { describe, expect, it } from 'vitest';

import { chunkParentChild, normalizeText } from '@/lib/chunking/parent-child';
import { splitText } from '@/lib/chunking/text-splitter';

describe('splitText', () => {
  it('returns the whole text when it already fits', () => {
    const text = 'A short clause.';
    expect(splitText(text, { chunkSize: 100, chunkOverlap: 10 })).toEqual([text]);
  });

  it('respects the chunk size budget', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about data.`).join(' ');
    const chunks = splitText(text, { chunkSize: 200, chunkOverlap: 40 });

    expect(chunks.length).toBeGreaterThan(1);
    // Overlap is carried as whole fragments, so allow modest headroom.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(280);
    }
  });

  it('prefers paragraph boundaries over mid-sentence cuts', () => {
    const text = `${'a'.repeat(150)}\n\n${'b'.repeat(150)}\n\n${'c'.repeat(150)}`;
    const chunks = splitText(text, { chunkSize: 200, chunkOverlap: 0 });

    // Each paragraph is homogeneous, so a clean split means no chunk mixes letters.
    for (const chunk of chunks) {
      const distinct = new Set(chunk.replace(/\s/g, '').split(''));
      expect(distinct.size).toBe(1);
    }
  });

  it('keeps markdown headings attached to their section', () => {
    const text = `## Article 32\n${'x'.repeat(120)}\n\n## Article 33\n${'y'.repeat(120)}`;
    const chunks = splitText(text, { chunkSize: 160, chunkOverlap: 0 });

    const withHeading = chunks.filter((chunk) => chunk.includes('## Article'));
    expect(withHeading.length).toBe(2);
    for (const chunk of withHeading) {
      expect(chunk.trimStart().startsWith('## Article')).toBe(true);
    }
  });

  it('hard-splits text with no usable separator', () => {
    const chunks = splitText('x'.repeat(1000), { chunkSize: 100, chunkOverlap: 0 });
    expect(chunks.length).toBe(10);
  });

  it('rejects an overlap that would not terminate', () => {
    expect(() => splitText('some text', { chunkSize: 100, chunkOverlap: 100 })).toThrow(
      /chunkOverlap/,
    );
  });

  it('returns nothing for whitespace-only input', () => {
    expect(splitText('   \n\n  ', { chunkSize: 100, chunkOverlap: 10 })).toEqual([]);
  });
});

describe('normalizeText', () => {
  it('rejoins words hyphenated across a line break', () => {
    expect(normalizeText('compli-\nance obligations')).toBe('compliance obligations');
  });

  it('strips zero-width and non-breaking characters that break tsvector lexemes', () => {
    expect(normalizeText('data protection​ act')).toBe('data protection act');
  });

  it('collapses excessive blank lines into a paragraph break', () => {
    expect(normalizeText('one\n\n\n\n\ntwo')).toBe('one\n\ntwo');
  });
});

describe('chunkParentChild', () => {
  const text = Array.from(
    { length: 40 },
    (_, i) => `Paragraph ${i}: the controller shall implement appropriate technical measures.`,
  ).join('\n\n');

  it('produces children that are strictly smaller than their parents', () => {
    const result = chunkParentChild(text, {
      parentChunkSize: 1500,
      parentChunkOverlap: 200,
      childChunkSize: 300,
      childChunkOverlap: 60,
    });

    expect(result.parents.length).toBeGreaterThan(0);
    expect(result.children.length).toBeGreaterThan(result.parents.length);

    const maxParent = Math.max(...result.parents.map((parent) => parent.charCount));
    const maxChild = Math.max(...result.children.map((child) => child.content.length));
    expect(maxChild).toBeLessThan(maxParent);
  });

  it('gives every child a parent that actually exists', () => {
    const result = chunkParentChild(text, {
      parentChunkSize: 800,
      parentChunkOverlap: 100,
      childChunkSize: 200,
      childChunkOverlap: 40,
    });

    const parentOrdinals = new Set(result.parents.map((parent) => parent.ordinal));
    for (const child of result.children) {
      expect(parentOrdinals.has(child.parentOrdinal)).toBe(true);
    }
  });

  it('numbers parents contiguously from zero', () => {
    const result = chunkParentChild(text, {
      parentChunkSize: 600,
      parentChunkOverlap: 50,
      childChunkSize: 200,
      childChunkOverlap: 20,
    });

    result.parents.forEach((parent, index) => {
      expect(parent.ordinal).toBe(index);
    });
  });

  it('handles a document smaller than one child chunk', () => {
    const result = chunkParentChild('A single short clause.', {
      parentChunkSize: 1500,
      parentChunkOverlap: 200,
      childChunkSize: 300,
      childChunkOverlap: 60,
    });

    expect(result.parents).toHaveLength(1);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.content).toBe(result.parents[0]?.content);
  });

  it('returns an empty result for empty input', () => {
    const result = chunkParentChild('   ', {
      parentChunkSize: 1500,
      parentChunkOverlap: 200,
      childChunkSize: 300,
      childChunkOverlap: 60,
    });

    expect(result).toEqual({ parents: [], children: [], charCount: 0 });
  });
});
