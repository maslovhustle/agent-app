import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/documents/ingest.ts` is the synchronous half of ingestion, shared by
 * the upload Server Action and the `ingest_document` MCP tool. It touches
 * Supabase and Inngest, both of which are stubbed here — the Supabase project
 * in `.env.local` is dead and these tests must run without it. Text
 * extraction (`@/lib/chunking`) is left real: for `.txt`/`.md` input it is
 * pure and local, so faking it would just be testing the fake.
 *
 * What matters here is the row lifecycle: a `documents` row is created before
 * extraction runs, a failure after that point must mark the row `failed` and
 * still propagate the original error, and validation failures that happen
 * before any row exists must not touch the database at all. That behaviour
 * has to match the pre-refactor `uploadDocument` Server Action exactly — see
 * `git show dev:app/actions/documents.ts`.
 */

const insertCalls = vi.hoisted(() => [] as Array<{ table: string; payload: unknown }>);
const updateCalls = vi.hoisted(() => [] as Array<{ table: string; payload: unknown }>);
const sendCalls = vi.hoisted(() => [] as unknown[]);

const state = vi.hoisted(() => ({
  insertDocumentResult: { data: { id: 'doc-1' } as { id: string } | null, error: null as { message: string } | null },
  insertSourceResult: { error: null as { message: string } | null },
}));

vi.mock('@/lib/supabase/server', () => {
  function thenable(result: unknown) {
    return {
      select: () => ({
        single: async () => result,
      }),
      eq: async () => result,
      then: (resolve: (value: unknown) => void) => Promise.resolve(result).then(resolve),
    };
  }

  function from(table: string) {
    return {
      insert: (payload: unknown) => {
        insertCalls.push({ table, payload });
        if (table === 'documents') return thenable(state.insertDocumentResult);
        if (table === 'document_sources') return thenable(state.insertSourceResult);
        return thenable({ data: null, error: null });
      },
      update: (payload: unknown) => {
        updateCalls.push({ table, payload });
        return thenable({ data: null, error: null });
      },
    };
  }

  // A single shared client, not a fresh object per call: `ingestDocumentSource`
  // and `markDocumentFailed` each call `getSupabaseAdmin()` independently, and
  // one test below spies on `.from` to simulate the failure-recording write
  // itself failing — that only works if every caller sees the same object.
  const client = { from };
  return { getSupabaseAdmin: () => client };
});

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (event: unknown) => {
      sendCalls.push(event);
    },
  },
}));

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  sendCalls.length = 0;
  state.insertDocumentResult = { data: { id: 'doc-1' }, error: null };
  state.insertSourceResult = { error: null };
});

afterEach(() => {
  // One test spies on the shared mock client's `.from` to simulate the
  // failure-recording write itself failing; restore it so that spy cannot
  // leak into later tests in this file.
  vi.restoreAllMocks();
});

async function importIngest() {
  return import('@/lib/documents/ingest');
}

function textSource(text: string, filename = 'policy.txt') {
  return {
    filename,
    mimeType: 'text/plain',
    bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

const VALID_TEXT = 'x'.repeat(200);

describe('validation — checked before any row is written', () => {
  it('rejects an empty file without touching the database', async () => {
    const { ingestDocumentSource } = await importIngest();

    await expect(ingestDocumentSource(textSource(''))).rejects.toThrow('is empty');
    expect(insertCalls).toHaveLength(0);
  });

  it('rejects a file over the 20 MB limit without touching the database', async () => {
    const { ingestDocumentSource, MAX_FILE_BYTES } = await importIngest();
    const oversized = {
      filename: 'huge.txt',
      mimeType: 'text/plain',
      bytes: new ArrayBuffer(MAX_FILE_BYTES + 1),
    };

    await expect(ingestDocumentSource(oversized)).rejects.toThrow('20 MB');
    expect(insertCalls).toHaveLength(0);
  });

  it('rejects an unsupported file type without touching the database', async () => {
    const { ingestDocumentSource } = await importIngest();
    const source = {
      filename: 'archive.zip',
      mimeType: 'application/zip',
      bytes: new TextEncoder().encode('PK...').buffer as ArrayBuffer,
    };

    await expect(ingestDocumentSource(source)).rejects.toThrow('only PDF, Markdown and plain text');
    expect(insertCalls).toHaveLength(0);
  });

  it('checks emptiness before size and type, matching the pre-refactor order', async () => {
    // A zero-byte file is technically also "not oversized" and its filename
    // extension may be unsupported — emptiness must win so the message is the
    // useful one, not an unrelated type complaint about a file with no bytes.
    const { ingestDocumentSource } = await importIngest();
    const source = { filename: 'empty.zip', mimeType: 'application/zip', bytes: new ArrayBuffer(0) };

    await expect(ingestDocumentSource(source)).rejects.toThrow('is empty');
  });
});

describe('row lifecycle — extraction fails after the row is created', () => {
  it('marks the row failed and still propagates the original error when text is too short', async () => {
    const { ingestDocumentSource } = await importIngest();

    await expect(ingestDocumentSource(textSource('too short'))).rejects.toThrow(
      'too short to index',
    );

    expect(insertCalls[0]).toEqual({
      table: 'documents',
      payload: expect.objectContaining({ filename: 'policy.txt', status: 'pending' }),
    });
    const failedUpdate = updateCalls.find((call) => call.table === 'documents');
    expect(failedUpdate?.payload).toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('too short to index'),
    });
    expect(sendCalls).toHaveLength(0);
  });

  it('marks the row failed and propagates the error when storing extracted text fails', async () => {
    state.insertSourceResult = { error: { message: 'connection reset' } };
    const { ingestDocumentSource } = await importIngest();

    await expect(ingestDocumentSource(textSource(VALID_TEXT))).rejects.toThrow(
      'Could not store extracted text: connection reset',
    );

    const failedUpdate = updateCalls.find((call) => call.table === 'documents');
    expect(failedUpdate?.payload).toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('connection reset'),
    });
    expect(sendCalls).toHaveLength(0);
  });

  it('throws immediately, before extraction, when the initial row insert fails', async () => {
    state.insertDocumentResult = { data: null, error: { message: 'db unreachable' } };
    const { ingestDocumentSource } = await importIngest();

    await expect(ingestDocumentSource(textSource(VALID_TEXT))).rejects.toThrow(
      'Could not create document record: db unreachable',
    );

    // No document id exists yet, so there is nothing to mark failed — the
    // only insert attempt is the one that failed.
    expect(insertCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(0);
  });

  it('does not swallow a markDocumentFailed failure — the original error still propagates', async () => {
    // The write that records the failure is itself best-effort (see the
    // module's own comment on markDocumentFailed). Simulate that write also
    // failing and confirm the *original* extraction error is still what the
    // caller sees, not a secondary error about the failed update.
    const { ingestDocumentSource } = await importIngest();
    const { getSupabaseAdmin } = await import('@/lib/supabase/server');
    // `getSupabaseAdmin()` returns the same shared object on every call (see
    // the mock above), so spying on it here also affects the internal calls
    // `ingestDocumentSource` and `markDocumentFailed` make.
    const client = getSupabaseAdmin() as unknown as {
      from: (table: string) => { update: (p: unknown) => unknown };
    };
    const originalFrom = client.from.bind(client);
    vi.spyOn(client, 'from').mockImplementation((table: string) => {
      const real = originalFrom(table) as { update: (p: unknown) => { eq: () => Promise<unknown> } };
      if (table === 'documents') {
        return {
          ...real,
          update: () => ({
            eq: async () => {
              throw new Error('update also failed');
            },
          }),
        };
      }
      return real;
    });

    await expect(ingestDocumentSource(textSource('too short'))).rejects.toThrow(
      'too short to index',
    );
  });
});

describe('happy path', () => {
  it('creates the row, stores the text, enqueues the worker, and returns the document', async () => {
    const { ingestDocumentSource } = await importIngest();

    const result = await ingestDocumentSource(textSource(VALID_TEXT, 'gdpr.md'));

    expect(result).toEqual({
      documentId: 'doc-1',
      filename: 'gdpr.md',
      status: 'pending',
      charCount: VALID_TEXT.length,
    });

    expect(insertCalls.map((call) => call.table)).toEqual(['documents', 'document_sources']);
    expect(insertCalls[1]?.payload).toMatchObject({
      document_id: 'doc-1',
      content: VALID_TEXT,
    });

    const charCountUpdate = updateCalls.find(
      (call) => call.table === 'documents' && (call.payload as { char_count?: number }).char_count,
    );
    expect(charCountUpdate?.payload).toMatchObject({ char_count: VALID_TEXT.length });

    expect(sendCalls).toEqual([
      { name: 'document/uploaded', data: { documentId: 'doc-1', filename: 'gdpr.md' } },
    ]);
  });

  it('falls back to application/octet-stream when no mime type is supplied', async () => {
    const { ingestDocumentSource } = await importIngest();

    await ingestDocumentSource({
      filename: 'policy.txt',
      mimeType: '',
      bytes: new TextEncoder().encode(VALID_TEXT).buffer as ArrayBuffer,
    });

    expect(insertCalls[0]?.payload).toMatchObject({ mime_type: 'application/octet-stream' });
  });
});
