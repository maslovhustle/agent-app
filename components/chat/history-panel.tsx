'use client';

import { History, MessageSquare, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { formatRelativeTime, type ConversationSummary } from '@/lib/chat-history';
import { cn } from '@/lib/utils';

/**
 * Past conversations, in a dropdown off the chat header.
 *
 * A dropdown rather than a permanent sidebar: the inspector already occupies
 * the right column, and a third panel would squeeze the thing people actually
 * read. History is navigation, not something you watch while working.
 */

interface HistoryPanelProps {
  conversations: ConversationSummary[];
  activeId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}

export function HistoryPanel({
  conversations,
  activeId,
  onSelect,
  onDelete,
  onNew,
}: HistoryPanelProps): React.JSX.Element {
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={() => setIsOpen((current) => !current)}>
        <History className="size-3.5" />
        {conversations.length > 0 ? `History · ${conversations.length}` : 'History'}
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-lg border border-[var(--color-surface-3)] bg-[var(--color-surface-2)] p-1.5 shadow-xl">
            <button
              type="button"
              onClick={() => {
                onNew();
                setIsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-xs font-medium text-[var(--color-brand)] hover:bg-[var(--color-surface-3)]"
            >
              <Plus className="size-3.5" />
              New conversation
            </button>

            {conversations.length > 0 && (
              <div className="my-1 border-t border-[var(--color-surface-3)]" />
            )}

            <div className="max-h-80 overflow-y-auto">
              {conversations.length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-[var(--color-ink-3)]">
                  No past conversations yet. They are stored in this browser only — this demo
                  has no accounts.
                </p>
              ) : (
                conversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className={cn(
                      'group flex items-start gap-2 rounded px-2 py-2 transition-colors',
                      conversation.id === activeId
                        ? 'bg-[oklch(0.72_0.16_255_/_0.12)]'
                        : 'hover:bg-[var(--color-surface-3)]',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(conversation.id);
                        setIsOpen(false);
                      }}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    >
                      <MessageSquare
                        className={cn(
                          'mt-0.5 size-3 shrink-0',
                          conversation.id === activeId
                            ? 'text-[var(--color-brand)]'
                            : 'text-[var(--color-ink-3)]',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 block text-[11px] leading-relaxed text-[var(--color-ink-1)]">
                          {conversation.title}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-[var(--color-ink-3)]">
                          {formatRelativeTime(conversation.updatedAt)} ·{' '}
                          {conversation.messageCount} messages
                        </span>
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onDelete(conversation.id)}
                      title="Delete conversation"
                      className="mt-0.5 shrink-0 text-[var(--color-ink-3)] opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
