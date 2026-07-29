import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResearchUIMessage } from '@/lib/ai/agent/messages';

/**
 * The history store is the only place in the app that trusts data it did not
 * create: `localStorage` is user-writable and survives deploys, so a shape
 * change between versions has to degrade to "no history" rather than crash the
 * console on mount. Most of these tests are about that.
 */

// jsdom is not configured for this project, so provide the minimum surface the
// store actually uses. A real Storage would add nothing to what is asserted here.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  seed(key: string, value: string): void {
    this.store.set(key, value);
  }
}

let storage: MemoryStorage;

beforeEach(async () => {
  storage = new MemoryStorage();
  vi.stubGlobal('window', { localStorage: storage });
  vi.resetModules();
});

async function importStore() {
  return import('@/lib/chat-history');
}

function userMessage(id: string, text: string): ResearchUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as ResearchUIMessage;
}

describe('saveConversation', () => {
  it('stores a conversation and derives its title from the first user message', async () => {
    const { saveConversation, listConversations } = await importStore();

    saveConversation('c1', [userMessage('m1', 'What is the breach deadline?')]);

    const [summary] = listConversations();
    expect(summary?.title).toBe('What is the breach deadline?');
    expect(summary?.messageCount).toBe(1);
  });

  it('never stores an empty conversation', async () => {
    const { saveConversation, listConversations } = await importStore();

    saveConversation('c1', []);

    expect(listConversations()).toHaveLength(0);
  });

  it('keeps the original title when a conversation continues', async () => {
    const { saveConversation, listConversations } = await importStore();

    saveConversation('c1', [userMessage('m1', 'First question')]);
    saveConversation('c1', [userMessage('m1', 'First question'), userMessage('m2', 'Second')]);

    const summaries = listConversations();
    expect(summaries).toHaveLength(1);
    // The conversation is named by what started it, not by the latest question.
    expect(summaries[0]?.title).toBe('First question');
    expect(summaries[0]?.messageCount).toBe(2);
  });

  it('truncates a long title rather than letting it break the list layout', async () => {
    const { saveConversation, listConversations } = await importStore();

    saveConversation('c1', [userMessage('m1', 'x'.repeat(200))]);

    const title = listConversations()[0]?.title ?? '';
    expect(title.length).toBeLessThanOrEqual(61); // 60 chars + ellipsis
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('listConversations', () => {
  it('orders by most recently updated first', async () => {
    const { saveConversation, listConversations } = await importStore();

    saveConversation('older', [userMessage('m1', 'older')]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    saveConversation('newer', [userMessage('m2', 'newer')]);

    expect(listConversations().map((c) => c.id)).toEqual(['newer', 'older']);
  });

  it('returns nothing when storage is empty', async () => {
    const { listConversations } = await importStore();
    expect(listConversations()).toEqual([]);
  });
});

describe('corrupt storage', () => {
  it('degrades to empty history on malformed JSON instead of throwing', async () => {
    storage.seed('cra.conversations.v1', '{not json');
    const { listConversations } = await importStore();

    expect(listConversations()).toEqual([]);
  });

  it('degrades to empty history when the stored value is not an array', async () => {
    storage.seed('cra.conversations.v1', '{"unexpected":"shape"}');
    const { listConversations } = await importStore();

    expect(listConversations()).toEqual([]);
  });

  it('drops entries that do not match the expected shape but keeps valid ones', async () => {
    storage.seed(
      'cra.conversations.v1',
      JSON.stringify([
        { id: 'good', title: 'Valid', messages: [], updatedAt: 1 },
        { id: 'bad-missing-messages', title: 'Broken', updatedAt: 2 },
        null,
        'a string',
      ]),
    );
    const { listConversations } = await importStore();

    expect(listConversations().map((c) => c.id)).toEqual(['good']);
  });

  // Restore reopens the newest conversation on every mount, so a message the
  // UI cannot render is not a cosmetic problem — it crashes MessageList on
  // load, and on every load after it, with no in-app way back.
  it('rejects a conversation containing a message without parts', async () => {
    storage.seed(
      'cra.conversations.v1',
      JSON.stringify([
        { id: 'poison', title: 'Bad', messages: [{ id: 'm', role: 'assistant' }], updatedAt: 1 },
      ]),
    );
    const { listConversations, loadConversation } = await importStore();

    expect(listConversations()).toEqual([]);
    expect(loadConversation('poison')).toBeNull();
  });

  it('rejects a conversation whose message parts are malformed', async () => {
    storage.seed(
      'cra.conversations.v1',
      JSON.stringify([
        {
          id: 'poison',
          title: 'Bad',
          messages: [{ id: 'm', role: 'user', parts: [{ noTypeField: true }] }],
          updatedAt: 1,
        },
      ]),
    );
    const { listConversations } = await importStore();

    expect(listConversations()).toEqual([]);
  });
});

describe('unavailable storage', () => {
  // Chrome and Firefox throw SecurityError on `window.localStorage` when site
  // data is blocked. Reading it outside a try would unmount the whole console
  // over a browser privacy setting.
  it('degrades instead of throwing when localStorage access throws', async () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError: access denied');
      },
    });
    vi.resetModules();
    const { listConversations, loadConversation, saveConversation } = await importStore();

    expect(() => listConversations()).not.toThrow();
    expect(listConversations()).toEqual([]);
    expect(loadConversation('x')).toBeNull();
    expect(saveConversation('x', [userMessage('m', 'hi')])).toBe(false);
  });

  it('reports failure when every write is rejected', async () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => undefined,
      },
    });
    vi.resetModules();
    const { saveConversation } = await importStore();

    // The caller needs the false to warn the user, rather than letting them
    // believe a history that is silently not being written.
    expect(saveConversation('c1', [userMessage('m1', 'question')])).toBe(false);
  });
});

