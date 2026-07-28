// Token→price table, used only when a harness reports tokens without a price.
// opencode via OpenRouter prices every step itself, so its cost passes through
// untouched; codex on a ChatGPT-account login never reports one, so its cost is
// derived here — and stays null for any model missing from the table. Cost is
// display only (scoring is on-chain flags), so a missing rate costs nothing but
// an empty field.
//
// Rates are USD per million tokens at list price, read July 2026. Cached input
// matters: a codex turn is mostly repeated context (three quarters of the sample
// turn in test/fixtures), and cached input bills at a tenth of fresh input, so
// pricing every prompt token at the full rate overstates a turn about threefold.

export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
}

export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  'gpt-5-codex': { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  'gpt-5.5': { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
};

// cachedInputTokens are the prompt tokens served from cache, counted inside
// inputTokens the way codex reports them. A harness that reports them alongside
// its input count instead cannot go negative here — it clamps at zero.
export function costForTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number | null {
  const rate = MODEL_RATES[model];
  if (rate === undefined) return null;
  const cached = Math.min(cachedInputTokens, inputTokens);
  const fresh = inputTokens - cached;
  return roundUsd(
    (fresh * rate.inputPerMillion
      + cached * rate.cachedInputPerMillion
      + outputTokens * rate.outputPerMillion) / 1_000_000,
  );
}

// Six decimals: a single cheap turn still registers, and summed floats do not
// drift into 0.30000000000000004 territory in the snapshot.
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
