'use client';

import { AlertTriangle, ShieldCheck, Sparkles, User } from 'lucide-react';
import * as React from 'react';

import type { ResearchUIMessage } from '@/lib/ai/agent/messages';
import type { Verification } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Renders the conversation.
 *
 * Citation markers like `[2]` are turned into clickable chips that scroll the
 * matching source into view in the inspector — the whole point of a compliance
 * tool is that a claim and its evidence are one click apart.
 */

interface MessageListProps {
  messages: ResearchUIMessage[];
  isStreaming: boolean;
  onCitationClick: (citationIndex: number) => void;
}

export function MessageList({
  messages,
  isStreaming,
  onCitationClick,
}: MessageListProps): React.JSX.Element {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isStreaming]);

  if (messages.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col gap-6 px-5 py-6">
      {messages.map((message, index) => {
        const isLast = index === messages.length - 1;
        const text = message.parts
          .filter((part) => part.type === 'text')
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('');

        const verification = findVerification(message);

        return (
          <div key={message.id} className="flex gap-3">
            <Avatar role={message.role} />

            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-xs font-semibold text-[var(--color-ink-1)]">
                  {message.role === 'user' ? 'You' : 'Research Agent'}
                </span>
                {verification && <VerificationBadge verification={verification} />}
              </div>

              {text.length > 0 ? (
                <div
                  className={cn(
                    'text-sm leading-relaxed text-[var(--color-ink-1)]',
                    isLast && isStreaming && message.role === 'assistant' && 'streaming-caret',
                  )}
                >
                  <RichText text={text} onCitationClick={onCitationClick} />
                </div>
              ) : (
                message.role === 'assistant' &&
                isStreaming && (
                  <p className="text-sm text-[var(--color-ink-3)]">
                    Planning and retrieving evidence…
                  </p>
                )
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function Avatar({ role }: { role: string }): React.JSX.Element {
  const isUser = role === 'user';
  return (
    <span
      className={cn(
        'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
        isUser
          ? 'bg-[var(--color-surface-3)] text-[var(--color-ink-1)]'
          : 'bg-[oklch(0.72_0.16_255_/_0.15)] text-[var(--color-brand)]',
      )}
    >
      {isUser ? <User className="size-3.5" /> : <Sparkles className="size-3.5" />}
    </span>
  );
}

function VerificationBadge({ verification }: { verification: Verification }): React.JSX.Element {
  const config = {
    grounded: {
      tone: 'text-[var(--color-success)] bg-[oklch(0.75_0.16_155_/_0.12)]',
      icon: ShieldCheck,
      label: 'Grounded',
    },
    partially_grounded: {
      tone: 'text-[var(--color-warning)] bg-[oklch(0.79_0.15_85_/_0.12)]',
      icon: AlertTriangle,
      label: 'Partially grounded',
    },
    unsupported: {
      tone: 'text-[var(--color-danger)] bg-[oklch(0.68_0.19_25_/_0.12)]',
      icon: AlertTriangle,
      label: 'Unsupported',
    },
  }[verification.status];

  const Icon = config.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        config.tone,
      )}
      title={verification.reasoning}
    >
      <Icon className="size-3" />
      {config.label} · {Math.round(verification.confidence * 100)}%
    </span>
  );
}

/**
 * Minimal inline renderer: paragraphs, bullet lists, `**bold**`, and citation
 * chips. Deliberately not a full markdown pipeline — the synthesis prompt
 * constrains output to these shapes, and a dependency-free renderer keeps the
 * citation-click behaviour trivial to wire.
 */
function RichText({
  text,
  onCitationClick,
}: {
  text: string;
  onCitationClick: (index: number) => void;
}): React.JSX.Element {
  const blocks = text.split(/\n{2,}/);

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n');
        const isList = lines.every((line) => /^\s*[-*•]\s+/.test(line)) && lines.length > 0;

        if (isList) {
          return (
            <ul key={blockIndex} className="flex list-disc flex-col gap-1.5 pl-5">
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>
                  {renderInline(line.replace(/^\s*[-*•]\s+/, ''), onCitationClick)}
                </li>
              ))}
            </ul>
          );
        }

        return <p key={blockIndex}>{renderInline(block, onCitationClick)}</p>;
      })}
    </div>
  );
}

function renderInline(
  text: string,
  onCitationClick: (index: number) => void,
): React.ReactNode[] {
  // Split on citation markers ([1], [W2]) and bold spans in one pass.
  const tokens = text.split(/(\[W?\d+\]|\*\*[^*]+\*\*)/g);

  return tokens.map((token, index) => {
    const citation = /^\[(\d+)\]$/.exec(token);
    if (citation?.[1]) {
      const citationIndex = Number(citation[1]);
      return (
        <button
          key={index}
          type="button"
          onClick={() => onCitationClick(citationIndex)}
          className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded border border-[oklch(0.72_0.16_255_/_0.4)] bg-[oklch(0.72_0.16_255_/_0.12)] px-1 align-baseline text-[10px] font-semibold text-[var(--color-brand)] transition-colors hover:bg-[oklch(0.72_0.16_255_/_0.25)]"
          title={`Jump to source ${citationIndex}`}
        >
          {citationIndex}
        </button>
      );
    }

    if (/^\[W\d+\]$/.test(token)) {
      return (
        <span
          key={index}
          className="mx-0.5 inline-flex h-4 items-center rounded border border-[oklch(0.79_0.15_85_/_0.4)] bg-[oklch(0.79_0.15_85_/_0.12)] px-1 text-[10px] font-semibold text-[var(--color-warning)]"
          title="External web source — not from the vetted corpus"
        >
          {token.slice(1, -1)}
        </span>
      );
    }

    const bold = /^\*\*([^*]+)\*\*$/.exec(token);
    if (bold?.[1]) {
      return (
        <strong key={index} className="font-semibold text-[var(--color-ink-0)]">
          {bold[1]}
        </strong>
      );
    }

    return <React.Fragment key={index}>{token}</React.Fragment>;
  });
}

function findVerification(message: ResearchUIMessage): Verification | null {
  for (const part of message.parts) {
    if (part.type === 'data-agent-event' && part.data.kind === 'verification') {
      return part.data.verification;
    }
  }
  return null;
}

function EmptyState(): React.JSX.Element {
  const examples = [
    'What are the notification deadlines for a personal data breach, and who must be told?',
    'Compare the data processing agreement requirements across the uploaded frameworks.',
    'Which access-control obligations apply to a subprocessor handling health records?',
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-[oklch(0.72_0.16_255_/_0.12)] text-[var(--color-brand)]">
        <Sparkles className="size-5" />
      </div>
      <div className="max-w-md">
        <h2 className="text-base font-semibold text-[var(--color-ink-0)]">
          Ask a compliance question
        </h2>
        <p className="mt-2 text-sm text-[var(--color-ink-3)]">
          The agent plans its research, runs hybrid retrieval over your corpus, reranks the
          evidence, writes a cited answer, then checks that answer against the evidence it used.
        </p>
      </div>
      <ul className="flex w-full max-w-md flex-col gap-2 text-left">
        {examples.map((example) => (
          <li
            key={example}
            className="panel-muted px-3 py-2 text-xs text-[var(--color-ink-2)]"
          >
            {example}
          </li>
        ))}
      </ul>
    </div>
  );
}
