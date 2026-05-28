/**
 * GDPR data-export worker.
 *
 * # Output format decision
 *
 * Bun has no built-in zip support and the build constraint is "no new deps".
 * Rather than shipping a hand-rolled zip encoder (which is its own bug
 * surface), this worker writes the export as a directory of JSON files:
 *
 *   ./exports/<jobId>/
 *     manifest.json            -- export metadata (userId, generatedAt, version)
 *     user.json                -- the user row (id, email, role, timestamps)
 *     conversations.json       -- all conversations owned by the user
 *     messages.json            -- all messages across those conversations
 *     usage_records.json       -- per-turn usage rows
 *     audit_log.json           -- audit entries where actor_user_id = user
 *
 * Operators who need a single archive can `zip -r <jobId>.zip ./exports/<jobId>/`
 * out of band. Producing a real `.zip` inline is tracked as a follow-up.
 *
 * The `export_jobs.file_path` column stores the absolute path to the directory.
 *
 * # FSM
 *
 *   queued    -> picked up via `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`
 *   running   -> while building the bundle
 *   completed -> file_path set, expires_at = now() + 24h
 *   failed    -> error column set
 *
 * # Audit
 *
 * Successful completion writes `gdpr.export_completed`; failures write
 * `gdpr.export_failed`. Both flow through the same audit_log append path so
 * the chain stays intact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql, type DbTxn } from "../db/client.ts";
import { hashChain } from "../lib/crypto.ts";
import { childLogger } from "../obs/logger.ts";
import { getCtx } from "../obs/context.ts";

const log = childLogger("jobs/gdpr-export");

const EXPORTS_ROOT = resolve(process.cwd(), "exports");
const EXPIRES_HOURS = 24;
const POLL_INTERVAL_MS = Number(process.env.GDPR_EXPORT_POLL_MS ?? 5_000);
const BUNDLE_VERSION = 1;

function reqIdTag(): string {
  return getCtx()?.requestId ?? "job:gdpr-export";
}

// ---------------------------------------------------------------------------
// Bundle shape — exported for unit tests so the contract is locked.
// ---------------------------------------------------------------------------

export interface ExportBundleManifest {
  version: number;
  userId: string;
  jobId: string;
  generatedAt: string;
  counts: {
    conversations: number;
    messages: number;
    usageRecords: number;
    auditEntries: number;
  };
}

export interface ExportBundle {
  manifest: ExportBundleManifest;
  user: Record<string, unknown> | null;
  conversations: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  usageRecords: Record<string, unknown>[];
  auditLog: Record<string, unknown>[];
}

export interface BundleInputs {
  jobId: string;
  userId: string;
  user: Record<string, unknown> | null;
  conversations: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  usageRecords: Record<string, unknown>[];
  auditLog: Record<string, unknown>[];
  now?: Date;
}

/**
 * Pure: build the export bundle object from gathered rows. No I/O. The
 * unit tests poke at this directly.
 */
export function buildBundle(inputs: BundleInputs): ExportBundle {
  const now = inputs.now ?? new Date();
  return {
    manifest: {
      version: BUNDLE_VERSION,
      userId: inputs.userId,
      jobId: inputs.jobId,
      generatedAt: now.toISOString(),
      counts: {
        conversations: inputs.conversations.length,
        messages: inputs.messages.length,
        usageRecords: inputs.usageRecords.length,
        auditEntries: inputs.auditLog.length,
      },
    },
    user: inputs.user,
    conversations: inputs.conversations,
    messages: inputs.messages,
    usageRecords: inputs.usageRecords,
    auditLog: inputs.auditLog,
  };
}

// ---------------------------------------------------------------------------
// DB gathering helpers — each tolerates missing tables.
// ---------------------------------------------------------------------------

function isMissingTable(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as { code?: string }).code === "42P01",
  );
}

