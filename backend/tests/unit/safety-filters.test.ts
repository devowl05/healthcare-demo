import { describe, expect, it } from "bun:test";
import {
  crisisPrependSystemMessage,
  detectCrisis,
} from "../../src/agent/safety-filters.ts";

describe("detectCrisis", () => {
  it("triggers on direct self-harm phrasing", () => {
    expect(detectCrisis("I want to kill myself").triggered).toBe(true);
    expect(detectCrisis("end my life tonight").triggered).toBe(true);
    expect(detectCrisis("might overdose on something").triggered).toBe(true);
    expect(detectCrisis("thinking about suicide").triggered).toBe(true);
  });

  it("does NOT trigger on benign 'dying' phrasing", () => {
    expect(detectCrisis("dying of laughter at this meme").triggered).toBe(false);
    expect(detectCrisis("I'm dying to try the new place").triggered).toBe(false);
  });

  it("returns the matched categories", () => {
    const r = detectCrisis("thinking about suicide and want to hurt myself");
    expect(r.triggered).toBe(true);
    expect(r.categories).toContain("suicide");
    expect(r.categories).toContain("self_harm");
  });

  it("handles empty / non-string input safely", () => {
    expect(detectCrisis("").triggered).toBe(false);
    // @ts-expect-error testing runtime behavior
    expect(detectCrisis(undefined).triggered).toBe(false);
  });
});

describe("crisisPrependSystemMessage", () => {
  it("includes 988 and a localized escalation hint", () => {
    const s = crisisPrependSystemMessage();
    expect(s).toContain("988");
    expect(s.toLowerCase()).toContain("emergency");
  });
});
