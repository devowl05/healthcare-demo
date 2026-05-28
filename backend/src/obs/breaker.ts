/**
 * Per-provider circuit breaker.
 *
 * State machine:
 *   closed     — normal operation; failures increment a window counter.
 *   open       — fast-fail with `BreakerOpenError` for `cooldownMs`.
 *   half_open  — after cooldown, the next call is allowed through as a probe.
 *                Two consecutive successes close the breaker; any failure
 *                trips it back to open and resets the cooldown.
 *
 * Failures are tracked in a sliding window (`failureWindowMs`): the breaker
 * only opens when `failureThreshold` failures happen within the window, so
 * a single bad day from yesterday won't trip today.
 *
 * Time is read via an injectable `now()` so tests can drive the clock without
 * `sinon`-style global patching.
 */

export type BreakerState = "closed" | "open" | "half_open";

export class BreakerOpenError extends Error {
  readonly code = "BREAKER_OPEN";
  readonly retryAt: number;
  constructor(name: string, retryAt: number) {
    super(`circuit breaker open for "${name}"`);
    this.name = "BreakerOpenError";
    this.retryAt = retryAt;
  }
}

export interface BreakerOptions {
  /** Failures needed to trip from closed → open. */
  failureThreshold: number;
  /** Time window for accumulating failures in closed state. */
  failureWindowMs: number;
  /** How long the breaker stays open before allowing a probe. */
  cooldownMs: number;
  /** Successful probes in half_open required to close. */
  successesToClose: number;
  /** Injectable clock for tests. */
  now: () => number;
}

const DEFAULTS: BreakerOptions = {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
  successesToClose: 2,
  now: () => Date.now(),
};

interface Entry {
  state: BreakerState;
  /** Timestamps of failures inside the current window. */
  failures: number[];
  /** Timestamp the breaker opened, or 0 when closed. */
  openedAt: number;
  /** Successful probes accumulated while in half_open. */
  probeSuccesses: number;
}

function emptyEntry(): Entry {
  return { state: "closed", failures: [], openedAt: 0, probeSuccesses: 0 };
}

export class CircuitBreaker {
  private readonly opts: BreakerOptions;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: Partial<BreakerOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Inspect current state (mostly for tests / metrics). */
  state(name: string): BreakerState {
    const e = this.entries.get(name);
    if (!e) return "closed";
    this.transitionFromTime(name, e);
    return e.state;
  }

  /**
   * Execute `fn` under the breaker for `name`. Throws `BreakerOpenError`
   * fast when open. Rethrows the underlying error on failure (after
   * counting it).
   */
  async exec<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const e = this.entries.get(name) ?? emptyEntry();
    if (!this.entries.has(name)) this.entries.set(name, e);
    this.transitionFromTime(name, e);

    if (e.state === "open") {
      throw new BreakerOpenError(name, e.openedAt + this.opts.cooldownMs);
    }

    try {
      const result = await fn();
      this.recordSuccess(e);
      return result;
    } catch (err) {
      this.recordFailure(e);
      throw err;
    }
  }

  /** Force the breaker back to closed; useful for admin endpoints / tests. */
  reset(name: string): void {
    this.entries.set(name, emptyEntry());
  }

  // --- internals ---

  private transitionFromTime(_name: string, e: Entry): void {
    if (e.state === "open") {
      const now = this.opts.now();
      if (now - e.openedAt >= this.opts.cooldownMs) {
        e.state = "half_open";
        e.probeSuccesses = 0;
      }
    }
    // Prune stale failures from the sliding window.
    const cutoff = this.opts.now() - this.opts.failureWindowMs;
    while (e.failures.length > 0 && e.failures[0]! < cutoff) {
      e.failures.shift();
    }
  }

  private recordSuccess(e: Entry): void {
    if (e.state === "half_open") {
      e.probeSuccesses += 1;
      if (e.probeSuccesses >= this.opts.successesToClose) {
        e.state = "closed";
        e.failures = [];
        e.openedAt = 0;
        e.probeSuccesses = 0;
      }
      return;
    }
    if (e.state === "closed") {
      // A success in closed state doesn't clear historical failures (we let
      // the sliding window handle that), but it does reset probe counters.
      e.probeSuccesses = 0;
    }
  }

  private recordFailure(e: Entry): void {
    const now = this.opts.now();
    if (e.state === "half_open") {
      // Probe failed — back to open with a fresh cooldown.
      e.state = "open";
      e.openedAt = now;
      e.probeSuccesses = 0;
      return;
    }
    e.failures.push(now);
    if (e.failures.length >= this.opts.failureThreshold) {
      e.state = "open";
      e.openedAt = now;
      e.probeSuccesses = 0;
    }
  }
}

/**
 * Process-wide singleton used by HTTP clients. Tests should construct their
 * own `new CircuitBreaker({ now: fakeClock })` instead of touching this.
 */
export const breaker = new CircuitBreaker();
