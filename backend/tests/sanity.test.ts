import { describe, expect, it } from "bun:test";

describe("sanity", () => {
  it("runtime is alive", () => {
    expect(1 + 1).toBe(2);
  });
});