describe('idempotent saves', () => {
  it('does not bump updatedAt when the messages have not changed', async () => {
    const { saveConversation, listConversations } = await importStore();
    const messages = [userMessage('m1', 'question')];

    saveConversation('c1', messages);
    const first = listConversations()[0]?.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    saveConversation('c1', messages);
    const second = listConversations()[0]?.updatedAt;

    // Restore-on-mount re-runs the save with identical messages; bumping the
    // timestamp there would make every conversation read "just now" on load.
    expect(second).toBe(first);
  });

  it('does bump updatedAt when a message is added', async () => {
    const { saveConversation, listConversations } = await importStore();

    saveConversation('c1', [userMessage('m1', 'first')]);
    const first = listConversations()[0]?.updatedAt ?? 0;

    await new Promise((resolve) => setTimeout(resolve, 5));
    saveConversation('c1', [userMessage('m1', 'first'), userMessage('m2', 'second')]);
    const second = listConversations()[0]?.updatedAt ?? 0;

    expect(second).toBeGreaterThan(first);
  });
});

describe('deleteConversation', () => {
  it('removes only the targeted conversation', async () => {
    const { saveConversation, deleteConversation, listConversations } = await importStore();

    saveConversation('keep', [userMessage('m1', 'keep me')]);
    saveConversation('drop', [userMessage('m2', 'drop me')]);
    deleteConversation('drop');

    expect(listConversations().map((c) => c.id)).toEqual(['keep']);
  });

  it('is a no-op for an unknown id', async () => {
    const { saveConversation, deleteConversation, listConversations } = await importStore();

    saveConversation('c1', [userMessage('m1', 'hello')]);
    deleteConversation('does-not-exist');

    expect(listConversations()).toHaveLength(1);
  });
});

describe('loadConversation', () => {
  it('round-trips the full message list', async () => {
    const { saveConversation, loadConversation } = await importStore();
    const messages = [userMessage('m1', 'question'), userMessage('m2', 'follow-up')];

    saveConversation('c1', messages);

    expect(loadConversation('c1')?.messages).toEqual(messages);
  });

  it('returns null for an unknown id', async () => {
    const { loadConversation } = await importStore();
    expect(loadConversation('nope')).toBeNull();
  });
});

describe('server-side rendering', () => {
  it('returns empty history when window is undefined', async () => {
    vi.stubGlobal('window', undefined);
    vi.resetModules();
    const { listConversations, loadConversation } = await importStore();

    expect(listConversations()).toEqual([]);
    expect(loadConversation('anything')).toBeNull();
  });
});
