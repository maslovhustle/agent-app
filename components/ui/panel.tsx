import * as React from 'react';

import { cn } from '@/lib/utils';

export function Panel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('panel flex flex-col overflow-hidden', className)} {...props} />;
}

export function PanelHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-surface-3)] px-4 py-3',
        className,
      )}
      {...props}
    />
  );
}

export function PanelTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return (
    <h2
      className={cn(
        'flex items-center gap-2 text-sm font-semibold text-[var(--color-ink-0)]',
        className,
      )}
      {...props}
    />
  );
}

export function PanelBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto', className)} {...props} />;
}

/** Label/value row used throughout the inspector and trace drawers. */
export function StatRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-[var(--color-ink-3)]">{label}</span>
      <span
        className={cn(
          'text-right text-xs text-[var(--color-ink-1)]',
          mono && 'font-[family-name:var(--font-mono)]',
        )}
      >
        {value}
      </span>
    </div>
  );
}
