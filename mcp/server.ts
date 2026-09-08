import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config as loadEnv } from 'dotenv';

import { registerResources } from './resources';
import { registerTools } from './tools';

/**
 * MCP server for the compliance research agent — stdio transport, one process
 * per client.
 *
 * It is a thin adapter, deliberately. Every capability here already existed as
 * a typed function: `hybridSearch` for retrieval, the compiled LangGraph for
 * research, `ingestDocumentSource` for uploads. What MCP adds is a second
 * front door onto them, so a client agent gets the same verified answers the
 * web UI shows — including the ability to be told "no".
 *
 * Run it with `pnpm mcp`. The `--conditions=react-server` flag in that script
 * is load-bearing: the retrieval and graph modules are marked `server-only`,
 * a package whose sole job is to throw unless resolved under that condition.
 * It is the same mechanism Next.js uses, and `server-only` is the only
 * dependency in this tree that declares the condition, so nothing else in the
 * import graph resolves differently.
 */

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

async function main(): Promise<void> {
  // stdout IS the JSON-RPC channel on a stdio transport: one stray `console.log`
  // anywhere in the import graph corrupts the stream and the client drops the
  // connection with a parse error that points nowhere near the culprit. The
  // pipeline logs its degradations with `console.error` already; this makes
  // that the only possibility rather than a convention.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const server = new McpServer(
    { name: 'compliance-research-agent', version: '0.1.0' },
    {
      instructions:
        'Retrieval and research over a private compliance corpus.\n\n' +
        'Use `ask_with_citations` when you intend to act on or repeat the result: it runs a ' +
        'plan → retrieve → synthesize → verify graph and labels every answer with a grounding ' +
        'verdict, refusing outright when no claim can be traced to the corpus. Use ' +
        '`search_documents` when you want raw passages to reason over yourself — it performs ' +
        'no verification. Read `compliance://corpus` to see what is indexed and ' +
        '`compliance://config` to see whether reranking is active.',
    },
  );

  registerTools(server);
  registerResources(server);

  await server.connect(new StdioServerTransport());

  // stderr is safe, and is where a client shows server diagnostics.
  console.error('[mcp] compliance-research-agent ready on stdio');
}

main().catch((error: unknown) => {
  console.error('[mcp] fatal:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
