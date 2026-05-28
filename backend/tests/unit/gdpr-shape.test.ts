/**
 * Unit tests for the GDPR export bundle shape.
 *
 * `buildBundle` is pure — no DB, no filesystem. We feed it synthetic rows
 * and pin down the resulting object shape so the contract between the
 * worker and downstream consumers (file-format readers, restore tooling)
 * stays stable.
 *
 * Integration test against real DB happens in Tier 3.
 */

import { describe, expect, it } from "bun:test";
import { buildBundle, type BundleInputs } from "../../src/jobs/gdpr-export";

const FIXED_NOW = new Date("2026-06-15T12:00:00.000Z");

function sampleInputs(): BundleInputs {
  return {
    jobId: "job-1234",
    userId: "user-abcd",
    user: { id: "user-abcd", email: "patient@example.com", role: "patient" },
    conversations: [
      { id: "c1", user_id: "user-abcd", created_at: "2026-06-01T00:00:00.000Z" },
      { id: "c2", user_id: "user-abcd", created_at: "2026-06-02T00:00:00.000Z" },
    ],
    messages: [
      { id: "m1", conversation_id: "c1", role: "user" },
      { id: "m2", conversation_id: "c1", role: "assistant" },
      { id: "m3", conversation_id: "c2", role: "user" },
    ],
    usageRecords: [
      { id: "u1", conversation_id: "c1", cost_usd: "0.001" },
    ],
    auditLog: [
      { id: 7, action: "user.login", resource_type: "user" },
      { id: 9, action: "conversation.create", resource_type: "conversation" },
    ],
    now: FIXED_NOW,
  };
}

describe("buildBundle", () => {
  it("includes a manifest with version, jobId, userId and generatedAt", () => {
    const bundle = buildBundle(sampleInputs());
    expect(bundle.manifest.version).toBe(1);
    expect(bundle.manifest.jobId).toBe("job-1234");
    expect(bundle.manifest.userId).toBe("user-abcd");
    expect(bundle.manifest.generatedAt).toBe(FIXED_NOW.toISOString());
  });

  it("records accurate counts in the manifest", () => {
    const bundle = buildBundle(sampleInputs());
    expect(bundle.manifest.counts).toEqual({
      conversations: 2,
      messages: 3,
      usageRecords: 1,
      auditEntries: 2,
    });
  });

  it("passes through input arrays verbatim", () => {
    const inputs = sampleInputs();
    const bundle = buildBundle(inputs);
    expect(bundle.conversations).toEqual(inputs.conversations);
    expect(bundle.messages).toEqual(inputs.messages);
    expect(bundle.usageRecords).toEqual(inputs.usageRecords);
    expect(bundle.auditLog).toEqual(inputs.auditLog);
    expect(bundle.user).toEqual(inputs.user);
  });

  it("handles a user with no data (empty arrays)", () => {
    const empty: BundleInputs = {
      jobId: "job-empty",
      userId: "user-empty",
      user: null,
      conversations: [],
      messages: [],
      usageRecords: [],
      auditLog: [],
      now: FIXED_NOW,
    };
    const bundle = buildBundle(empty);
    expect(bundle.user).toBeNull();
    expect(bundle.manifest.counts).toEqual({
      conversations: 0,
      messages: 0,
      usageRecords: 0,
      auditEntries: 0,
    });
  });

  it("defaults generatedAt to the current time when `now` is omitted", () => {
    const before = Date.now();
    const bundle = buildBundle({ ...sampleInputs(), now: undefined });
    const after = Date.now();
    const stamp = new Date(bundle.manifest.generatedAt).getTime();
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it("manifest is JSON-serializable (no functions / circular refs)", () => {
    const bundle = buildBundle(sampleInputs());
    expect(() => JSON.parse(JSON.stringify(bundle.manifest))).not.toThrow();
    expect(() => JSON.parse(JSON.stringify(bundle))).not.toThrow();
  });

  it("exposes the expected top-level keys", () => {
    const bundle = buildBundle(sampleInputs());
    const keys = Object.keys(bundle).sort();
    expect(keys).toEqual([
      "auditLog",
      "conversations",
      "manifest",
      "messages",
      "usageRecords",
      "user",
    ]);
  });
});
