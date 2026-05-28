import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TOOL_REGISTRY } from "../../src/agent/tools.ts";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("tools.lookup_drug", () => {
  beforeEach(() => {
    // Default: each test sets its own stub.
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("formats a 200 response into Drug/Indications/Warnings/Source", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        results: [
          {
            openfda: { brand_name: ["Advil"], generic_name: ["ibuprofen"] },
            indications_and_usage: ["For relief of pain."],
            warnings: ["Do not exceed recommended dose."],
          },
        ],
      })) as unknown as typeof fetch;

    const tool = TOOL_REGISTRY["lookup_drug"]!;
    const out = await tool.execute({ name: "Advil" }, new AbortController().signal);
    expect(out).toContain("Drug: Advil (ibuprofen)");
    expect(out).toContain("Indications: For relief of pain.");
    expect(out).toContain("Warnings: Do not exceed recommended dose.");
    expect(out).toContain("Source: openFDA");
  });

  it("returns a clean 'not found' string on 404", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    const tool = TOOL_REGISTRY["lookup_drug"]!;
    const out = await tool.execute({ name: "Bogusol" }, new AbortController().signal);
    expect(out.toLowerCase()).toContain("no openfda label found");
    expect(out).toContain("Bogusol");
  });

  it("never throws on network errors — returns a stringified error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const tool = TOOL_REGISTRY["lookup_drug"]!;
    const out = await tool.execute({ name: "Advil" }, new AbortController().signal);
    expect(typeof out).toBe("string");
    expect(out.startsWith("lookup_drug:")).toBe(true);
    expect(out).toContain("ECONNREFUSED");
  });

  it("rejects empty input cleanly", async () => {
    const tool = TOOL_REGISTRY["lookup_drug"]!;
    const out = await tool.execute({ name: "" }, new AbortController().signal);
    expect(out).toContain("missing 'name'");
  });
});

describe("tools.check_symptoms", () => {
  it("matches sample inputs into a multi-line urgency report", async () => {
    const tool = TOOL_REGISTRY["check_symptoms"]!;
    const out = await tool.execute(
      { symptoms: ["I have chest pain and a cough"] },
      new AbortController().signal,
    );
    expect(out).toContain("Matched symptoms:");
    expect(out).toContain("OVERALL URGENCY: EMERGENCY");
    expect(out).toContain("Reminder: this is general information, not a diagnosis.");
  });

  it("returns the 'unknown' message for unrecognised symptoms", async () => {
    const tool = TOOL_REGISTRY["check_symptoms"]!;
    const out = await tool.execute(
      { symptoms: ["my left pinky tingles"] },
      new AbortController().signal,
    );
    expect(out).toContain("(none recognised");
    expect(out).toContain("OVERALL URGENCY: unknown");
  });
});
