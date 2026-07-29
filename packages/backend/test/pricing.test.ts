import { describe, expect, it } from 'vitest';

import { costForTokens, MODEL_RATES } from '../src/pricing.js';

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

  it('clamps cached tokens reported outside the input count', () => {
    // Adapters normalize cache reads into inputTokens; if one ever slips out of
    // that convention the clamp prices zero fresh tokens, never a negative count.
    expect(costForTokens('gpt-5.5', 109, 3, 15_104)).toBe(costForTokens('gpt-5.5', 109, 3, 109));
  });

  it('returns null for a model the table does not list', () => {
    expect(costForTokens('gpt-6-codex-preview', 1_000, 100)).toBeNull();
    expect(MODEL_RATES['gpt-6-codex-preview']).toBeUndefined();
  });
});
