/**
 * Defensive normalization of strings that originated outside our process —
 * tool outputs, fetched HTML, user-supplied snippets. Three goals:
 *
 *   1. Strip ASCII control characters (except `\n` and `\t`) so a tool can't
 *      slip ANSI escapes or BOM-like control sequences into our SSE stream.
 *   2. NFKC-normalize so visually identical compatibility characters compare
 *      equal and don't bypass downstream filters.
 *   3. Drop zero-width characters (ZWSP/ZWJ/ZWNJ/WJ/BOM) which can hide prompt
 *      injection or smuggle tokens past keyword filters.
 *
 * Markdown links are *escaped* rather than removed: `[label](url)` becomes
 * `[label]​(url)` (with a zero-width-space we explicitly DIDN'T strip first —
 * we insert it after stripping, on the safe side). This keeps the rendered
 * output readable while making it un-clickable, blunting injected
 * `[click here](malicious://...)` payloads.
 */

const CAP_DEFAULT = 4096;
const TRUNC = "…[truncated]";

// Zero-width and BOM characters we drop unconditionally.
const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

// ASCII control chars: 0x00-0x1F and 0x7F, EXCEPT \n (0x0A) and \t (0x09).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0B-\x1F\x7F]/g;

// Match a markdown link or autolink-style construct of the form `[text](url)`.
// Lazy text + non-greedy URL — we intentionally don't validate the URL.
const MD_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;

export function sanitizeToolOutput(s: string, cap: number = CAP_DEFAULT): string {
  if (typeof s !== "string") s = String(s ?? "");

  // 1. Drop zero-width chars BEFORE NFKC: some compatibility decompositions
  //    can introduce new combining marks we'd rather not see.
  let out = s.replace(ZERO_WIDTH, "");

  // 2. NFKC normalize (handles fullwidth ASCII look-alikes, etc.).
  try {
    out = out.normalize("NFKC");
  } catch {
    // Pathological inputs can throw on some runtimes; carry on with raw text.
  }

  // 3. Strip control chars (keep \n, \t).
  out = out.replace(CONTROL, "");

  // 4. Defang markdown links. The ZWSP we insert is invisible but prevents
  //    `]` and `(` from forming the link token in a renderer.
  out = out.replace(MD_LINK, "[$1]​($2)");

  // 5. Cap. Reserve room for the truncation marker so we never grow past cap.
  if (out.length > cap) {
    const room = Math.max(0, cap - TRUNC.length);
    out = out.slice(0, room) + TRUNC;
  }

  return out;
}
