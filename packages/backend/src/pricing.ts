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
  'gpt-5.6-sol': { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
  'claude-opus-5': { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
  // Not a roster model: claude's Task subagents run on it, and their tokens land
  // in the delegating entrant's modelUsage (#38).
  'claude-haiku-4-5': { inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 5 },
  'claude-fable-5': { inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 50 },
};

// cachedInputTokens are the prompt tokens served from cache, counted inside
// inputTokens — the shape the adapters normalize to. The clamp guards against a
// harness that slips out of that convention rather than pricing negative tokens.
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

// Same token convention as costForTokens: cachedInputTokens sit inside inputTokens.
export interface ModelTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

// A harness that breaks a turn down per model — claude reports one row per model
// the turn touched, subagents included — gets each row priced at its own rate,
// so an opus entrant that delegates to sonnet no longer bills the delegated
// tokens at the opus rate. A row for a model the table does not list falls back
// to the entrant's own rate: its tokens are real, and the entrant's row is the
// closest figure available. Null when nothing can be priced, same as the
// aggregate path — an entrant on an unlisted model keeps an empty cost field.
export function costForModelUsage(
  rows: readonly ModelTokenUsage[],
  entrantModel: string,
): number | null {
  if (rows.length === 0) return null;

  let total = 0;
  for (const row of rows) {
    const cost = costForTokens(row.model, row.inputTokens, row.outputTokens, row.cachedInputTokens)
      ?? costForTokens(entrantModel, row.inputTokens, row.outputTokens, row.cachedInputTokens);
    if (cost === null) return null;
    total += cost;
  }
  return roundUsd(total);
}

// Six decimals: a single cheap turn still registers, and summed floats do not
// drift into 0.30000000000000004 territory in the snapshot.
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
