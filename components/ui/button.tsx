'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ' +
    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-0)] ' +
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--color-brand)] text-[oklch(0.16_0.012_265)] hover:bg-[oklch(0.78_0.16_255)]',
        secondary:
          'bg-[var(--color-surface-2)] text-[var(--color-ink-0)] hover:bg-[var(--color-surface-3)]',
        ghost:
          'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink-0)]',
        danger:
          'bg-transparent text-[var(--color-danger)] hover:bg-[oklch(0.68_0.19_25_/_0.12)]',
        outline:
          'border border-[var(--color-surface-3)] bg-transparent text-[var(--color-ink-1)] ' +
          'hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink-0)]',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9 px-4',
        lg: 'h-11 px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
});

export { buttonVariants };
