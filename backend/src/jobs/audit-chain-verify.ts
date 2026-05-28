/**
 * Audit-log chain verifier.
 *
 * The audit log is append-only and each row carries `row_hash =
 * SHA-256(prev_hash || canonical_json(substantive_fields))`. Any mutation
 * in-place by an attacker invalidates that row's hash AND every row after
 * it — but only if someone recomputes the chain and notices. This worker
 * is that someone.
 *
 * Walk strategy:
 *   1. Pick up from the latest `audit_chain_checkpoints` row (or genesis
 *      — `Buffer.alloc(32, 0)` — if there isn't one yet).
 *   2. Stream `audit_log WHERE id > last_id ORDER BY id` in batches of
 *      1000; for each row, recompute the expected hash and compare to the
 *      stored `row_hash`.
 *   3. On a clean walk, persist a fresh checkpoint so tomorrow starts
 *      where today left off.
 *   4. On any mismatch:
 *        - log `security.audit_chain_broken` at ERROR
 *        - append a "system" audit row noting the break (with a *new*
 *          hash chained off the last good row, so the new chain is itself
 *          tamper-evident)
 *        - POST to `ALERT_WEBHOOK_URL` if set, with the broken id list
 *        - stop verification at the first mismatch (the rest of the
 *          chain is meaningless until investigated)
 *
 * The canonical payload format MUST match whatever writer code constructs.
 * Tier 2b's audit-log writer uses `{action, resource_type, metadata}` —
 * we mirror that here.
 */

import { sql } from "../db/client.ts";
import { hashChain } from "../lib/crypto.ts";
import { childLogger } from "../obs/logger.ts";
import { getCtx } from "../obs/context.ts";

const log = childLogger("jobs/audit-chain-verify");

const VERIFY_INTERVAL_MS = Number(
  process.env.AUDIT_CHAIN_VERIFY_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
);

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

const BATCH_SIZE = 1000;
const GENESIS: Buffer = Buffer.alloc(32, 0);

// ---------------------------------------------------------------------------
// Canonical payload — must match the audit-log writer's format.
// Exported for unit tests so they don't drift from production.
// ---------------------------------------------------------------------------

export interface AuditRowForHash {
  action: string;
  resource_type: string;
  metadata: unknown;
}

export function canonicalPayload(row: AuditRowForHash): string {
  return JSON.stringify({
    action: row.action,
    resource_type: row.resource_type,
    metadata: row.metadata,
  });
}

// ---------------------------------------------------------------------------
// Pure verifier — given a sequence of rows (in id order), return the list of
// ids whose stored row_hash doesn't match the recomputed expected hash.
// Stops at the first mismatch (everything after is meaningless).
// ---------------------------------------------------------------------------

export interface VerifierRow {
  id: number;
  prev_hash: Buffer;
  row_hash: Buffer;
  action: string;
  resource_type: string;
  metadata: unknown;
}

export interface VerifyWalkResult {
  /** Highest id walked without finding a mismatch. */
  verifiedThrough: number;
  /** `row_hash` of the last verified row (genesis if none). */
  lastGoodHash: Buffer;
  /** ids whose hash didn't validate (at most one — we stop on first). */
  mismatches: number[];
}

export function verifyRows(
  rows: VerifierRow[],
  startHash: Buffer = GENESIS,
  startId = 0,
): VerifyWalkResult {
  let prevHash = startHash;
  let verifiedThrough = startId;
  const mismatches: number[] = [];

  for (const row of rows) {
    const expected = hashChain(prevHash, canonicalPayload(row));
    if (!expected.equals(row.row_hash)) {
      mismatches.push(row.id);
      break;
    }
    // Also sanity-check that the row's stored prev_hash matches what we
    // expect — catches a row whose prev pointer was rewritten too.
    if (!row.prev_hash.equals(prevHash)) {
      mismatches.push(row.id);
      break;
    }
    prevHash = row.row_hash;
    verifiedThrough = row.id;
  }

  return { verifiedThrough, lastGoodHash: prevHash, mismatches };
}

// ---------------------------------------------------------------------------
// Run shape
// ---------------------------------------------------------------------------

export interface ChainVerifyResult {
  verifiedThrough: number;
  broken: boolean;
  mismatches: number[];
}

function reqIdTag(): string {
  return getCtx()?.requestId ?? "job:audit-chain-verify";
}

// ---------------------------------------------------------------------------
// DB-driven entrypoint.
// ---------------------------------------------------------------------------

async function loadLatestCheckpoint(): Promise<{ id: number; hash: Buffer } | null> {
  try {
    const rows = await sql<{ last_id: string; last_hash: Buffer }[]>`
      SELECT last_id, last_hash
        FROM audit_chain_checkpoints
       ORDER BY id DESC
       LIMIT 1
    `;
    if (rows.length === 0) return null;
    const id = typeof rows[0]!.last_id === "string" ? Number(rows[0]!.last_id) : (rows[0]!.last_id as unknown as number);
    return { id, hash: rows[0]!.last_hash };
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "42P01") {
      log.warn({ reqId: reqIdTag() }, "audit_chain_checkpoints missing — starting from genesis");
      return null;
    }
    throw err;
  }
}

