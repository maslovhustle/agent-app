'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { Activity, AlertTriangle, FileStack, Filter, ListTree } from 'lucide-react';
import * as React from 'react';

import { AgentInspector } from '@/components/agent/agent-inspector';
import { SourceList } from '@/components/agent/source-list';
import { TraceDrawer } from '@/components/agent/trace-drawer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import type { ResearchUIMessage } from '@/lib/ai/agent/messages';
import type {
  AgentEvent,
  DocumentRecord,
  RetrievedContext,
  TraceSummary,
  WebSearchResult,
} from '@/lib/types';
import { cn } from '@/lib/utils';

import { Composer } from './composer';
import { MessageList } from './message-list';

/**
 * The research console.
 *
 * Everything the agent emits — plan, retrievals, fusion stats, verification,
 * trace summary — arrives on the same stream as the answer text, as typed
 * custom data parts. So there is exactly one source of truth per turn and no
 * polling: the inspector is derived state over `messages`, nothing more.
 */

type InspectorTab = 'agent' | 'sources' | 'trace';

interface ResearchWorkspaceProps {
  documents: DocumentRecord[];
}

export function ResearchWorkspace({ documents }: ResearchWorkspaceProps): React.JSX.Element {
  const [selectedDocumentIds, setSelectedDocumentIds] = React.useState<string[]>([]);
  const [activeTab, setActiveTab] = React.useState<InspectorTab>('agent');
  const [highlightedCitation, setHighlightedCitation] = React.useState<number | null>(null);

  const sessionId = React.useMemo(() => crypto.randomUUID(), []);

  const readyDocuments = documents.filter((document) => document.status === 'ready');

  // `useChat` re-creates the transport whenever the filter changes so the next
  // request carries the current corpus selection.
  const transport = React.useMemo(
    () =>
      new DefaultChatTransport<ResearchUIMessage>({
        api: '/api/chat',
        body: {
          documentIds: selectedDocumentIds.length > 0 ? selectedDocumentIds : undefined,
          sessionId,
        },
      }),
    [selectedDocumentIds, sessionId],
  );

  const { messages, sendMessage, status, error, stop } = useChat<ResearchUIMessage>({
    transport,
  });

  const isStreaming = status === 'submitted' || status === 'streaming';

  const { events, trace, contexts, webResults } = React.useMemo(
    () => deriveTurnState(messages),
    [messages],
  );

  const handleCitationClick = React.useCallback((citationIndex: number) => {
    setActiveTab('sources');
    setHighlightedCitation(citationIndex);
    // Clear so clicking the same citation twice re-triggers the scroll.
    window.setTimeout(() => setHighlightedCitation(null), 1200);
  }, []);

  const toggleDocument = (documentId: string): void => {
    setSelectedDocumentIds((current) =>
      current.includes(documentId)
        ? current.filter((id) => id !== documentId)
        : [...current, documentId],
    );
  };

  return (
    <div className="grid h-full grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* ---------------------------------------------------------------- */}
      {/* Chat                                                              */}
      {/* ---------------------------------------------------------------- */}
      <Panel>
        <PanelHeader>
          <PanelTitle>
            <ListTree className="size-3.5 text-[var(--color-brand)]" />
            Investigative Research
          </PanelTitle>

          <CorpusFilter
            documents={readyDocuments}
            selectedIds={selectedDocumentIds}
            onToggle={toggleDocument}
            onClear={() => setSelectedDocumentIds([])}
          />
        </PanelHeader>

        <PanelBody>
          {readyDocuments.length === 0 && (
            <div className="m-3 flex items-start gap-2 rounded-lg border border-[oklch(0.79_0.15_85_/_0.35)] bg-[oklch(0.79_0.15_85_/_0.1)] px-3 py-2.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warning)]" />
              <p className="text-[11px] leading-relaxed text-[var(--color-warning)]">
                No indexed documents yet. The agent will find no local evidence and will fall back
                to web search. Upload a policy or regulation on the Documents page first.
              </p>
            </div>
          )}

          <MessageList
            messages={messages}
            isStreaming={isStreaming}
            onCitationClick={handleCitationClick}
          />

          {error && (
            <div className="m-3 flex items-start gap-2 rounded-lg border border-[oklch(0.68_0.19_25_/_0.35)] bg-[oklch(0.68_0.19_25_/_0.1)] px-3 py-2.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--color-danger)]" />
              <div>
                <p className="text-xs font-medium text-[var(--color-danger)]">Agent run failed</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-danger)] opacity-90">
                  {error.message}
                </p>
              </div>
            </div>
          )}
        </PanelBody>

        <Composer
          onSubmit={(text) => sendMessage({ text })}
          onStop={stop}
          isBusy={isStreaming}
        />
      </Panel>

      {/* ---------------------------------------------------------------- */}
      {/* Inspector                                                         */}
      {/* ---------------------------------------------------------------- */}
      <Panel className="hidden lg:flex">
        <PanelHeader className="gap-1 px-2">
          <div className="flex w-full items-center gap-1">
            <InspectorTabButton
              isActive={activeTab === 'agent'}
              onClick={() => setActiveTab('agent')}
              icon={ListTree}
              label="Agent"
            />
            <InspectorTabButton
              isActive={activeTab === 'sources'}
              onClick={() => setActiveTab('sources')}
              icon={FileStack}
              label="Sources"
              count={contexts.length}
            />
            <InspectorTabButton
              isActive={activeTab === 'trace'}
              onClick={() => setActiveTab('trace')}
              icon={Activity}
              label="Trace"
            />
          </div>
        </PanelHeader>

        <PanelBody>
          {activeTab === 'agent' && <AgentInspector events={events} isStreaming={isStreaming} />}
          {activeTab === 'sources' && (
            <SourceList
              contexts={contexts}
              webResults={webResults}
              highlightedCitation={highlightedCitation}
            />
          )}
          {activeTab === 'trace' && <TraceDrawer trace={trace} events={events} />}
        </PanelBody>
      </Panel>
    </div>
  );
}

