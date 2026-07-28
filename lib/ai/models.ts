import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { EmbeddingModel, LanguageModel } from 'ai';

import { getEnv } from '@/lib/env';

/**
 * Central model registry.
 *
 * Nodes ask for a *role* ("the model that plans", "the model that verifies")
 * rather than naming a checkpoint. Swapping providers or downgrading the
 * verifier to something cheaper is then a one-line change here instead of a
 * grep across the graph.
 */

export const EMBEDDING_MODEL_ID = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

const OPENAI_MODELS = {
  reasoning: 'gpt-4o',
  fast: 'gpt-4o-mini',
} as const;

const ANTHROPIC_MODELS = {
  reasoning: 'claude-sonnet-4-5',
  fast: 'claude-haiku-4-5',
} as const;

export type ModelRole = 'planner' | 'synthesizer' | 'verifier';

/**
 * Planning and verification are classification-shaped tasks with small
 * outputs, so they run on the fast tier. Synthesis is where answer quality is
 * decided, so it gets the reasoning tier.
 */
const ROLE_TIER: Record<ModelRole, 'reasoning' | 'fast'> = {
  planner: 'fast',
  synthesizer: 'reasoning',
  verifier: 'fast',
};

export function getModel(role: ModelRole): LanguageModel {
  const env = getEnv();
  const tier = ROLE_TIER[role];

  if (env.AGENT_PROVIDER === 'anthropic') {
    return anthropic(ANTHROPIC_MODELS[tier]);
  }
  return openai(OPENAI_MODELS[tier]);
}

export function getModelId(role: ModelRole): string {
  const env = getEnv();
  const tier = ROLE_TIER[role];
  return env.AGENT_PROVIDER === 'anthropic' ? ANTHROPIC_MODELS[tier] : OPENAI_MODELS[tier];
}

export function getEmbeddingModel(): EmbeddingModel<string> {
  return openai.textEmbeddingModel(EMBEDDING_MODEL_ID);
}

/**
 * Published per-million-token prices, used to turn a usage report into a
 * dollar figure for the trace drawer. Keep in sync with provider pricing; the
 * number is an estimate shown to developers, not a billing record.
 */
const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  [EMBEDDING_MODEL_ID]: { input: 0.02, output: 0 },
};

export function estimateCostUsd(
  modelId: string,
  promptTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING_USD_PER_MTOK[modelId];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
