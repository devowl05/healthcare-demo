/**
 * Per-request model selection.
 *
 * The router collapses two orthogonal flags into a single concrete model id:
 *   - `cheap`            — the user passed `?cheap=1` on a single chat call.
 *   - `conversationCheap` — the conversation row has `cheap_mode = true`.
 *
 * Either flag routes us to `OPENAI_BUDGET_MODEL`; otherwise we use the primary
 * `OPENAI_MODEL`. We don't read these flags here — the caller decides — so
 * this stays trivially testable and providers can introduce new tiers later.
 */

import { env } from "../env.ts";

export interface ModelChoiceInput {
  cheap?: boolean;
  conversationCheap?: boolean;
}

export function chooseModel(input: ModelChoiceInput): string {
  if (input.cheap || input.conversationCheap) return env.OPENAI_BUDGET_MODEL;
  return env.OPENAI_MODEL;
}
