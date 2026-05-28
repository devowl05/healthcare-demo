/**
 * Repo-test strategy decision (TIER 2b)
 * ------------------------------------------------------------
 * Unit tests in this directory deliberately do NOT exercise SQL execution
 * end-to-end. Reasons:
 *
 *   1. `postgres` (porsager/postgres) doesn't ship a documented in-memory
 *      fake, and rewriting tagged-template behavior faithfully (parameter
 *      binding, transaction/savepoint semantics, generators) is more code
 *      than the SQL it would exercise.
 *   2. The repo modules are thin — they're string-builders + a withRetry
 *      wrapper. The genuine value lives in catching schema/index drift,
 *      which only a real Postgres can detect.
 *
 * So we split the testing pyramid:
 *
 *   - PURE LOGIC (no DB) — covered here. e.g. the audit-log hash-chain
 *     computation in `audit-log-hashchain.test.ts`.
 *   - DB-COUPLED REPO LOGIC — deferred to integration tests in Tier 3 that
 *     spin up a real Postgres via docker-compose, run migrations, and assert
 *     row shapes.
 *
 * The stub below is exported for any future unit test that needs to assert
 * the SHAPE of an interpolation (e.g. "did the caller actually filter by
 * deleted_at IS NULL?") without standing up a database. It records every
 * tagged-template invocation and returns whatever value the test
 * pre-programmed. Real queries (`UPDATE`/`INSERT`) call it, so the recorded
 * strings reveal regressions in filter clauses.
 */

export interface RecordedCall {
  /** Joined SQL string with `$N` placeholders preserved. */
  text: string;
  /** Values that were interpolated. */
  values: unknown[];
}

export type StubResponder<T = unknown> = (
  call: RecordedCall,
) => T | Promise<T>;

export interface SqlStub {
  /** Records every call. */
  calls: RecordedCall[];
  /** Tagged-template function the modules call as `sql\`SELECT...\``. */
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  /** Queue a single response (FIFO). */
  enqueue<T>(value: T): void;
  /** Override the responder; replaces the FIFO queue. */
  respondWith<T>(fn: StubResponder<T>): void;
  /** Reset state between assertions. */
  reset(): void;
}

export function createSqlStub(): SqlStub {
  const calls: RecordedCall[] = [];
  const queue: unknown[] = [];
  let responder: StubResponder | null = null;

  function joinTemplate(strings: TemplateStringsArray): string {
    let out = "";
    for (let i = 0; i < strings.length; i++) {
      out += strings[i] ?? "";
      if (i < strings.length - 1) out += `$${i + 1}`;
    }
    return out;
  }

  async function sql(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown> {
    const call: RecordedCall = { text: joinTemplate(strings), values };
    calls.push(call);
    if (responder) return responder(call);
    if (queue.length === 0) return [];
    return queue.shift();
  }

  return {
    calls,
    sql,
    enqueue(value) {
      queue.push(value);
    },
    respondWith(fn) {
      responder = fn as StubResponder;
    },
    reset() {
      calls.length = 0;
      queue.length = 0;
      responder = null;
    },
  };
}
