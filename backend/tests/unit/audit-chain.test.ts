/**
 * Unit test for the audit-chain verifier's hashing logic.
 *
 * Builds a synthetic list of audit rows with properly chained hashes,
 * runs the pure `verifyRows` walker over them, and asserts:
 *   1. A clean chain validates with zero mismatches.
 *   2. Mutating a row's metadata is detected.
 *   3. Mutating a row's prev_hash pointer is detected.
 *   4. A mismatch in row N stops the walk; rows after are not consulted.
 *
 * Integration test against real DB happens in Tier 3.
 */

import { describe, expect, it } from "bun:test";
import {
  canonicalPayload,
  verifyRows,
  type VerifierRow,
} from "../../src/jobs/audit-chain-verify";
import { hashChain } from "../../src/lib/crypto";

const GENESIS = Buffer.alloc(32, 0);

interface RowDraft {
  id: number;
  action: string;
  resource_type: string;
  metadata: unknown;
}

function buildChain(drafts: RowDraft[], startHash: Buffer = GENESIS): VerifierRow[] {
  const out: VerifierRow[] = [];
  let prev = startHash;
  for (const d of drafts) {
    const payload = canonicalPayload({
      action: d.action,
      resource_type: d.resource_type,
      metadata: d.metadata,
    });
    const rowHash = hashChain(prev, payload);
    out.push({
      id: d.id,
      prev_hash: prev,
      row_hash: rowHash,
      action: d.action,
      resource_type: d.resource_type,
      metadata: d.metadata,
    });
    prev = rowHash;
  }
  return out;
}

describe("audit-chain verifyRows", () => {
  const drafts: RowDraft[] = [
    { id: 1, action: "user.login", resource_type: "user", metadata: { ip: "1.1.1.1" } },
    {
      id: 2,
      action: "conversation.create",
      resource_type: "conversation",
      metadata: { title: "First" },
    },
    {
      id: 3,
      action: "message.create",
      resource_type: "message",
      metadata: { role: "user" },
    },
    {
      id: 4,
      action: "message.create",
      resource_type: "message",
      metadata: { role: "assistant" },
    },
  ];

  it("validates a clean chain from genesis", () => {
    const rows = buildChain(drafts);
    const result = verifyRows(rows);
    expect(result.mismatches).toEqual([]);
    expect(result.verifiedThrough).toBe(4);
    expect(result.lastGoodHash.equals(rows[rows.length - 1]!.row_hash)).toBe(true);
  });

  it("detects a tampered metadata field", () => {
    const rows = buildChain(drafts);
    // Forge: change row 2's metadata without recomputing its hash.
    rows[1] = { ...rows[1]!, metadata: { title: "Forged" } };

    const result = verifyRows(rows);
    expect(result.mismatches).toEqual([2]);
    // Walk stops at the first mismatch.
    expect(result.verifiedThrough).toBe(1);
  });

  it("detects a row whose prev_hash pointer was rewritten", () => {
    const rows = buildChain(drafts);
    // Forge: rewrite row 3's prev_hash to something arbitrary while leaving
    // its row_hash intact.
    rows[2] = { ...rows[2]!, prev_hash: Buffer.alloc(32, 0xaa) };

    const result = verifyRows(rows);
    expect(result.mismatches).toEqual([3]);
    expect(result.verifiedThrough).toBe(2);
  });

  it("propagates a tamper in row N forward — the walk halts at N, not later", () => {
    const rows = buildChain(drafts);
    // If we mutate row 1, the verifier should flag id=1, not id=4.
    rows[0] = { ...rows[0]!, metadata: { ip: "9.9.9.9" } };

    const result = verifyRows(rows);
    expect(result.mismatches).toEqual([1]);
    expect(result.verifiedThrough).toBe(0);
  });

  it("resumes from a checkpoint and validates only new rows", () => {
    const full = buildChain(drafts);
    // Simulate having checkpointed through id=2; we now hand the verifier
    // only rows 3..4 plus the last-good hash.
    const tail = full.slice(2);
    const startHash = full[1]!.row_hash;
    const result = verifyRows(tail, startHash, 2);

    expect(result.mismatches).toEqual([]);
    expect(result.verifiedThrough).toBe(4);
  });

  it("an empty batch is a no-op clean walk", () => {
    const result = verifyRows([], GENESIS, 0);
    expect(result.mismatches).toEqual([]);
    expect(result.verifiedThrough).toBe(0);
    expect(result.lastGoodHash.equals(GENESIS)).toBe(true);
  });
});

describe("canonicalPayload", () => {
  it("is deterministic for identical input", () => {
    const a = canonicalPayload({
      action: "x",
      resource_type: "y",
      metadata: { a: 1, b: 2 },
    });
    const b = canonicalPayload({
      action: "x",
      resource_type: "y",
      metadata: { a: 1, b: 2 },
    });
    expect(a).toBe(b);
  });

  it("changes when any substantive field changes", () => {
    const base = { action: "x", resource_type: "y", metadata: { v: 1 } };
    expect(canonicalPayload(base)).not.toBe(
      canonicalPayload({ ...base, action: "z" }),
    );
    expect(canonicalPayload(base)).not.toBe(
      canonicalPayload({ ...base, metadata: { v: 2 } }),
    );
  });
});
