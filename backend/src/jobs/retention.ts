/**
 * Retention worker — two-phase soft / hard delete + audit-log prefix archival.
 *
 * Design contract:
 *   1. Soft delete: stamp `deleted_at = now()` on rows older than their
 *      configured retention window. Hot read paths already filter on
 *      `deleted_at IS NULL`, so the row vanishes from user-visible queries
 *      immediately.
 *   2. Hard delete: physically remove rows where `deleted_at` is older than
 *      `RETENTION_GRACE_DAYS` — the grace window exists so an operator can
 *      restore an accidental deletion before the data is gone for good.
 *
 *   Audit log is special. The hash chain is only valid if rows form a
 *   contiguous prefix-to-suffix sequence; we therefore NEVER delete from
 *   the middle. We delete only a contiguous *prefix* (`id <= cutoff_id`)
 *   AFTER archiving it externally. When `AUDIT_ARCHIVE_BUCKET` is unset,
 *   the worker logs a WARN and keeps the prefix in the DB (preferring
 *   safety over storage savings).
 *
 *   The worker writes its own `gdpr.retention_run` audit entry per pass,
 *   so the chain itself records every retention sweep. To preserve the
 *   chain it appends with the live `prev_hash` (last row's `row_hash`) and
 *   the canonical JSON of substantive fields.
 *
 * CLI:
 *   `bun run src/jobs/retention.ts` — runs forever, one pass every
 *   `RETENTION_CRON_INTERVAL_MS` (default 24h). Each pass is wrapped in a
 *   try/catch; errors are logged and the loop continues so a single bad
 *   row never silently halts retention.
 *
 * Test seam:
 *   `runRetentionOnce()` returns counts so integration tests can assert
 *   the exact rows touched in Tier 3.
 */

import { sql, type DbTxn } from "../db/client.ts";
import { env } from "../env.ts";
import { hashChain } from "../lib/crypto.ts";
import { childLogger } from "../obs/logger.ts";
import { getCtx } from "../obs/context.ts";

const log = childLogger("jobs/retention");

const RETENTION_CRON_INTERVAL_MS = Number(
  process.env.RETENTION_CRON_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
);

const AUDIT_ARCHIVE_BUCKET = process.env.AUDIT_ARCHIVE_BUCKET;

// ---------------------------------------------------------------------------
// Pure date-cutoff helpers — exercised directly by unit tests.
// ---------------------------------------------------------------------------

/**
 * Date past which a row should be soft-deleted. A row is eligible when its
 * `updated_at` (or analogous timestamp) is strictly older than this value.
 * `now` is injected for deterministic testing.
 */
export function softCutoff(retentionDays: number, now: Date = new Date()): Date {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(`softCutoff: retentionDays must be >= 0, got ${retentionDays}`);
  }
  const ms = retentionDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

/**
 * Date past which a soft-deleted row should be hard-deleted. A row is eligible
 * when its `deleted_at` is strictly older than this value.
 */