function InspectorTabButton({
  isActive,
  onClick,
  icon: Icon,
  label,
  count,
}: {
  isActive: boolean;
  onClick: () => void;
  icon: typeof Activity;
  label: string;
  count?: number;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors',
        isActive
          ? 'bg-[var(--color-surface-2)] text-[var(--color-ink-0)]'
          : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]',
      )}
    >
      <Icon className="size-3.5" />
      {label}
      {count !== undefined && count > 0 && (
        <span className="rounded bg-[var(--color-surface-3)] px-1 text-[10px]">{count}</span>
      )}
    </button>
  );
}

function CorpusFilter({
  documents,
  selectedIds,
  onToggle,
  onClear,
}: {
  documents: DocumentRecord[];
  selectedIds: string[];
  onToggle: (documentId: string) => void;
  onClear: () => void;
}): React.JSX.Element | null {
  const [isOpen, setIsOpen] = React.useState(false);

  if (documents.length === 0) return null;

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={() => setIsOpen((current) => !current)}>
        <Filter className="size-3.5" />
        {selectedIds.length > 0 ? `${selectedIds.length} of ${documents.length}` : 'All documents'}
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-72 rounded-lg border border-[var(--color-surface-3)] bg-[var(--color-surface-2)] p-1.5 shadow-xl">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-3)]">
                Restrict retrieval
              </span>
              {selectedIds.length > 0 && (
                <button
                  type="button"
                  onClick={onClear}
                  className="text-[10px] text-[var(--color-brand)] hover:underline"
                >
                  clear
                </button>
              )}
            </div>

            <div className="max-h-64 overflow-y-auto">
              {documents.map((document) => (
                <label
                  key={document.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--color-surface-3)]"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(document.id)}
                    onChange={() => onToggle(document.id)}
                    className="size-3.5 accent-[var(--color-brand)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-ink-1)]">
                    {document.filename}
                  </span>
                  <Badge tone="neutral">{document.child_count}</Badge>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Derives inspector state from the last assistant message.
 *
 * Only the newest turn is shown: an inspector that accumulated every retrieval
 * from a long conversation would bury the run you are actually debugging.
 */
function deriveTurnState(messages: readonly ResearchUIMessage[]): {
  events: AgentEvent[];
  trace: TraceSummary | null;
  contexts: RetrievedContext[];
  webResults: WebSearchResult[];
} {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');

  if (!lastAssistant) {
    return { events: [], trace: null, contexts: [], webResults: [] };
  }

  const events: AgentEvent[] = [];
  let trace: TraceSummary | null = null;

  for (const part of lastAssistant.parts) {
    if (part.type === 'data-agent-event') {
      events.push(part.data);
    } else if (part.type === 'data-trace') {
      trace = part.data;
    }
  }

  // The retriever runs once per plan step; the last retrieval event carries the
  // fully-merged, contiguously-numbered context set from the graph reducer.
  const retrievals = events.filter(
    (event): event is Extract<AgentEvent, { kind: 'retrieval' }> => event.kind === 'retrieval',
  );

  const contextsByParent = new Map<string, RetrievedContext>();
  for (const retrieval of retrievals) {
    for (const context of retrieval.contexts) {
      const existing = contextsByParent.get(context.parentId);
      if (!existing || context.rerankScore > existing.rerankScore) {
        contextsByParent.set(context.parentId, context);
      }
    }
  }

  const contexts = [...contextsByParent.values()]
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .map((context, index) => ({ ...context, citationIndex: index + 1 }));

  const webResults = events
    .filter((event): event is Extract<AgentEvent, { kind: 'web_search' }> => event.kind === 'web_search')
    .flatMap((event) => event.results);

  return { events, trace, contexts, webResults };
}
