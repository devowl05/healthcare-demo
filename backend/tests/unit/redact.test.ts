import { describe, expect, it } from "bun:test";
import { redactForLogs, redactJson } from "../../src/obs/redact";

describe("redactForLogs", () => {
  it("redacts SSNs", () => {
    const out = redactForLogs("patient SSN 123-45-6789 noted");
    expect(out).toMatch(/\[REDACTED:SSN:[0-9a-f]{6}\]/);
    expect(out).not.toContain("123-45-6789");
  });

  it("redacts emails", () => {
    const out = redactForLogs("contact alice@example.com today");
    expect(out).toMatch(/\[REDACTED:EMAIL:[0-9a-f]{6}\]/);
    expect(out).not.toContain("alice@example.com");
  });

  it("redacts US phone numbers", () => {
    const out = redactForLogs("call +1 (415) 555-2671");
    expect(out).toMatch(/\[REDACTED:PHONE:[0-9a-f]{6}\]/);
    expect(out).not.toContain("415");
  });

  it("redacts DOBs", () => {
    const out = redactForLogs("DOB 1985-07-23 enrolled");
    expect(out).toMatch(/\[REDACTED:DOB:[0-9a-f]{6}\]/);
    expect(out).not.toContain("1985-07-23");
  });

  it("redacts MRNs with the MRN: prefix", () => {
    const out = redactForLogs("see MRN: ABC123456");
    expect(out).toMatch(/\[REDACTED:MRN:[0-9a-f]{6}\]/);
    expect(out).not.toContain("ABC123456");
  });

  it("redacts Luhn-valid credit cards but ignores invalid 16-digit strings", () => {
    // 4111-1111-1111-1111 is a famous test card that passes Luhn.
    const validCard = redactForLogs("paid with 4111-1111-1111-1111 last night");
    expect(validCard).toMatch(/\[REDACTED:CC:[0-9a-f]{6}\]/);
    expect(validCard).not.toContain("4111");

    // Same digits +1 in the last group → Luhn-fail; pattern matches but the
    // validator rejects. Result must still contain the digits unredacted.
    const invalidCard = redactForLogs("order id 4111-1111-1111-1112");
    expect(invalidCard).toContain("4111-1111-1111-1112");
  });

  it("is idempotent: redacting an already redacted string is a no-op", () => {
    const first = redactForLogs("contact bob@example.com");
    const second = redactForLogs(first);
    expect(second).toBe(first);
  });

  it("produces the same fingerprint for repeated occurrences of the same value", () => {
    const out = redactForLogs("emails alice@example.com and alice@example.com appear twice");
    const matches = out.match(/\[REDACTED:EMAIL:[0-9a-f]{6}\]/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe(matches[1]!);
  });
});

describe("redactJson", () => {
  it("redacts string leaves in nested objects + arrays", () => {
    const input = {
      user: { email: "alice@example.com", name: "Alice" },
      messages: [{ content: "call me at 415-555-2671" }, { content: "no PII here" }],
      meta: { ok: true, count: 3 },
    };
    const out = redactJson(input);
    expect(out.user.email).toMatch(/\[REDACTED:EMAIL:/);
    expect(out.user.name).toBe("Alice");
    expect(out.messages[0]!.content).toMatch(/\[REDACTED:PHONE:/);
    expect(out.messages[1]!.content).toBe("no PII here");
    expect(out.meta.ok).toBe(true);
    expect(out.meta.count).toBe(3);
    // input must be untouched
    expect(input.user.email).toBe("alice@example.com");
  });

  it("does not crash on circular references", () => {
    const a: Record<string, unknown> = { email: "x@y.com" };
    a.self = a;
    const out = redactJson(a) as Record<string, unknown>;
    expect(out.email).toMatch(/\[REDACTED:EMAIL:/);
  });

  it("passes through primitives unchanged", () => {
    expect(redactJson(42)).toBe(42);
    expect(redactJson(null)).toBe(null);
    expect(redactJson(true)).toBe(true);
  });
});
