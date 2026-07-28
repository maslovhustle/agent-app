import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-5',
  {
    variants: {
      tone: {
        neutral:
          'border-[var(--color-surface-3)] bg-[var(--color-surface-2)] text-[var(--color-ink-2)]',
        brand:
          'border-[oklch(0.72_0.16_255_/_0.35)] bg-[oklch(0.72_0.16_255_/_0.12)] text-[var(--color-brand)]',
        success:
          'border-[oklch(0.75_0.16_155_/_0.35)] bg-[oklch(0.75_0.16_155_/_0.12)] text-[var(--color-success)]',
        warning:
          'border-[oklch(0.79_0.15_85_/_0.35)] bg-[oklch(0.79_0.15_85_/_0.12)] text-[var(--color-warning)]',
        danger:
          'border-[oklch(0.68_0.19_25_/_0.35)] bg-[oklch(0.68_0.19_25_/_0.12)] text-[var(--color-danger)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
