/**
 * Hash-chain logic test (no DB).
 *
 * Verifies that:
 *   - canonical_json is deterministic across key reorderings
 *   - the chain detects single-row mutations downstream
 *   - the genesis row uses a 32-byte zero buffer
 */

import { describe, expect, it } from "bun:test";
import { canonicalAuditPayload } from "../../src/repo/audit-log.ts";
import { hashChain } from "../../src/lib/crypto.ts";

const GENESIS = Buffer.alloc(32, 0);

interface Row {
  ts: string;
  actorUserId: string | null;
  actorIp: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
}

function buildChain(rows: Row[]): Buffer[] {
  const hashes: Buffer[] = [];
  let prev: Buffer = GENESIS;
  for (const r of rows) {
    const payload = canonicalAuditPayload(r);
    const h: Buffer = hashChain(prev, payload);
    hashes.push(h);
    prev = h;
  }
  return hashes;
}

const sampleRows: Row[] = [
  {
    ts: "2026-05-28T12:00:00.000Z",
    actorUserId: "u1",
    actorIp: "10.0.0.1",
    action: "conversation.created",
    resourceType: "conversation",
    resourceId: "c1",
    metadata: { foo: "bar" },
    requestId: "r1",
  },
  {
    ts: "2026-05-28T12:00:01.000Z",
    actorUserId: "u1",
    actorIp: "10.0.0.1",
    action: "message.sent",
    resourceType: "message",
    resourceId: "m1",
    metadata: { tokens: 12 },
    requestId: "r2",
  },
  {
    ts: "2026-05-28T12:00:02.000Z",
    actorUserId: "u1",
    actorIp: "10.0.0.1",
    action: "conversation.deleted",
    resourceType: "conversation",
    resourceId: "c1",
    metadata: {},
    requestId: "r3",
  },
];

describe("canonicalAuditPayload", () => {
  it("is deterministic", () => {
    const a = canonicalAuditPayload(sampleRows[0]!);
    const b = canonicalAuditPayload(sampleRows[0]!);
    expect(a).toBe(b);
  });

  it("ignores metadata key order", () => {
    const row1: Row = { ...sampleRows[0]!, metadata: { a: 1, b: 2 } };
    const row2: Row = { ...sampleRows[0]!, metadata: { b: 2, a: 1 } };
    expect(canonicalAuditPayload(row1)).toBe(canonicalAuditPayload(row2));
  });

  it("sorts nested object keys", () => {
    const row1: Row = {
      ...sampleRows[0]!,
      metadata: { outer: { x: 1, y: 2 } },
    };
    const row2: Row = {
      ...sampleRows[0]!,
      metadata: { outer: { y: 2, x: 1 } },
    };
    expect(canonicalAuditPayload(row1)).toBe(canonicalAuditPayload(row2));
  });

  it("changes when any field differs", () => {
    const a = canonicalAuditPayload(sampleRows[0]!);
    const b = canonicalAuditPayload({ ...sampleRows[0]!, action: "x" });
    expect(a).not.toBe(b);
  });
});

describe("hash chain", () => {
  it("genesis prev is 32 zero bytes", () => {
    expect(GENESIS.length).toBe(32);
    expect(GENESIS.every((b) => b === 0)).toBe(true);
  });

  it("is deterministic across runs", () => {
    const chain1 = buildChain(sampleRows);
    const chain2 = buildChain(sampleRows);
    for (let i = 0; i < chain1.length; i++) {
      expect(chain1[i]!.equals(chain2[i]!)).toBe(true);
    }
  });

  it("propagates a mutation to every successor", () => {
    const original = buildChain(sampleRows);
    const mutated = buildChain([
      { ...sampleRows[0]!, metadata: { foo: "MUTATED" } },
      sampleRows[1]!,
      sampleRows[2]!,
    ]);
    for (let i = 0; i < original.length; i++) {
      expect(original[i]!.equals(mutated[i]!)).toBe(false);
    }
  });

  it("verifier-style replay catches a mid-chain mutation", () => {
    // Build the legit chain.
    const original = buildChain(sampleRows);

    // Now suppose row #2's stored row_hash matches the original but its
    // payload was tampered with. A verifier recomputes hash(prev, payload)
    // and compares to the stored row_hash.
    const tamperedRow1: Row = { ...sampleRows[1]!, action: "tampered" };
    const recomputedRow1Hash = hashChain(original[0]!, canonicalAuditPayload(tamperedRow1));
    expect(recomputedRow1Hash.equals(original[1]!)).toBe(false);
  });
});
