import { describe, expect, it } from "bun:test";
import {
  createSplitter,
  partialSuffix,
  OPEN,
  CLOSE,
} from "../../src/agent/thinking-splitter.ts";

describe("partialSuffix", () => {
  it("returns the longest non-full prefix-suffix of the tag", () => {
    expect(partialSuffix("hello <thin", OPEN)).toBe(5); // "<thin"
    expect(partialSuffix("hello <", OPEN)).toBe(1);
    expect(partialSuffix("hello ", OPEN)).toBe(0);
    expect(partialSuffix("<thinking>", OPEN)).toBe(0); // full match, not a partial
  });
});

describe("createSplitter", () => {
  it("routes an opening tag alone in one chunk", () => {
    const sp = createSplitter();
    const r1 = sp.push(`hi ${OPEN}reasoning here`);
    expect(r1.find((s) => s.kind === "text")?.text).toBe("hi ");
    expect(r1.find((s) => s.kind === "reasoning")?.text).toBe("reasoning here");
  });

  it("routes a closing tag alone in one chunk", () => {
    const sp = createSplitter();
    sp.push(`${OPEN}thought`);
    const r = sp.push(` more${CLOSE}answer`);
    const reasoningTexts = r.filter((s) => s.kind === "reasoning").map((s) => s.text).join("");
    const textTexts = r.filter((s) => s.kind === "text").map((s) => s.text).join("");
    expect(reasoningTexts).toBe(" more");
    expect(textTexts).toBe("answer");
  });

  it("buffers a tag split across two chunks", () => {
    const sp = createSplitter();
    const a = sp.push("hello <thin");
    // The "<thin" tail must be withheld — no text emitted past "hello ".
    expect(a.find((s) => s.kind === "text")?.text).toBe("hello ");
    const b = sp.push("king>thought");
    expect(b.filter((s) => s.kind === "reasoning").map((s) => s.text).join("")).toBe("thought");
  });

  it("emits reasoning followed by text in order", () => {
    const sp = createSplitter();
    const events = [
      ...sp.push(`${OPEN}why${CLOSE}`),
      ...sp.push("the answer"),
      ...sp.flush(),
    ];
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("reasoning");
    expect(kinds[1]).toBe("text");
    expect(events.find((e) => e.kind === "text")?.text).toBe("the answer");
  });

  it("plain content without thinking tags streams as text", () => {
    const sp = createSplitter();
    const events = [...sp.push("just an answer."), ...sp.flush()];
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ kind: "text", text: "just an answer." });
  });

  it("empty input yields nothing", () => {
    const sp = createSplitter();
    expect(sp.push("")).toEqual([]);
    expect(sp.flush()).toEqual([]);
  });

  it("flush releases withheld partial-tag buffer as text", () => {
    const sp = createSplitter();
    sp.push("end<thi");
    const flushed = sp.flush();
    const text = flushed.filter((s) => s.kind === "text").map((s) => s.text).join("");
    expect(text).toBe("<thi");
  });

  it("drops empty-whitespace text segments", () => {
    const sp = createSplitter();
    const r = [...sp.push("   "), ...sp.flush()];
    expect(r).toEqual([]);
  });
});
