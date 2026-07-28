'use client';

import { FileText, MessagesSquare, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/', label: 'Research', icon: MessagesSquare },
  { href: '/documents', label: 'Documents', icon: FileText },
] as const;

export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center gap-6 border-b border-[var(--color-surface-3)] bg-[var(--color-surface-1)] px-5 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[oklch(0.72_0.16_255_/_0.15)] text-[var(--color-brand)]">
            <ShieldCheck className="size-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-[var(--color-ink-0)]">
            Compliance Research Agent
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--color-surface-2)] text-[var(--color-ink-0)]'
                    : 'text-[var(--color-ink-3)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink-1)]',
                )}
              >
                <Icon className="size-3.5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-ink-3)]">
          <span className="hidden sm:inline">
            Hybrid search · RRF · Cohere rerank · LangGraph · Langfuse
          </span>
        </div>
      </header>

      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
