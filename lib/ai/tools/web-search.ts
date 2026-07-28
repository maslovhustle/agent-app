import 'server-only';

import { getEnv } from '@/lib/env';
import type { WebSearchResult } from '@/lib/types';

/**
 * Web search fallback.
 *
 * The agent reaches for this only when the local corpus is thin — a
 * compliance question about a regulation nobody uploaded, or one whose answer
 * post-dates the ingested documents.
 *
 * Without a TAVILY_API_KEY the tool returns clearly-labelled mock results
 * (`isMock: true`) that say so in the snippet text. That distinction is
 * deliberate: a demo that fabricates plausible-looking sources teaches the
 * wrong lesson about what the system actually knows, and the synthesis prompt
 * is told to treat mock results as "no external evidence available".
 */

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

export async function webSearch(query: string, maxResults = 4): Promise<WebSearchResult[]> {
  const env = getEnv();

  if (!env.TAVILY_API_KEY) {
    return mockResults(query);
  }

  try {
    const response = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        max_results: maxResults,
        search_depth: 'advanced',
        include_answer: false,
      }),
      // Web search is a fallback, not the critical path — cap the wait.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Tavily responded ${response.status}`);
    }

    const payload = (await response.json()) as TavilyResponse;

    return (payload.results ?? []).slice(0, maxResults).map((result) => ({
      title: result.title ?? 'Untitled',
      url: result.url ?? '',
      snippet: result.content ?? '',
      isMock: false,
    }));
  } catch (error) {
    console.error('[web-search] Tavily request failed, returning mock results', error);
    return mockResults(query);
  }
}

function mockResults(query: string): WebSearchResult[] {
  return [
    {
      title: `No external search provider configured`,
      url: '',
      snippet:
        `Web search was requested for "${query}" but TAVILY_API_KEY is not set, so no ` +
        `external sources were consulted. Treat this as "no external evidence available" ` +
        `rather than as a search result.`,
      isMock: true,
    },
  ];
}

export function formatWebResultsForPrompt(results: readonly WebSearchResult[]): string {
  if (results.length === 0) return 'No web results.';

  if (results.every((result) => result.isMock)) {
    return (
      'WEB SEARCH UNAVAILABLE: no external search provider is configured. ' +
      'No external evidence was retrieved — do not invent any.'
    );
  }

  return results
    .filter((result) => !result.isMock)
    .map((result, index) => `(W${index + 1}) ${result.title} — ${result.url}\n${result.snippet}`)
    .join('\n\n');
}
