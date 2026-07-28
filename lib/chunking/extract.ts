import { SUPPORTED_MIME_TYPES } from '@/lib/types';

/**
 * Text extraction for the ingestion pipeline.
 *
 * PDF parsing is dynamically imported so that `unpdf`'s WASM/Node payload only
 * loads on the code path that actually needs it — the Inngest worker — and
 * never gets pulled into a page bundle.
 */

export interface ExtractionResult {
  text: string;
  /** Page count for PDFs; undefined for plain-text formats. */
  pageCount?: number;
}

export async function extractText(
  buffer: ArrayBuffer,
  mimeType: string,
  filename: string,
): Promise<ExtractionResult> {
  const kind = classify(mimeType, filename);

  switch (kind) {
    case 'pdf':
      return extractPdf(buffer);
    case 'text':
      return { text: new TextDecoder('utf-8').decode(buffer) };
  }
}

type FileKind = 'pdf' | 'text';

/**
 * Browsers are inconsistent about MIME types for `.md` (often `text/plain`,
 * sometimes empty), so the extension is the tiebreaker.
 */
function classify(mimeType: string, filename: string): FileKind {
  const extension = filename.toLowerCase().split('.').pop() ?? '';

  if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (['md', 'markdown', 'txt', 'text'].includes(extension)) return 'text';
  if (mimeType.startsWith('text/')) return 'text';

  throw new Error(
    `Unsupported file type "${mimeType || extension || 'unknown'}" for ${filename}. ` +
      `Supported: ${SUPPORTED_MIME_TYPES.join(', ')}`,
  );
}

async function extractPdf(buffer: ArrayBuffer): Promise<ExtractionResult> {
  const { extractText: extractPdfText, getDocumentProxy } = await import('unpdf');

  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractPdfText(pdf, { mergePages: true });

  const merged = Array.isArray(text) ? text.join('\n\n') : text;

  if (merged.trim().length === 0) {
    throw new Error(
      'No extractable text found in PDF. Scanned documents require OCR, ' +
        'which this pipeline does not perform.',
    );
  }

  return { text: merged, pageCount: totalPages };
}

export function isSupportedFile(mimeType: string, filename: string): boolean {
  try {
    classify(mimeType, filename);
    return true;
  } catch {
    return false;
  }
}
