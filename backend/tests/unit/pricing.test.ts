import { describe, expect, it } from "bun:test";
import { estimateCostUsd, PRICING } from "../../src/agent/pricing.ts";

describe("estimateCostUsd", () => {
  it("computes gpt-5.2 input + output cost correctly", () => {
    // 1M input @ $1.25 + 1M output @ $10 = $11.25
    expect(estimateCostUsd("gpt-5.2", 1_000_000, 1_000_000)).toBeCloseTo(11.25, 6);

    // 1000 input + 500 output: 1.25*1000/1e6 + 10*500/1e6 = 0.00125 + 0.005 = 0.00625
    expect(estimateCostUsd("gpt-5.2", 1_000, 500)).toBeCloseTo(0.00625, 6);
  });

  it("bills cached input tokens at half the input rate", () => {
    // 1000 input total, 1000 of which were cached. cost = 1000 * 1.25 * 0.5 / 1e6 = 0.000625
    expect(estimateCostUsd("gpt-5.2", 1_000, 0, 1_000)).toBeCloseTo(0.000625, 6);
  });

  it("returns 0 silently for unknown models", () => {
    expect(estimateCostUsd("imaginary-future-model", 999_999, 999_999)).toBe(0);
  });

  it("rounds to 6 decimal places", () => {
    const v = estimateCostUsd("gpt-4o-mini", 7, 11);
    expect(Number.isFinite(v)).toBe(true);
    // No more than 6 decimals.
    expect(v.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(6);
  });

  it("clamps negative token counts to 0", () => {
    expect(estimateCostUsd("gpt-5.2", -100, -100)).toBe(0);
  });

  it("includes all required May 2026 rows", () => {
    for (const m of [
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-4o",
      "gpt-4o-mini",
    ]) {
      expect(PRICING[m]).toBeDefined();
    }
  });
});
