import { describe, expect, it } from "bun:test";
import { matchSymptoms } from "../../src/agent/symptoms.ts";

describe("matchSymptoms", () => {
  it("classifies chest pain as an emergency", () => {
    const r = matchSymptoms(["I have severe chest pain"]);
    expect(r.urgency).toBe("emergency");
    expect(r.matched).toContain("chest pain");
    expect(r.bullets.length).toBeGreaterThan(0);
  });

  it("classifies a fever alone as medium", () => {
    const r = matchSymptoms(["fever"]);
    expect(r.urgency).toBe("medium");
    expect(r.matched).toContain("fever");
  });

  it("uses the highest urgency when multiple symptoms match", () => {
    const r = matchSymptoms(["I have a cough", "and shortness of breath"]);
    expect(r.urgency).toBe("emergency");
  });

  it("returns empty matched + 'none' urgency for unknown symptoms", () => {
    const r = matchSymptoms(["my elbow tingles"]);
    expect(r.matched).toEqual([]);
    expect(r.urgency).toBe("none");
    expect(r.bullets).toEqual([]);
  });

  it("handles empty / non-string inputs without throwing", () => {
    const r = matchSymptoms([]);
    expect(r.matched).toEqual([]);
    expect(r.urgency).toBe("none");
  });
});
