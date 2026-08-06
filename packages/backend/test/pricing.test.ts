import { describe, expect, it } from 'vitest';

import { ROSTER_MODELS } from '../src/contract.js';
import { costForModelUsage, costForTokens, MODEL_RATES } from '../src/pricing.js';

describe('costForTokens', () => {
  it('prices the docker-duel codex model at its list rates', () => {
    // 1M fresh input at $5/M, 1M output at $30/M, no cache in play.
    expect(costForTokens('gpt-5.5', 1_000_000, 1_000_000)).toBe(35);
  });

  it('charges cached prompt tokens at the cached rate', () => {
    // The sampled codex turn: 36,126 prompt tokens, 27,136 of them cached.
    const cacheAware = costForTokens('gpt-5.5', 36_126, 126, 27_136);
    const asIfAllFresh = costForTokens('gpt-5.5', 36_126, 126);

    expect(cacheAware).toBe(0.062298);
    // Ignoring the cache would treble the turn — the reason cost tracks it.
    expect(asIfAllFresh).toBe(0.18441);
  });

  it('prices the captured Claude usage with fresh, cached, and output rates', () => {
    expect(costForTokens('claude-opus-5', 63_196, 88, 46_817)).toBe(0.107504);
  });

  it('clamps cached tokens reported outside the input count', () => {
    // Adapters normalize cache reads into inputTokens; if one ever slips out of
    // that convention the clamp prices zero fresh tokens, never a negative count.
    expect(costForTokens('gpt-5.5', 109, 3, 15_104)).toBe(costForTokens('gpt-5.5', 109, 3, 109));
  });

  it('returns null for a model the table does not list', () => {
    expect(costForTokens('gpt-6-codex-preview', 1_000, 100)).toBeNull();
    expect(MODEL_RATES['gpt-6-codex-preview']).toBeUndefined();
  });

  it('prices a delegated turn per model, not at the entrant rate', () => {
    const opus = { model: 'claude-opus-5', inputTokens: 5_010, outputTokens: 1_000, cachedInputTokens: 4_000 };
    const sonnet = { model: 'claude-sonnet-5', inputTokens: 5_000, outputTokens: 2_000, cachedInputTokens: 5_000 };

    expect(costForModelUsage([opus, sonnet], 'claude-opus-5')).toBe(0.06355);
    // The same tokens billed wholly at opus, which is what the aggregate did.
    expect(costForTokens('claude-opus-5', 10_010, 3_000, 9_000)).toBe(0.08455);
  });

  it('falls back to the entrant rate for a model the table does not list', () => {
    const rows = [
      { model: 'claude-opus-5', inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 0 },
      { model: 'claude-haiku-9-9', inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 0 },
    ];

    expect(costForModelUsage(rows, 'claude-opus-5')).toBe(costForTokens('claude-opus-5', 2_000, 200));
    // An unlisted row with no entrant rate behind it drops the whole figure,
    // rather than reporting a total that silently omits those tokens.
    expect(costForModelUsage(rows, 'claude-mystery-9')).toBeNull();
  });

  it('returns null without rows to price', () => {
    expect(costForModelUsage([], 'claude-opus-5')).toBeNull();
  });

  it('has a rate for every codex and claude roster model', () => {
    // OpenCode entrants report their own cost from OpenRouter, so its roster
    // models price without a table row. Codex and claude rely on the table.
    for (const model of [...ROSTER_MODELS.codex, ...ROSTER_MODELS.claude]) {
      expect(MODEL_RATES[model], `missing rate for ${model}`).toBeDefined();
    }
  });
});