async function loadBatch(afterId: number): Promise<VerifierRow[]> {
  const rows = await sql<
    {
      id: string;
      prev_hash: Buffer;
      row_hash: Buffer;
      action: string;
      resource_type: string;
      metadata: unknown;
    }[]
  >`
    SELECT id, prev_hash, row_hash, action, resource_type, metadata
      FROM audit_log
     WHERE id > ${afterId}
     ORDER BY id
     LIMIT ${BATCH_SIZE}
  `;
  return rows.map((r) => ({
    id: typeof r.id === "string" ? Number(r.id) : (r.id as unknown as number),
    prev_hash: r.prev_hash,
    row_hash: r.row_hash,
    action: r.action,
    resource_type: r.resource_type,
    metadata: r.metadata,
  }));
}

async function writeCheckpoint(verifiedThrough: number, hash: Buffer): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_chain_checkpoints (last_id, last_hash, verified_at)
      VALUES (${verifiedThrough}, ${hash}, now())
    `;
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "42P01") {
      log.warn({ reqId: reqIdTag() }, "checkpoint table missing — skipping write");
      return;
    }
    throw err;
  }
}

async function appendChainBrokenAudit(
  mismatches: number[],
  lastGoodHash: Buffer,
): Promise<void> {
  try {
    const action = "security.audit_chain_broken";
    const resourceType = "audit_log";
    const metadata: AuditRowForHash["metadata"] = { mismatches };
    const payload = canonicalPayload({ action, resource_type: resourceType, metadata });
    const rowHash = hashChain(lastGoodHash, payload);
    const metadataJson = JSON.stringify(metadata);
    await sql`
      INSERT INTO audit_log
        (actor_user_id, action, resource_type, resource_id, metadata, prev_hash, row_hash)
      VALUES
        (NULL, ${action}, ${resourceType}, NULL, ${metadataJson}::jsonb, ${lastGoodHash}, ${rowHash})
    `;
  } catch (err) {
    log.error({ err }, "failed to append chain-broken audit row");
  }
}

async function fireAlertWebhook(mismatches: number[]): Promise<void> {
  if (!ALERT_WEBHOOK_URL) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `audit chain broken at id=${mismatches.join(",")}`,
      }),
    });
  } catch (err) {
    log.error({ err }, "alert webhook POST failed");
  }
}

/**
 * Run a single chain-verify pass. Returns the highest verified id, whether
 * the chain is broken, and the offending row ids. On `broken === true`, the
 * job has already logged ERROR, written a `security.audit_chain_broken`
 * audit row, and fired the alert webhook (if configured).
 */
export async function runChainVerifyOnce(): Promise<ChainVerifyResult> {
  const checkpoint = await loadLatestCheckpoint();
  let cursorId = checkpoint?.id ?? 0;
  let prevHash = checkpoint?.hash ?? GENESIS;
  const mismatches: number[] = [];

  log.info({ reqId: reqIdTag(), startingId: cursorId }, "chain verify starting");

  // Walk in batches.
  while (true) {
    const batch = await loadBatch(cursorId);
    if (batch.length === 0) break;

    const walk = verifyRows(batch, prevHash, cursorId);
    cursorId = walk.verifiedThrough;
    prevHash = walk.lastGoodHash;

    if (walk.mismatches.length > 0) {
      mismatches.push(...walk.mismatches);
      break;
    }

    if (batch.length < BATCH_SIZE) break;
  }

  if (mismatches.length > 0) {
    log.error(
      { reqId: reqIdTag(), mismatches, verifiedThrough: cursorId },
      "security.audit_chain_broken",
    );
    await appendChainBrokenAudit(mismatches, prevHash);
    await fireAlertWebhook(mismatches);
    return { verifiedThrough: cursorId, broken: true, mismatches };
  }

  // Clean walk — persist checkpoint.
  if (cursorId > (checkpoint?.id ?? 0)) {
    await writeCheckpoint(cursorId, prevHash);
  }
  log.info({ reqId: reqIdTag(), verifiedThrough: cursorId }, "chain verify clean");
  return { verifiedThrough: cursorId, broken: false, mismatches: [] };
}

// ---------------------------------------------------------------------------
// CLI loop
// ---------------------------------------------------------------------------

async function mainLoop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runChainVerifyOnce();
    } catch (err) {
      log.error({ err }, "chain verify pass failed; continuing");
    }
    await new Promise<void>((r) => setTimeout(r, VERIFY_INTERVAL_MS));
  }
}

if (import.meta.main) {
  log.info({ intervalMs: VERIFY_INTERVAL_MS }, "audit-chain-verify worker starting");
  await mainLoop();
}
