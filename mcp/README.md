# MCP server

Exposes the compliance research agent over the [Model Context Protocol](https://modelcontextprotocol.io),
so any MCP client — Claude Desktop, Claude Code, an agent you wrote yourself — can search
the corpus and ask it questions.

```bash
pnpm mcp
```

## Why this one is different

Most RAG MCP servers expose bare vector similarity: a client agent gets passages back, or
prose synthesised from them, and has no way to tell whether either is trustworthy. It has
to decide for itself, from text that always reads confident.

This server's `ask_with_citations` runs the full graph — **plan → retrieve → optional web
search → synthesize → verify** — so what comes back has already been checked against the
evidence it cites. Every answer carries a grounding verdict, and when nothing in the draft
can be traced to the corpus the tool **refuses**: `answer` is `null`, and the ungrounded
draft is quarantined on `withheldDraft` where it cannot be mistaken for a result.

That is the capability an agent-to-agent protocol is usually missing. A tool that can say
"I don't know" is worth more than one that always answers.

## Tools

| Tool | Wraps | Returns |
|---|---|---|
| `search_documents(query, topK?, documentIds?)` | `hybridSearch()` | Ranked passages + retrieval telemetry. No synthesis, no verification. |
| `ask_with_citations(question, documentIds?)` | the compiled LangGraph | Verified answer, citations, grounding verdict, plan, node timings, cost. |
| `ingest_document(path \| content + filename)` | `ingestDocumentSource()` | Document id; chunking and embedding are queued on Inngest. |

Every tool declares an `outputSchema`, so clients get validated `structuredContent`
alongside the human-readable text block.

### Scores mean different things

`search_documents` returns a `scoreKind` per passage. When Cohere is unavailable the
pipeline degrades to fusion ordering, and `rerankScore` falls back to the RRF score —
a rank artefact, not calibrated relevance. Threshold `rerank` scores; never threshold
`rrf` ones. Read `compliance://config` to see which you are getting before you rely on it.

## Resources

The corpus is exposed as resources rather than tools, because listing documents and
reading one are the client's own bookkeeping — modelling them as tools would spend a round
trip of model reasoning on each.

| URI | Contents |
|---|---|
| `compliance://corpus` | Every document with indexing status and chunk counts. Only `ready` documents are searchable. |
| `compliance://config` | Live retrieval hyperparameters and which optional dependencies are actually configured. |
| `compliance://document/{documentId}` | One document's extracted source text, as handed to the chunker. |

## Client setup

Claude Desktop (`claude_desktop_config.json`) or any other stdio client:

```json
{
  "mcpServers": {
    "compliance-research": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/agent-app", "mcp"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add compliance-research -- pnpm --dir /absolute/path/to/agent-app mcp
```

Credentials come from `.env.local` in the project directory, the same file the web app
uses — the server loads it at startup, so there is nothing extra to configure.

Verify the wiring without a client:

```bash
pnpm mcp:smoke
```

## Two implementation details worth knowing

**`--conditions=react-server` is load-bearing.** The retrieval and graph modules are marked
`server-only`, a package whose entire job is to throw unless resolved under that condition.
The flag is how Next.js resolves it too, and `server-only` is the only dependency in this
tree that declares the condition — so nothing else in the import graph resolves differently.
Drop the flag and the server dies on its first import.

**stdout is the JSON-RPC channel.** On a stdio transport a single stray `console.log`
anywhere in the import graph corrupts the stream, and the client drops the connection with
a parse error pointing nowhere near the culprit. `mcp/server.ts` redirects `console.log`,
`.info` and `.debug` to stderr so that failure mode is impossible rather than merely
avoided by convention.

## Security note

`ingest_document` reads files from the machine the server runs on, at the calling agent's
request. That is inherent to a local ingestion tool, but worth stating: the server runs with
your privileges and has no path allowlist. Run it against corpora and clients you trust.
