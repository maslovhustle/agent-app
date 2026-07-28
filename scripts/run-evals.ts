/**
 * RAG evaluation harness.
 *
 *   pnpm evals                          # retrieval metrics only (cheap)
 *   pnpm evals -- --sweep child=200,300,400
 *
 * Requires a populated corpus and a `.env.local` with real credentials. This
 * is the loop the RAG tuner agent runs: change one hyperparameter, re-run,
 * compare hit rate and MRR, keep or revert.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { config as loadEnv } from 'dotenv';

// Type-only import: erased at compile time, so it cannot trigger the env
// schema evaluation that the lazy runtime imports below are guarding against.
import type { EvalCase } from '@/evals/metrics';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

async function main(): Promise<void> {
  // Imported lazily so that dotenv has already populated `process.env` before
  // the env schema is evaluated.
  const { hybridSearch } = await import('@/lib/ai/retrieval');
  const { getRagConfig } = await import('@/lib/env');
  const { aggregate, scoreCase } = await import('@/evals/metrics');

  const datasetPath = path.join(process.cwd(), 'evals', 'dataset.json');
  const raw = await readFile(datasetPath, 'utf8');
  const dataset = JSON.parse(raw) as { cases: EvalCase[] };

  const sweep = parseSweep(process.argv.slice(2));
  const baseConfig = getRagConfig();

  console.log('\n─── RAG evaluation ───────────────────────────────────────');
  console.log(`cases: ${dataset.cases.length}`);
  console.log(
    `config: parent=${baseConfig.parentChunkSize} child=${baseConfig.childChunkSize} ` +
      `k=${baseConfig.rrfK} candidates=${baseConfig.candidates} topN=${baseConfig.rerankTopN}`,
  );

  const variants =
    sweep.length > 0
      ? sweep.map((value) => ({ label: `childChunkSize=${value}`, overrides: { childChunkSize: value } }))
      : [{ label: 'baseline', overrides: {} }];

  for (const variant of variants) {
    console.log(`\n▸ ${variant.label}`);

    const results = [];

    for (const evalCase of dataset.cases) {
      try {
        const { contexts, stats } = await hybridSearch(evalCase.question, {
          overrides: variant.overrides,
        });
        const result = scoreCase(evalCase, contexts);
        results.push(result);

        console.log(
          `  ${result.hit ? '✓' : '✗'} ${evalCase.id.padEnd(30)} ` +
            `rank=${result.firstRelevantRank || '—'} ` +
            `recall=${result.recall.toFixed(2)} ` +
            `ctx=${result.retrievedCount} ` +
            `dense=${stats.denseHits} sparse=${stats.sparseHits} ` +
            `rerank=${stats.rerankApplied ? 'on' : 'off'}`,
        );
      } catch (error) {
        console.error(`  ! ${evalCase.id}: ${error instanceof Error ? error.message : error}`);
      }
    }

    const metrics = aggregate(results);
    console.log(
      `\n  hit rate ${(metrics.hitRate * 100).toFixed(1)}%  ` +
        `MRR ${metrics.mrr.toFixed(3)}  ` +
        `precision ${metrics.meanPrecision.toFixed(3)}  ` +
        `recall ${metrics.meanRecall.toFixed(3)}`,
    );
  }

  console.log('\n──────────────────────────────────────────────────────────\n');
}

/** Parses `--sweep child=200,300,400` into a list of child chunk sizes. */
function parseSweep(args: readonly string[]): number[] {
  const index = args.indexOf('--sweep');
  if (index === -1) return [];

  const spec = args[index + 1];
  if (!spec) return [];

  const [, values] = spec.split('=');
  if (!values) return [];

  return values
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

main().catch((error: unknown) => {
  console.error('\nEvaluation failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
