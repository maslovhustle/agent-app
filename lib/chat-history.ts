import type { ResearchUIMessage } from '@/lib/ai/agent/messages';

/**
 * Conversation persistence, backed by `localStorage`.
 *
 * Why not the database: this app has no authentication, so there is no user to
 * key server-side conversations to. Storing them per-browser is the honest
 * scope — the history is yours on this device, and nothing leaks between
 * visitors of a public demo.
 *
 * What IS persisted: the full message list, including the `data-agent-event`
 * and `data-trace` parts. That matters because the inspector is derived state
 * over `messages` — persist the parts and the agent trace, sources and cost
 * breakdown all come back with the conversation, rather than reloading into an
 * answer with no visible provenance.
 */

const STORAGE_KEY = 'cra.conversations.v1';
const MAX_CONVERSATIONS = 30;

export interface StoredConversation {
  id: string;
  /** Derived from the first user message; shown in the history list. */
  title: string;
  messages: ResearchUIMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Metadata only — enough to render the history list without parsing messages. */
export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
}

/**
 * Returns the Storage object, or null when it is unusable.
 *
 * `typeof window.localStorage` is NOT a safe probe: `typeof` only suppresses
 * ReferenceError for unresolved identifiers, and the member access itself
 * throws SecurityError in Chrome and Firefox when the user has blocked site
 * data for the origin. Accessing it outside a try would take down the whole
 * console over a browser privacy setting.
 */
function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readAll(): StoredConversation[] {
  const storage = getStorage();
  if (!storage) return [];

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Storage is user-writable and survives deploys, so treat anything in it as
    // untrusted: a shape change between versions must degrade to "no history",
    // never to a crash on mount.
    return parsed.filter(isStoredConversation);
  } catch {
    return [];
  }
}

function isStoredConversation(value: unknown): value is StoredConversation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.updatedAt === 'number' &&
    Array.isArray(candidate.messages) &&
    // Validating the ELEMENTS, not just that it is an array, is the difference
    // between "history is empty" and an unrecoverable white screen: restore
    // reopens the newest conversation on every mount, so one malformed message
    // would crash MessageList on load, and on every load after it, with no
    // in-app way back.
    candidate.messages.every(isRestorableMessage)
  );
}

/** The minimum shape `MessageList` and `deriveTurnState` assume. */
function isRestorableMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.role === 'string' &&
    Array.isArray(candidate.parts) &&
    candidate.parts.every(
      (part) => typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).type === 'string',
    )
  );
}

/**
 * Persists the list, shedding old conversations until it fits.
 *
 * Returns false when the newest conversation still could not be saved — the
 * caller needs that, because silently dropping writes means a user keeps
 * working, reloads, and finds the last N turns gone with no warning.
 */
function writeAll(conversations: StoredConversation[]): boolean {
  const storage = getStorage();
  if (!storage) return false;

  // A few long conversations with full agent traces approach the ~5 MB origin
  // budget. Shed the oldest one at a time rather than halving: halving cannot
  // shrink a list of one, which is exactly the case when the pressure comes
  // from a single long conversation rather than many.
  let candidates = [...conversations];

  while (candidates.length > 0) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(candidates));
      return true;
    } catch {
      candidates = candidates.slice(0, -1);
    }
  }

  // Even one conversation does not fit, or storage rejects every write
  // (private mode, disabled). Leave whatever is already stored alone.
  console.error(
    '[chat-history] could not persist conversations — storage is full or unavailable. ' +
      'The current conversation will not survive a reload.',
  );
  return false;
}

export function listConversations(): ConversationSummary[] {
  return readAll()
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      messageCount: conversation.messages.length,
      updatedAt: conversation.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadConversation(id: string): StoredConversation | null {
  return readAll().find((conversation) => conversation.id === id) ?? null;
}

/**
 * Inserts or updates a conversation. Empty ones are never stored, so opening
 * the app and navigating away does not litter the history with blanks.
 *
 * Returns false when the write did not land, so the UI can say so rather than
 * letting the user believe their history is safe.
 */
export function saveConversation(id: string, messages: ResearchUIMessage[]): boolean {
  if (messages.length === 0) return true;

  const conversations = readAll();
  const now = Date.now();
  const existing = conversations.find((conversation) => conversation.id === id);

  if (existing) {
    // Restoring on mount re-runs the save effect with identical messages.
    // Bumping `updatedAt` then would make every conversation read "just now"
    // the moment the app opens, and would re-serialise the whole blob — and
    // risk the quota path — on a plain page load.
    if (messagesEqual(existing.messages, messages)) return true;

    existing.messages = messages;
    existing.updatedAt = now;
    // Keep the original title: it names the conversation by what started it,
    // which stays a more useful label than whatever was asked most recently.
    if (!existing.title) existing.title = deriveTitle(messages);
  } else {
    conversations.push({
      id,
      title: deriveTitle(messages),
      messages,
      createdAt: now,
      updatedAt: now,
    });
  }

  const ordered = conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  return writeAll(ordered.slice(0, MAX_CONVERSATIONS));
}

/**
 * Cheap identity check for "did this turn actually change anything". Compares
 * ids and part counts rather than deep-equalling megabytes of agent traces.
 */
function messagesEqual(
  a: readonly ResearchUIMessage[],
  b: readonly ResearchUIMessage[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((message, index) => {
    const other = b[index];
    return other !== undefined && message.id === other.id && message.parts.length === other.parts.length;
  });
}

export function deleteConversation(id: string): void {
  writeAll(readAll().filter((conversation) => conversation.id !== id));
}

export function clearConversations(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — storage is unavailable.
  }
}

/** First user message, trimmed to something that fits a narrow list row. */
export function deriveTitle(messages: readonly ResearchUIMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  if (!firstUserMessage) return 'New conversation';

  const text = firstUserMessage.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();

  if (!text) return 'New conversation';
  return text.length <= 60 ? text : `${text.slice(0, 60)}…`;
}

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;

  return new Date(timestamp).toLocaleDateString();
}
