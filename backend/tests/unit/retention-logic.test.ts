/**
 * Unit tests for retention's pure date-cutoff helpers.
 *
 * The actual SQL execution is exercised in Tier 3 integration tests against a
 * real Postgres; here we only lock in the math.
 */

import { describe, expect, it } from "bun:test";
import { hardCutoff, softCutoff } from "../../src/jobs/retention";

const FIXED_NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("softCutoff", () => {
  it("returns now - retentionDays * 1 day", () => {
    const cutoff = softCutoff(30, FIXED_NOW);
    expect(cutoff.getTime()).toBe(FIXED_NOW.getTime() - 30 * DAY_MS);
  });

  it("0 days yields exactly now (everything is eligible)", () => {
    const cutoff = softCutoff(0, FIXED_NOW);
    expect(cutoff.getTime()).toBe(FIXED_NOW.getTime());
  });

  it("rejects negative retentionDays", () => {
    expect(() => softCutoff(-1, FIXED_NOW)).toThrow(RangeError);
  });

  it("rejects non-finite retentionDays", () => {
    expect(() => softCutoff(Number.NaN, FIXED_NOW)).toThrow(RangeError);
    expect(() => softCutoff(Number.POSITIVE_INFINITY, FIXED_NOW)).toThrow(RangeError);
  });

  it("uses the system clock when `now` is omitted", () => {
    const before = Date.now();
    const cutoff = softCutoff(1).getTime();
    const after = Date.now();
    expect(cutoff).toBeGreaterThanOrEqual(before - DAY_MS);
    expect(cutoff).toBeLessThanOrEqual(after - DAY_MS);
  });
});

describe("hardCutoff", () => {
  it("returns now - graceDays * 1 day", () => {
    const cutoff = hardCutoff(7, FIXED_NOW);
    expect(cutoff.getTime()).toBe(FIXED_NOW.getTime() - 7 * DAY_MS);
  });

  it("rejects negative graceDays", () => {
    expect(() => hardCutoff(-5, FIXED_NOW)).toThrow(RangeError);
  });

  it("is older than softCutoff for the same retention/grace pair", () => {
    // Conversations: soft after 90d, hard after another 30d (grace).
    // The soft cutoff is later (closer to "now") than the hard cutoff,
    // i.e. softCutoff(90) > hardCutoff(120) in time order. Here we just
    // confirm the same shape with explicit values.
    const soft = softCutoff(90, FIXED_NOW);
    const hard = hardCutoff(120, FIXED_NOW);
    expect(soft.getTime()).toBeGreaterThan(hard.getTime());
  });
});
