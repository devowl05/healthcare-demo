/**
 * Postgres connection pool + transient-error retry helper.
 *
 * Uses `postgres` (porsager/postgres). Pool tuned for a single backend replica
 * driving SSE long-lived requests + short query bursts from CRUD endpoints.
 * The retry helper covers transient errors that can fire when Postgres restarts
 * or a connection dies mid-flight (ECONNRESET, admin_shutdown, cannot_connect_now).
 * Crucially, it refuses to retry when the caller is already inside a transaction
 * — re-running half of a txn would be silently incorrect.
 */

import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";
import { env } from "../env.ts";

export type DbClient = Sql<{}>;
export type DbTxn = TransactionSql<{}>;

/**
 * Process-wide pool. Importing this module establishes credentials but doesn't
 * open sockets — connections are lazily created on first query.
 */
export const sql: DbClient = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 5,
  // Suppress NOTICE chatter (e.g. "extension already exists"). Real errors
  // still surface through query rejections.
  onnotice: () => {},
});

/** Graceful shutdown — drain in-flight queries before closing sockets. */
export async function close(): Promise<void> {
  await sql.end({ timeout: 5 });
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

/** SQLSTATEs we treat as transient and retryable when not inside a txn. */
const TRANSIENT_SQLSTATES = new Set<string>([
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
]);

const TRANSIENT_CODES = new Set<string>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_SQLSTATES.has(code)) return true;
    if (TRANSIENT_CODES.has(code)) return true;
  }
  return false;
}

/**
 * Heuristic check: porsager/postgres exposes the running transaction via
 * `sql.begin(...)`'s callback argument. The library itself does not export a
 * public "am I in a transaction?" flag, so we instead require callers to pass
 * the explicit txn client when they want retries to be SKIPPED.
 *
 * Pattern:
 *   await withRetry(() => sql`SELECT 1`)            // retries
 *   await sql.begin(async (tx) => {
 *     await withRetry(() => tx`SELECT 1`, { tx })   // does NOT retry
 *   })
 */
export interface RetryOpts {
  /** Pass the active transaction client to opt out of retries. */
  tx?: DbTxn;
  /** Total attempts including the initial one. Default 3 (= 2 retries). */
  attempts?: number;
  /** Base backoff in ms before the first retry. Default 100. */
  baseDelayMs?: number;
  /** Cap on backoff. Default 2000. */
  maxDelayMs?: number;
  /** Hook for tests to skip real sleeps. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` with exponential backoff retry on transient DB errors. Re-throws
 * non-transient errors immediately. Skips retry entirely when `opts.tx` is
 * provided — a partial transaction is not safe to re-run.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 100;
  const cap = opts.maxDelayMs ?? 2000;
  const sleep = opts.sleep ?? defaultSleep;
  const insideTxn = opts.tx !== undefined;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (insideTxn || !isTransient(err) || attempt === attempts) {
        throw err;
      }
      const delay = Math.min(cap, base * 2 ** (attempt - 1));
      // Full jitter
      const jittered = Math.floor(Math.random() * delay);
      await sleep(jittered);
    }
  }
  throw lastErr;
}
