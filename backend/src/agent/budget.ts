/**
 * Token budgeting using `js-tiktoken` with the `o200k_base` encoding, which is
 * the tokenizer family used by every gpt-4o / gpt-5.x model we wire here.
 *
 * Pre-counts let us refuse a request *before* paying for it — see
 * `wouldExceedTurnCap()`. We don't try to be exact: structured tool calls and
 * system overhead add a small constant we approximate with `OVERHEAD_PER_MSG`.
 *
 * The encoder is created lazily and cached. It's pure JS (no WASM) so init is
 * cheap, but still — no reason to pay it twice.
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { ChatMessage, ContentBlock } from "./types.ts";

const OVERHEAD_PER_MSG = 4; // role + delimiters
const OVERHEAD_PER_TOOL_USE = 8; // id + name framing
const OVERHEAD_PER_TOOL_RESULT = 6;

let cached: Tiktoken | null = null;

function encoder(): Tiktoken {
  if (cached) return cached;
  cached = getEncoding("o200k_base");
  return cached;
}

function countString(s: string): number {
  if (!s) return 0;
  return encoder().encode(s).length;
}

function countBlock(b: ContentBlock): number {
  if (b.type === "text") return countString(b.text);
  if (b.type === "tool_use") {
    let n = OVERHEAD_PER_TOOL_USE + countString(b.name);
    try {
      n += countString(JSON.stringify(b.input ?? null));
    } catch {
      n += 4;
    }
    return n;
  }
  // tool_result
  return OVERHEAD_PER_TOOL_RESULT + countString(b.content);
}

export function estimateInputTokens(messages: ChatMessage[], _model: string): number {
  let total = 0;
  for (const m of messages) {
    total += OVERHEAD_PER_MSG;
    if (typeof m.content === "string") {
      total += countString(m.content);
    } else {
      for (const b of m.content) total += countBlock(b);
    }
  }
  return total;
}

export function wouldExceedTurnCap(
  estimated: number,
  maxOutput: number,
  capTotal: number,
): boolean {
  return estimated + Math.max(0, maxOutput) > capTotal;
}
