/**
 * Liveness + readiness routes.
 *
 *   - `GET /health` — process is up. Always 200 unless we're shutting down.
 *   - `GET /ready`  — process is fit to take traffic: DB responds to `SELECT 1`
 *     and a cached `openai.models.list` ping is fresh. Failures return 503 +
 *     `{ ok: false, reason }` so a load balancer can yank us out of rotation.
 *
 * The OpenAI ping is cached for 30 seconds so probes don't hammer the
 * provider; we treat the cached value as fresh-enough for the next probe in
 * that window. Liveness intentionally does NOT depend on either check so a
 * brief upstream outage doesn't restart the pod.
 */

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { childLogger } from "../obs/logger.ts";

const log = childLogger("routes/health");

const VERSION = "0.1.0";

/** True until `markUnhealthy()` is called — used by graceful-shutdown hooks. */
let alive = true;
export function markUnhealthy(): void {
  alive = false;
}

interface OpenAIProbe {
  ok: boolean;
  checkedAt: number;
  reason?: string;
}

const OPENAI_PROBE_TTL_MS = 30_000;
let openaiCache: OpenAIProbe = { ok: true, checkedAt: 0 };

/**
 * Cheap ping that calls `openai.models.list()`. Wrapped in try/catch so a
 * provider outage doesn't poison readiness for the full 30s — we'll just
 * report stale-OK until the next refresh.
 *
 * Kept as a module-level function so tests can stub it via the cache mutator
 * below without monkey-patching the SDK.
 */
async function probeOpenAI(now: number): Promise<OpenAIProbe> {
  if (now - openaiCache.checkedAt < OPENAI_PROBE_TTL_MS) {
    return openaiCache;
  }
  try {
    // Lazy import so unit tests can run without instantiating the SDK.
    const { default: OpenAI } = await import("openai");
    const { env } = await import("../env.ts");
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    // `models.list` returns quickly; we don't iterate the page.
    await client.models.list();
    openaiCache = { ok: true, checkedAt: now };
  } catch (err) {
    log.debug({ err }, "openai_ready_probe_failed");
    openaiCache = {
      ok: false,
      checkedAt: now,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return openaiCache;
}

/** Test hook: forcibly mark the OpenAI probe healthy without an SDK call. */
export function _setOpenAIProbeForTesting(value: OpenAIProbe): void {
  openaiCache = value;
}

async function probeDb(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await sql`SELECT 1`;
    return { ok: true };
  } catch (err) {
    log.debug({ err }, "db_ready_probe_failed");
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function buildHealthRouter(): Hono {
  const router = new Hono();

  router.get("/health", (c) => {
    if (!alive) return c.json({ ok: false, version: VERSION }, 503);
    return c.json({ ok: true, version: VERSION });
  });

  router.get("/ready", async (c) => {
    if (!alive) return c.json({ ok: false, reason: "shutting_down" }, 503);
    const db = await probeDb();
    if (!db.ok) {
      return c.json({ ok: false, reason: `db: ${db.reason}` }, 503);
    }
    const openai = await probeOpenAI(Date.now());
    if (!openai.ok) {
      return c.json({ ok: false, reason: `openai: ${openai.reason}` }, 503);
    }
    return c.json({ ok: true });
  });

  return router;
}

export const healthRouter = buildHealthRouter();
