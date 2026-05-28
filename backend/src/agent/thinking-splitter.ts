/**
 * Streaming `<thinking>...</thinking>` router.
 *
 * The model emits its chain-of-thought wrapped in tags (see `prompt.ts`). We
 * split a token stream into two channels — `reasoning` (inside the tags) and
 * `text` (outside) — without ever buffering more than one tag's worth.
 *
 * Tags can split across SSE chunks (`"<thin"` then `"king>"`), so we hold back
 * any trailing suffix that *could* be the start of an open/close tag and emit
 * it only once disambiguated. State machine:
 *
 *   scan    — outside any tag; on `<thinking>` → think (drops the tag).
 *   think   — inside; on `</thinking>` → answer (drops the tag).
 *   answer  — post-thinking text. (Stays in this state — we never re-open.)
 *
 * Empty-whitespace text segments are dropped to avoid noise; reasoning is
 * preserved verbatim because trailing spaces inside it carry meaning to the
 * UI's italic stream.
 */

export const OPEN = "<thinking>";
export const CLOSE = "</thinking>";

export type Segment = { kind: "text" | "reasoning"; text: string };
type State = "scan" | "think" | "answer";

/**
 * Returns the longest suffix of `s` that is also a non-full prefix of `tag`.
 * Used to decide how much of the buffer we must hold back in case the next
 * chunk completes a tag. We never return the full tag length — that would
 * mean a tag we've already located but failed to act on.
 */
export function partialSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

export interface Splitter {
  push(chunk: string): Segment[];
  flush(): Segment[];
}

export function createSplitter(): Splitter {
  let state: State = "scan";
  let buf = "";

  function emitText(out: Segment[], text: string): void {
    if (text.length === 0) return;
    if (text.trim().length === 0) return;
    out.push({ kind: "text", text });
  }

  function emitReasoning(out: Segment[], text: string): void {
    if (text.length === 0) return;
    out.push({ kind: "reasoning", text });
  }

  /**
   * Drains `buf` according to the current state. Repeats until no transition
   * is possible without more input. On exit, `buf` contains only the held-back
   * tail (the partial-tag suffix).
   */
  function drain(out: Segment[], holdBackPartial: boolean): void {
    // Loop until we either consume a tag or can't make progress.
    // Each iteration either transitions state or returns.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (state === "scan") {
        const idx = buf.indexOf(OPEN);
        if (idx !== -1) {
          emitText(out, buf.slice(0, idx));
          buf = buf.slice(idx + OPEN.length);
          state = "think";
          continue;
        }
        const hold = holdBackPartial ? partialSuffix(buf, OPEN) : 0;
        emitText(out, buf.slice(0, buf.length - hold));
        buf = buf.slice(buf.length - hold);
        return;
      }
      if (state === "think") {
        const idx = buf.indexOf(CLOSE);
        if (idx !== -1) {
          emitReasoning(out, buf.slice(0, idx));
          buf = buf.slice(idx + CLOSE.length);
          state = "answer";
          continue;
        }
        const hold = holdBackPartial ? partialSuffix(buf, CLOSE) : 0;
        emitReasoning(out, buf.slice(0, buf.length - hold));
        buf = buf.slice(buf.length - hold);
        return;
      }
      // state === "answer": no more tags expected, treat everything as text.
      emitText(out, buf);
      buf = "";
      return;
    }
  }

  return {
    push(chunk: string): Segment[] {
      if (!chunk) return [];
      buf += chunk;
      const out: Segment[] = [];
      drain(out, true);
      return out;
    },
    flush(): Segment[] {
      const out: Segment[] = [];
      drain(out, false);
      return out;
    },
  };
}
