/**
 * USD-per-1M-tokens pricing map (May 2026 rates) + cost estimator.
 *
 * Reads:
 *   - `input` / `output` are dollars per 1,000,000 tokens
 *   - `cached_input_tokens` (from OpenAI's `prompt_tokens_details.cached_tokens`)
 *     is billed at 0.5× the `input` rate
 *
 * Unknown model names silently return `$0` — the agent loop must never throw
 * on cost rounding. Result is rounded to 6 decimals to match the
 * `NUMERIC(12,6)` column in `usage_records`.
 */

export interface PriceRow {
  input: number;
  output: number;
}

export const PRICING: Record<string, PriceRow> = {
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.2": { input: 1.25, output: 10 },
  "gpt-5.2-codex": { input: 1.75, output: 14 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

const MILLION = 1_000_000;

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
): number {
  const row = PRICING[model];
  if (!row) return 0;

  const safeIn = Math.max(0, inputTokens | 0);
  const safeOut = Math.max(0, outputTokens | 0);
  const safeCached = Math.max(0, Math.min(cachedInputTokens | 0, safeIn));
  const billableIn = safeIn - safeCached;

  const cost =
    (billableIn * row.input) / MILLION +
    (safeCached * row.input * 0.5) / MILLION +
    (safeOut * row.output) / MILLION;

  return round6(cost);
}
