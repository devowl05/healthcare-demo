import { describe, expect, it } from "bun:test";
import { sanitizeToolOutput } from "../../src/agent/tool-sanitize.ts";

describe("sanitizeToolOutput", () => {
  it("strips ASCII control characters except \\n and \\t", () => {
    const input = "hello\x00world\x07!\nkeep\there";
    const out = sanitizeToolOutput(input);
    expect(out).toBe("helloworld!\nkeep\there");
  });

  it("escapes markdown links so they aren't clickable", () => {
    const out = sanitizeToolOutput("click [me](https://evil.example)");
    expect(out).not.toMatch(/\]\(https:\/\/evil/);
    expect(out).toContain("[me]");
    expect(out).toContain("(https://evil.example)");
  });

  it("caps long input and appends the truncation marker", () => {
    const big = "a".repeat(10_000);
    const out = sanitizeToolOutput(big, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("NFKC-normalizes fullwidth ASCII look-alikes", () => {
    const input = "ＡＢＣ"; // fullwidth ABC
    const out = sanitizeToolOutput(input);
    expect(out).toBe("ABC");
  });

  it("drops zero-width characters", () => {
    const input = "no​zero‌width‍here﻿";
    const out = sanitizeToolOutput(input);
    expect(out).toBe("nozerowidthhere");
  });

  it("non-string input is coerced safely", () => {
    // @ts-expect-error testing runtime behavior
    expect(sanitizeToolOutput(undefined)).toBe("");
  });
});
