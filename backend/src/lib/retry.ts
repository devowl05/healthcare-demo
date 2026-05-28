/**
 * Exponential backoff with full jitter.
 *
 * Delay for attempt n (1-indexed) is `random(0, min(cap, base * 2^(n-1)))`,
 * which is the "Full Jitter" strategy from the AWS architecture blog —
 * better at spreading retries than pure exponential.
 *
 * `retryOn` decides whether an error is transient. The default honors a
 * `Retry-After` header when the thrown value looks like a fetch `Response`
 * or carries a `.retryAfterMs` field; everything else: retry if `5xx` or
 * unspecified, do NOT retry if `4xx`.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  /** When true, use full-jitter; when false, sleep exactly the computed backoff. */
  jitter: boolean;
  /** Decides whether to retry a given error; receives attempt count (1-based). */
  retryOn: (err: unknown, attempt: number) => boolean;
  /** Override `setTimeout` for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the random source for tests. */
  random?: () => number;
}

const DEFAULTS: RetryOptions = {
  maxAttempts: 3,
  baseMs: 500,
  capMs: 8_000,
  jitter: true,
  retryOn: defaultRetryOn,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRetryOn(err: unknown, _attempt: number): boolean {
  if (err && typeof err === "object") {
    const e = err as { status?: number; statusCode?: number; code?: string };
    const status = e.status ?? e.statusCode;
    if (typeof status === "number") {
      if (status >= 500 || status === 408 || status === 429) return true;
      if (status >= 400) return false;
    }
    if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT" || e.code === "EAI_AGAIN") {
      return true;
    }
  }
  // Unknown errors: retry by default; the maxAttempts cap is the safety net.
  return true;
}

/**
 * Pull a Retry-After value from an error if present. Supports:
 *   - `err.retryAfterMs` direct number
 *   - `err.headers.get("retry-after")` (Fetch Response shape)
 *   - `err.response?.headers?.["retry-after"]` (axios shape)
 * Value can be seconds (number string) or an HTTP date.
 */
function retryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  if (typeof e.retryAfterMs === "number") return e.retryAfterMs;

  let raw: string | null = null;
  const headers = e.headers as { get?: (k: string) => string | null } | undefined;
  if (headers && typeof headers.get === "function") {
    raw = headers.get("retry-after");
  }
  if (!raw) {
    const resp = e.response as { headers?: Record<string, string> } | undefined;
    if (resp?.headers) {
      raw = resp.headers["retry-after"] ?? resp.headers["Retry-After"] ?? null;
    }
  }
  if (!raw) return null;

  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return Math.max(0, asNum * 1000);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

export async function withBackoff<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULTS, ...options };
  const sleep = opts.sleep ?? defaultSleep;
  const rand = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === opts.maxAttempts;
      if (isLast || !opts.retryOn(err, attempt)) {
        throw err;
      }
      const exp = Math.min(opts.capMs, opts.baseMs * 2 ** (attempt - 1));
      const jittered = opts.jitter ? rand() * exp : exp;
      const hinted = retryAfterMs(err);
      const delay = hinted !== null ? Math.min(opts.capMs, hinted) : jittered;
      await sleep(delay);
    }
  }
  // Unreachable — the loop always returns or throws on the last attempt.
  throw lastErr;
}