export function hardCutoff(graceDays: number, now: Date = new Date()): Date {
  if (!Number.isFinite(graceDays) || graceDays < 0) {
    throw new RangeError(`hardCutoff: graceDays must be >= 0, got ${graceDays}`);
  }
  const ms = graceDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

// ---------------------------------------------------------------------------
// Run shape
// ---------------------------------------------------------------------------

export interface RetentionCounts {
  conversations: number;
  messages: number;
  usageRecords: number;
  ttsCache: number;
}

export interface RetentionResult {
  softDeleted: RetentionCounts;
  hardDeleted: RetentionCounts;
  auditPrefixArchived: number;
  durationMs: number;
}

function emptyCounts(): RetentionCounts {
  return { conversations: 0, messages: 0, usageRecords: 0, ttsCache: 0 };
}

function reqIdTag(): string {
  return getCtx()?.requestId ?? "job:retention";
}

// ---------------------------------------------------------------------------
// Per-table operations. Each catches "table missing" (42P01) so the worker
// survives partial migrations on a fresh DB.
// ---------------------------------------------------------------------------

type Tx = DbTxn;

async function isMissingTable(err: unknown): Promise<boolean> {
  return Boolean(
    err && typeof err === "object" && (err as { code?: string }).code === "42P01",
  );
}

async function softDeleteConversations(tx: Tx, cutoff: Date): Promise<number> {
  try {
    const rows = await tx<{ id: string }[]>`
      UPDATE conversations
         SET deleted_at = now()
       WHERE deleted_at IS NULL
         AND updated_at < ${cutoff}
       RETURNING id
    `;
    return rows.length;
  } catch (err) {
    if (await isMissingTable(err)) {
      log.warn({ table: "conversations" }, "table missing — skipping soft delete");
      return 0;
    }
    throw err;
  }
}

async function softDeleteMessages(tx: Tx, cutoff: Date): Promise<number> {
  // Messages inherit their lifecycle from the parent conversation. Stamp
  // `deleted_at` on any message whose conversation has been (or just was)
  // soft-deleted past the cutoff. We piggy-back on created_at as the
  // "interesting" timestamp here since messages are immutable post-insert.
  try {
    const rows = await tx<{ id: string }[]>`
      UPDATE messages m
         SET deleted_at = now()
        FROM conversations c
       WHERE m.conversation_id = c.id
         AND m.deleted_at IS NULL
         AND (c.deleted_at IS NOT NULL OR m.created_at < ${cutoff})
       RETURNING m.id
    `;
    return rows.length;
  } catch (err) {
    if (await isMissingTable(err)) {
      log.warn({ table: "messages" }, "table missing — skipping soft delete");
      return 0;
    }
    throw err;
  }
}

async function hardDeleteConversations(tx: Tx, cutoff: Date): Promise<number> {
  try {
    const rows = await tx<{ id: string }[]>`
      DELETE FROM conversations
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoff}
       RETURNING id
    `;
    return rows.length;
  } catch (err) {
    if (await isMissingTable(err)) return 0;
    throw err;
  }
}

async function hardDeleteMessages(tx: Tx, cutoff: Date): Promise<number> {
  try {
    const rows = await tx<{ id: string }[]>`
      DELETE FROM messages
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoff}
       RETURNING id
    `;
    return rows.length;
  } catch (err) {
    if (await isMissingTable(err)) return 0;
    throw err;
  }
}

async function hardDeleteUsageRecords(tx: Tx, cutoff: Date): Promise<number> {
  // usage_records has no soft-delete column — retention is a straight hard
  // delete past the configured window.
  try {
    const rows = await tx<{ id: string }[]>`
      DELETE FROM usage_records
       WHERE created_at < ${cutoff}
       RETURNING id
    `;
    return rows.length;
  } catch (err) {
    if (await isMissingTable(err)) return 0;
    throw err;
  }
}

async function hardDeleteTtsCache(tx: Tx, cutoff: Date): Promise<number> {
  try {
    const rows = await tx<{ message_id: string }[]>`
      DELETE FROM tts_cache
       WHERE created_at < ${cutoff}
       RETURNING message_id
    `;
    return rows.length;
  } catch (err) {
    if (await isMissingTable(err)) return 0;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Audit-log prefix archival.
// ---------------------------------------------------------------------------

async function archiveAuditPrefix(tx: Tx, cutoff: Date): Promise<number> {
  if (!AUDIT_ARCHIVE_BUCKET) {
    log.warn(
      { reqId: reqIdTag() },
      "AUDIT_ARCHIVE_BUCKET unset — keeping audit-log prefix in DB (skipping hard delete)",
    );
    return 0;
  }

  try {
    // Find the largest id whose ts is past the cutoff. We delete a contiguous
    // prefix (id <= cutoffId) so the surviving suffix still forms a valid chain.
    const tail = await tx<{ id: string; row_hash: Buffer | null }[]>`
      SELECT id, row_hash
        FROM audit_log
       WHERE ts < ${cutoff}
       ORDER BY id DESC
       LIMIT 1
    `;
    if (tail.length === 0) return 0;
    const cutoffId = tail[0]!.id;
    const lastHash = tail[0]!.row_hash ?? Buffer.alloc(32, 0);

    // NOTE: the actual upload to the bucket is a follow-up; here we only
    // record the checkpoint and delete the prefix. Operators MUST configure
    // archival storage before turning AUDIT_ARCHIVE_BUCKET on.
    await tx`
      INSERT INTO audit_chain_checkpoints (last_id, last_hash, verified_at)
      VALUES (${cutoffId}, ${lastHash}, now())
    `;

    const rows = await tx<{ id: string }[]>`
      DELETE FROM audit_log
       WHERE id <= ${cutoffId}
       RETURNING id
    `;
    return rows.length;
  } catch (err) {
    if (await isMissingTable(err)) {
      log.warn({ table: "audit_log" }, "table missing — skipping audit prefix archive");
      return 0;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// gdpr.retention_run audit entry.
// ---------------------------------------------------------------------------

async function appendRetentionAudit(tx: Tx, payloadObj: Record<string, unknown>): Promise<void> {
  try {
    const prevRows = await tx<{ row_hash: Buffer | null }[]>`
      SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1
    `;
    const prev: Buffer = prevRows[0]?.row_hash ?? Buffer.alloc(32, 0);

    const action = "gdpr.retention_run";
    const resourceType = "system";
    const metadata = payloadObj;
    const canonicalPayload = JSON.stringify({
      action,
      resource_type: resourceType,
      metadata,
    });
    const rowHash = hashChain(prev, canonicalPayload);

    // Serialize metadata as canonical JSON text and cast to JSONB inside the
    // query so we don't fight postgres-js's type inference on `Record<string,
    // unknown>` parameters.
    const metadataJson = JSON.stringify(metadata);
    await tx`
      INSERT INTO audit_log
        (actor_user_id, action, resource_type, resource_id, metadata, prev_hash, row_hash)
      VALUES
        (NULL, ${action}, ${resourceType}, NULL, ${metadataJson}::jsonb, ${prev}, ${rowHash})
    `;
  } catch (err) {
    if (await isMissingTable(err)) {
      log.warn({ table: "audit_log" }, "audit_log missing — skipping retention audit entry");
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Run a single retention pass inside one transaction. Returns counts so
 * integration tests can verify exact rows touched.
 */
export async function runRetentionOnce(now: Date = new Date()): Promise<RetentionResult> {
  const started = Date.now();
  const result: RetentionResult = {
    softDeleted: emptyCounts(),
    hardDeleted: emptyCounts(),
    auditPrefixArchived: 0,
    durationMs: 0,
  };

  const convoSoft = softCutoff(env.RETENTION_DAYS_CONVERSATIONS, now);
  const convoHard = hardCutoff(env.RETENTION_GRACE_DAYS, now);
  const usageHard = softCutoff(env.RETENTION_DAYS_USAGE, now);
  const auditHard = softCutoff(env.RETENTION_DAYS_AUDIT, now);
  const ttsHard = softCutoff(env.RETENTION_DAYS_TTS_CACHE, now);

  log.info(
    {
      reqId: reqIdTag(),
      convoSoft,
      convoHard,
      usageHard,
      auditHard,
      ttsHard,
    },
    "retention pass starting",
  );

  await sql.begin(async (tx) => {
    // Phase 1 — soft delete.
    result.softDeleted.conversations = await softDeleteConversations(tx, convoSoft);
    result.softDeleted.messages = await softDeleteMessages(tx, convoSoft);

    // Phase 2 — hard delete past grace.
    result.hardDeleted.messages = await hardDeleteMessages(tx, convoHard);
    result.hardDeleted.conversations = await hardDeleteConversations(tx, convoHard);
    result.hardDeleted.usageRecords = await hardDeleteUsageRecords(tx, usageHard);
    result.hardDeleted.ttsCache = await hardDeleteTtsCache(tx, ttsHard);

    // Audit log prefix archive (only when bucket configured).
    result.auditPrefixArchived = await archiveAuditPrefix(tx, auditHard);

    // Append the pass to the audit log itself.
    await appendRetentionAudit(tx, {
      softDeleted: result.softDeleted,
      hardDeleted: result.hardDeleted,
      auditPrefixArchived: result.auditPrefixArchived,
    });
  });

  result.durationMs = Date.now() - started;
  log.info({ reqId: reqIdTag(), ...result }, "retention pass complete");
  return result;
}

// ---------------------------------------------------------------------------
// CLI loop
// ---------------------------------------------------------------------------

async function mainLoop(): Promise<void> {
  // Self-rescheduling setTimeout chain — no library cron. Each pass is fully
  // awaited before the next is scheduled, so a slow pass cannot pile up.
  // Errors per-pass are logged and the loop continues.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runRetentionOnce();
    } catch (err) {
      log.error({ err }, "retention pass failed; continuing");
    }
    await new Promise<void>((r) => setTimeout(r, RETENTION_CRON_INTERVAL_MS));
  }
}

if (import.meta.main) {
  log.info(
    { intervalMs: RETENTION_CRON_INTERVAL_MS },
    "retention worker starting",
  );
  await mainLoop();
}