async function fetchUser(userId: string): Promise<Record<string, unknown> | null> {
  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, email, role, created_at, updated_at, deleted_at
        FROM users
       WHERE id = ${userId}
    `;
    return rows[0] ?? null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

async function fetchConversations(userId: string): Promise<Record<string, unknown>[]> {
  try {
    return await sql<Record<string, unknown>[]>`
      SELECT id, cheap_mode, created_at, updated_at, deleted_at
        FROM conversations
       WHERE user_id = ${userId}
       ORDER BY created_at
    `;
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

async function fetchMessages(userId: string): Promise<Record<string, unknown>[]> {
  try {
    return await sql<Record<string, unknown>[]>`
      SELECT m.id, m.conversation_id, m.role, m.parts, m.created_at, m.deleted_at
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ${userId}
       ORDER BY m.created_at
    `;
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

async function fetchUsageRecords(userId: string): Promise<Record<string, unknown>[]> {
  try {
    return await sql<Record<string, unknown>[]>`
      SELECT u.id, u.conversation_id, u.message_id, u.model, u.input_tokens,
             u.output_tokens, u.cached_input_tokens, u.cost_usd, u.latency_ms,
             u.request_id, u.created_at
        FROM usage_records u
        JOIN conversations c ON c.id = u.conversation_id
       WHERE c.user_id = ${userId}
       ORDER BY u.created_at
    `;
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

async function fetchAuditLog(userId: string): Promise<Record<string, unknown>[]> {
  try {
    return await sql<Record<string, unknown>[]>`
      SELECT id, ts, action, resource_type, resource_id, metadata, request_id
        FROM audit_log
       WHERE actor_user_id = ${userId}
       ORDER BY id
    `;
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Audit helpers — append a row using whatever the current tip hash is.
// ---------------------------------------------------------------------------

async function appendAuditTx(
  tx: DbTxn,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, unknown>,
  actorUserId: string | null,
): Promise<void> {
  try {
    const prevRows = await tx<{ row_hash: Buffer | null }[]>`
      SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1
    `;
    const prev: Buffer = prevRows[0]?.row_hash ?? Buffer.alloc(32, 0);
    const payload = JSON.stringify({
      action,
      resource_type: resourceType,
      metadata,
    });
    const rowHash = hashChain(prev, payload);
    const metadataJson = JSON.stringify(metadata);
    await tx`
      INSERT INTO audit_log
        (actor_user_id, action, resource_type, resource_id, metadata, prev_hash, row_hash)
      VALUES
        (${actorUserId}, ${action}, ${resourceType}, ${resourceId}, ${metadataJson}::jsonb, ${prev}, ${rowHash})
    `;
  } catch (err) {
    if (isMissingTable(err)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Bundle write — JSON files on disk.
// ---------------------------------------------------------------------------

async function writeBundleToDisk(bundle: ExportBundle, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const writes: Promise<unknown>[] = [
    writeFile(resolve(dir, "manifest.json"), JSON.stringify(bundle.manifest, null, 2)),
    writeFile(resolve(dir, "user.json"), JSON.stringify(bundle.user, null, 2)),
    writeFile(
      resolve(dir, "conversations.json"),
      JSON.stringify(bundle.conversations, null, 2),
    ),
    writeFile(resolve(dir, "messages.json"), JSON.stringify(bundle.messages, null, 2)),
    writeFile(
      resolve(dir, "usage_records.json"),
      JSON.stringify(bundle.usageRecords, null, 2),
    ),
    writeFile(resolve(dir, "audit_log.json"), JSON.stringify(bundle.auditLog, null, 2)),
  ];
  await Promise.all(writes);
  return dir;
}

// ---------------------------------------------------------------------------
// Public entrypoint — run a single export job by id.
// ---------------------------------------------------------------------------

export interface ExportRunResult {
  jobId: string;
  status: "completed" | "failed" | "missing";
  filePath?: string;
  error?: string;
}

export async function runExportOnce(jobId: string): Promise<ExportRunResult> {
  // Step 1: claim the job.
  let userId: string | null = null;
  try {
    const claim = await sql<{ user_id: string }[]>`
      UPDATE export_jobs
         SET status = 'running', updated_at = now()
       WHERE id = ${jobId}
         AND status = 'queued'
       RETURNING user_id
    `;
    if (claim.length === 0) {
      log.warn({ reqId: reqIdTag(), jobId }, "no queued job with that id; skipping");
      return { jobId, status: "missing" };
    }
    userId = claim[0]!.user_id;
  } catch (err) {
    log.error({ err, jobId }, "failed to claim job");
    throw err;
  }

  try {
    const [user, conversations, messages, usageRecords, auditLog] = await Promise.all([
      fetchUser(userId),
      fetchConversations(userId),
      fetchMessages(userId),
      fetchUsageRecords(userId),
      fetchAuditLog(userId),
    ]);

    const bundle = buildBundle({
      jobId,
      userId,
      user,
      conversations,
      messages,
      usageRecords,
      auditLog,
    });

    const dir = resolve(EXPORTS_ROOT, jobId);
    const filePath = await writeBundleToDisk(bundle, dir);

    const expiresAt = new Date(Date.now() + EXPIRES_HOURS * 60 * 60 * 1000);

    await sql.begin(async (tx) => {
      await tx`
        UPDATE export_jobs
           SET status     = 'completed',
               file_path  = ${filePath},
               expires_at = ${expiresAt},
               updated_at = now()
         WHERE id = ${jobId}
      `;
      await appendAuditTx(
        tx,
        "gdpr.export_completed",
        "export_job",
        jobId,
        { userId, counts: bundle.manifest.counts, filePath },
        userId,
      );
    });

    log.info(
      { reqId: reqIdTag(), jobId, filePath, ...bundle.manifest.counts },
      "export complete",
    );
    return { jobId, status: "completed", filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, jobId }, "export failed");
    try {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE export_jobs
             SET status     = 'failed',
                 error      = ${message},
                 updated_at = now()
           WHERE id = ${jobId}
        `;
        await appendAuditTx(
          tx,
          "gdpr.export_failed",
          "export_job",
          jobId,
          { userId, error: message },
          userId,
        );
      });
    } catch (innerErr) {
      log.error({ err: innerErr, jobId }, "failed to mark job as failed");
    }
    return { jobId, status: "failed", error: message };
  }
}

// ---------------------------------------------------------------------------
// Worker pull loop.
// ---------------------------------------------------------------------------

async function pickNextJob(): Promise<string | null> {
  // SKIP LOCKED so multiple workers don't fight over the same row. We return
  // immediately if there's nothing queued.
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT id
        FROM export_jobs
       WHERE status = 'queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    `;
    return rows[0]?.id ?? null;
  } catch (err) {
    if (isMissingTable(err)) {
      log.warn({ reqId: reqIdTag() }, "export_jobs missing — skipping");
      return null;
    }
    throw err;
  }
}

async function mainLoop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const jobId = await pickNextJob();
      if (jobId) {
        await runExportOnce(jobId);
        continue;
      }
    } catch (err) {
      log.error({ err }, "export poll failed; continuing");
    }
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

if (import.meta.main) {
  log.info({ intervalMs: POLL_INTERVAL_MS, exportsRoot: EXPORTS_ROOT }, "gdpr-export worker starting");
  await mainLoop();
}
