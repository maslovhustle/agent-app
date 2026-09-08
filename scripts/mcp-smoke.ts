/**
 * MCP smoke test.
 *
 *   pnpm mcp:smoke
 *
 * Spawns the stdio server exactly the way a client would, completes the
 * handshake, and prints the advertised surface. Then it calls one tool for
 * real, which is the part that needs credentials and a populated corpus — if
 * that fails, the failure is reported rather than thrown, because the protocol
 * surface is worth verifying on its own.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', '--conditions=react-server', 'mcp/server.ts'],
    stderr: 'inherit',
  });

  const client = new Client({ name: 'mcp-smoke', version: '0.1.0' });
  await client.connect(transport);

  const info = client.getServerVersion();
  console.log(`\n✓ connected to ${info?.name} v${info?.version}`);

  const { tools } = await client.listTools();
  console.log(`\n✓ tools (${tools.length}):`);
  for (const tool of tools) {
    const input = Object.keys(
      (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    console.log(`   • ${tool.name}(${input.join(', ')})`);
    console.log(`     structured output: ${tool.outputSchema ? 'yes' : 'no'}`);
  }

  const { resourceTemplates } = await client.listResourceTemplates();
  console.log(`\n✓ resource templates (${resourceTemplates.length}):`);
  for (const template of resourceTemplates) {
    console.log(`   • ${template.uriTemplate}`);
  }

  await attempt('list resources', async () => {
    const { resources } = await client.listResources();
    for (const resource of resources) {
      console.log(`   • ${resource.uri} — ${resource.name}`);
    }
  });

  await attempt('read compliance://config', async () => {
    const result = await client.readResource({ uri: 'compliance://config' });
    console.log(textOf(result.contents).slice(0, 400));
  });

  await attempt('read compliance://corpus', async () => {
    const result = await client.readResource({ uri: 'compliance://corpus' });
    console.log(textOf(result.contents).slice(0, 600));
  });

  await attempt('call search_documents', async () => {
    const result = await client.callTool({
      name: 'search_documents',
      arguments: { query: 'data retention obligations', topK: 3 },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    console.log(String(content[0]?.text ?? '').slice(0, 800));
  });

  await client.close();
  console.log('\n✓ smoke test finished');
}

/** Resource contents are a text-or-blob union; this smoke test only reads text. */
function textOf(contents: readonly unknown[]): string {
  const first = contents[0];
  if (typeof first !== 'object' || first === null || !('text' in first)) return '';
  const { text } = first as { text: unknown };
  return typeof text === 'string' ? text : '';
}

/** Reports rather than throws: a dead corpus must not mask a working protocol. */
async function attempt(label: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n── ${label} ─────────────────────────────`);
  try {
    await fn();
  } catch (error) {
    console.log(`✗ ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main().catch((error: unknown) => {
  console.error('smoke test aborted:', error);
  process.exit(1);
});
