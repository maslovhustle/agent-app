'use client';

import { ArrowUp, Loader2, Square } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ComposerProps {
  onSubmit: (text: string) => void;
  onStop: () => void;
  isBusy: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export function Composer({
  onSubmit,
  onStop,
  isBusy,
  disabled = false,
  disabledReason,
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Grow with content up to a cap, then scroll.
  React.useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [value]);

  const submit = (): void => {
    const trimmed = value.trim();
    if (!trimmed || isBusy || disabled) return;
    onSubmit(trimmed);
    setValue('');
  };

  return (
    <div className="shrink-0 border-t border-[var(--color-surface-3)] bg-[var(--color-surface-1)] p-3">
      {disabled && disabledReason && (
        <p className="mb-2 px-1 text-xs text-[var(--color-warning)]">{disabledReason}</p>
      )}

      <div
        className={cn(
          'flex items-end gap-2 rounded-xl border border-[var(--color-surface-3)] bg-[var(--color-surface-2)] p-2',
          'focus-within:border-[oklch(0.72_0.16_255_/_0.5)]',
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a newline. Standard chat affordance.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          disabled={disabled}
          placeholder="Ask about an obligation, a deadline, or how two frameworks differ…"
          className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-[var(--color-ink-0)] placeholder:text-[var(--color-ink-3)] focus:outline-none disabled:opacity-50"
        />

        {isBusy ? (
          <Button variant="secondary" size="icon" onClick={onStop} title="Stop generating">
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            variant="primary"
            size="icon"
            onClick={submit}
            disabled={value.trim().length === 0 || disabled}
            title="Send"
          >
            {isBusy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </Button>
        )}
      </div>

      <p className="mt-2 px-1 text-[11px] text-[var(--color-ink-3)]">
        Answers are grounded in your uploaded corpus and cite it. This is a research aid, not
        legal advice.
      </p>
    </div>
  );
}
