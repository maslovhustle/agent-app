import type { Metadata } from 'next';

import { AppShell } from '@/components/layout/app-shell';

import './globals.css';

export const metadata: Metadata = {
  title: 'Compliance Research Agent',
  description:
    'Enterprise RAG console: hybrid retrieval, reciprocal rank fusion, cross-encoder reranking, ' +
    'a LangGraph research agent and end-to-end tracing.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
