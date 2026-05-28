import { describe, expect, it } from "bun:test";
import { hashChain, hashPassword, hmacSha256, verifyPassword } from "../../src/lib/crypto";

describe("argon2 password helpers", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
    const ok = await verifyPassword(hash, "correct horse battery staple");
    expect(ok).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("the-real-password");
    const ok = await verifyPassword(hash, "guess");
    expect(ok).toBe(false);
  });

  it("returns false (does not throw) on a malformed digest", async () => {
    const ok = await verifyPassword("not-a-valid-argon2-string", "anything");
    expect(ok).toBe(false);
  });

  it("rejects empty password on hash", async () => {
    await expect(hashPassword("")).rejects.toThrow(TypeError);
  });
});

describe("hmacSha256", () => {
  it("is deterministic for the same key+data", () => {
    expect(hmacSha256("k", "data")).toBe(hmacSha256("k", "data"));
  });
  it("changes when the key changes", () => {
    expect(hmacSha256("k1", "data")).not.toBe(hmacSha256("k2", "data"));
  });
  it("supports base64url encoding", () => {
    const out = hmacSha256("k", "data", "base64url");
    expect(out).not.toMatch(/[+/=]/);
  });
});

describe("hashChain", () => {
  it("is deterministic for the same inputs", () => {
    const prev = Buffer.alloc(32, 0);
    const a = hashChain(prev, '{"x":1}');
    const b = hashChain(prev, '{"x":1}');
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it("changes when the payload changes", () => {
    const prev = Buffer.alloc(32, 0);
    const a = hashChain(prev, '{"x":1}');
    const b = hashChain(prev, '{"x":2}');
    expect(a.equals(b)).toBe(false);
  });

  it("changes when the previous-hash changes", () => {
    const a = hashChain(Buffer.alloc(32, 0), "p");
    const b = hashChain(Buffer.alloc(32, 1), "p");
    expect(a.equals(b)).toBe(false);
  });

  it("propagates: changing an early row's payload changes every subsequent hash", () => {
    // chain v1: A → B → C
    const a1 = hashChain(Buffer.alloc(32, 0), "rowA");
    const b1 = hashChain(a1, "rowB");
    const c1 = hashChain(b1, "rowC");

    // chain v2: A' (modified) → B → C
    const a2 = hashChain(Buffer.alloc(32, 0), "rowA-mutated");
    const b2 = hashChain(a2, "rowB");
    const c2 = hashChain(b2, "rowC");

    expect(a1.equals(a2)).toBe(false);
    expect(b1.equals(b2)).toBe(false);
    expect(c1.equals(c2)).toBe(false);
  });
});
