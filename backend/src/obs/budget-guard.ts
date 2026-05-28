/**
 * Daily-spend guard.
 *
 * Reads today's cumulative cost from the `cost_daily_rollup` materialized
 * view (populated by a cron in Tier 2d) and caches it. The HTTP middleware
 * calls `isOverBudget()` on every chat request; a refresh tick runs in the
 * background every 60s.
 *
 * Refresh failures are silent on purpose: a transient DB hiccup must not
 * suddenly enforce an over-budget block. We keep serving the last known
 * value and let the next refresh recover.
 *
 * No DB client is imported here — callers inject the `sql` template tag,
 * which lets tests pass a fake without standing up Postgres.
 */

import { childLogger } from "./logger";

const log = childLogger("budget-guard");

/** Minimal interface that the real `postgres` template tag satisfies. */
export type SqlExecutor = <T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export interface BudgetGuardOptions {
  /** Refresh interval in ms; tests can pass 0 to disable timer. */
  refreshMs?: number;
  /** Override `Date.now` for tests. */
  now?: () => number;
}

export class BudgetGuard {
  private cost = 0;
  private readonly limit: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly refreshMs: number;
  private readonly now: () => number;

  constructor(
    private readonly sql: SqlExecutor,
    limitUsd: number,
    opts: BudgetGuardOptions = {},
  ) {
    this.limit = limitUsd;
    this.refreshMs = opts.refreshMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Start the background refresh tick and do an initial refresh. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.refreshMs > 0) {
      this.timer = setInterval(() => {
        void this.refresh();
      }, this.refreshMs);
      // Don't keep the process alive solely for this.
      if (typeof (this.timer as unknown as { unref?: () => void }).unref === "function") {
        (this.timer as unknown as { unref: () => void }).unref();
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** True when today's spend has met or exceeded the configured cap. */
  isOverBudget(): boolean {
    return this.cost >= this.limit;
  }

  current(): { cost: number; limit: number } {
    return { cost: this.cost, limit: this.limit };
  }

  /**
   * Force a refresh now. Exposed for the admin route + tests; the background
   * tick uses this same method.
   */
  async refresh(): Promise<void> {
    try {
      const today = new Date(this.now()).toISOString().slice(0, 10);
      // The materialized view shape is `(day date, cost_usd numeric)`.
      const rows = await this.sql<{ cost_usd: string | number | null }>`
        SELECT cost_usd FROM cost_daily_rollup WHERE day = ${today} LIMIT 1
      `;
      const raw = rows[0]?.cost_usd ?? 0;
      const next = typeof raw === "string" ? Number.parseFloat(raw) : Number(raw);
      if (Number.isFinite(next)) {
        this.cost = next;
      }
    } catch (err) {
      // Leniency: keep the last known value and log at debug. We do NOT
      // toggle into a "blocked" state on a transient DB failure.
      log.debug({ err }, "budget refresh failed; keeping prior value");
    }
  }
}
