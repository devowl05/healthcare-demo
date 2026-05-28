/**
 * Append-only audit log with per-row SHA-256 hash chaining.
 *
 *   row_hash_n = sha256( row_hash_{n-1} || canonical_json(payload_n) )
 *
 * The first row uses a 32-byte zero buffer as the genesis predecessor. Any
 * mutation downstream invalidates every successor — that's the tamper-evidence
 * property the verifier exploits.
 *
 * Concurrency: we wrap the chain step in a SERIALIZABLE transaction guarded by
 * `pg_advisory_xact_lock('audit_log_chain')` so two concurrent appends can't
 * read the same `prev_hash` and produce a fork. The lock key is a stable
 * `hashtext()` of the string `'audit_log_chain'` (computed inline so the
 * helper is single-call).
 */

import { sql } from "../db/client.ts";
import { hashChain } from "../lib/crypto.ts";
import type { ObsContext } from "../obs/context.ts";

const GENESIS_PREV = Buffer.alloc(32, 0);

export interface AuditMetadata {
  [key: string]: unknown;
}

export interface AuditAppendInput {
  ctx: Partial<ObsContext> & {
    actorIp?: string | null;
  };
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: AuditMetadata;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor_user_id: string | null;
  actor_ip: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: AuditMetadata;
  request_id: string | null;
  prev_hash: Buffer;
  row_hash: Buffer;
}

/**
 * Canonical JSON for the payload we hash. Object keys are sorted so the
 * digest is stable across drivers / encoders. Buffer fields are excluded —
 * they're the chain output, not the input.
 */
export function canonicalAuditPayload(input: {
  ts: string;
  actorUserId: string | null;
  actorIp: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: AuditMetadata;
  requestId: string | null;
}): string {
  // Sort metadata keys recursively. We don't expect nested arrays-of-objects
  // to need stable ordering here, but normalize defensively.
  const sortedMeta = sortKeys(input.metadata);
  const canonical = {
    action: input.action,
    actor_ip: input.actorIp,
    actor_user_id: input.actorUserId,
    metadata: sortedMeta,
    request_id: input.requestId,
    resource_id: input.resourceId,
    resource_type: input.resourceType,
    ts: input.ts,
  };
  return JSON.stringify(canonical);
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return out;
}

/**
 * Append a single audit row. Uses SERIALIZABLE isolation + an advisory lock so
 * concurrent appenders see a consistent chain head.
 */
export async function append(input: AuditAppendInput): Promise<AuditRow> {
  const actorUserId = input.ctx.userId ?? null;
  const actorIp = input.ctx.actorIp ?? null;
  const requestId = input.ctx.requestId ?? null;
  const resourceId = input.resourceId ?? null;
  const metadata = input.metadata ?? {};

  return sql.begin("isolation level serializable", async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('audit_log_chain'))`;

    const prevRows = await tx<{ row_hash: Buffer | null }[]>`
      SELECT row_hash
      FROM audit_log
      ORDER BY id DESC
      LIMIT 1
    `;
    const prev: Buffer =
      prevRows[0]?.row_hash !== undefined && prevRows[0]?.row_hash !== null
        ? Buffer.from(prevRows[0].row_hash)
        : GENESIS_PREV;

    // Use now() from postgres so the hashed ts matches the stored ts exactly.
    const nowRows = await tx<{ ts: string }[]>`SELECT now() AS ts`;
    const ts = nowRows[0]!.ts;

    const payload = canonicalAuditPayload({
      ts,
      actorUserId,
      actorIp,
      action: input.action,
      resourceType: input.resourceType,
      resourceId,
      metadata,
      requestId,
    });
    const rowHash = hashChain(prev, payload);

    const inserted = await tx<AuditRow[]>`
      INSERT INTO audit_log (
        ts, actor_user_id, actor_ip, action,
        resource_type, resource_id, metadata, request_id,
        prev_hash, row_hash
      ) VALUES (
        ${ts}::timestamptz, ${actorUserId}, ${actorIp}, ${input.action},
        ${input.resourceType}, ${resourceId}, ${JSON.stringify(metadata)}::jsonb, ${requestId},
        ${prev}, ${rowHash}
      )
      RETURNING id, ts, actor_user_id, actor_ip, action,
                resource_type, resource_id, metadata, request_id,
                prev_hash, row_hash
    `;
    return inserted[0]!;
  }) as unknown as Promise<AuditRow>;
}

/**
 * Sugar over `append` so call sites read fluently:
 *   await audit("conversation.deleted", { type: "conversation", id }, { reason })
 *
 * Pulls actor context from `getCtx()` so the route handler doesn't have to
 * thread requestId/userId manually.
 */
export async function audit(
  action: string,
  resource: { type: string; id?: string | null },
  metadata?: AuditMetadata,
): Promise<AuditRow> {
  // Lazy import to avoid a cycle with obs/context (audit-log -> context is
  // fine; only the back-edge would be a problem).
  const { getCtx } = await import("../obs/context.ts");
  const ctx = getCtx();
  return append({
    ctx: ctx ?? {},
    action,
    resourceType: resource.type,
    resourceId: resource.id ?? null,
    metadata,
  });
}

export interface VerifyChainResult {
  ok: boolean;
  /** Last row id successfully verified (inclusive). */
  lastId: number;
  /** Last row_hash matching the chain. */
  lastHash: Buffer;
  /** Id of the first row whose hash didn't match, if any. */
  brokenAt?: number;
}

/**
 * Walk the chain from `fromId+1` (or from the start) verifying every row's
 * `row_hash` against its `prev_hash` and the canonical payload. Returns
 * `{ ok: false, brokenAt }` on first mismatch.
 *
 * Memory-safe for large logs: streams rows in batches of 1000.
 */
export async function verifyChain(fromId = 0): Promise<VerifyChainResult> {
  let cursor = fromId;
  let prev: Buffer = GENESIS_PREV;
  let lastId = fromId;

  if (fromId > 0) {
    const seedRows = await sql<{ row_hash: Buffer }[]>`
      SELECT row_hash FROM audit_log WHERE id = ${fromId}
    `;
    if (!seedRows[0]) {
      return { ok: false, lastId: fromId, lastHash: GENESIS_PREV, brokenAt: fromId };
    }
    prev = Buffer.from(seedRows[0].row_hash);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await sql<AuditRow[]>`
      SELECT id, ts, actor_user_id, actor_ip, action,
             resource_type, resource_id, metadata, request_id,
             prev_hash, row_hash
      FROM audit_log
      WHERE id > ${cursor}
      ORDER BY id ASC
      LIMIT 1000
    `;
    if (batch.length === 0) break;

    for (const row of batch) {
      const rowPrev = Buffer.from(row.prev_hash);
      if (!rowPrev.equals(prev)) {
        return { ok: false, lastId, lastHash: prev, brokenAt: row.id };
      }
      const payload = canonicalAuditPayload({
        ts: row.ts,
        actorUserId: row.actor_user_id,
        actorIp: row.actor_ip,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        metadata: row.metadata,
        requestId: row.request_id,
      });
      const expected = hashChain(rowPrev, payload);
      const rowHash = Buffer.from(row.row_hash);
      if (!expected.equals(rowHash)) {
        return { ok: false, lastId, lastHash: prev, brokenAt: row.id };
      }
      prev = rowHash;
      lastId = row.id;
      cursor = row.id;
    }
  }

  return { ok: true, lastId, lastHash: prev };
}
