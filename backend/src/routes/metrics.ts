/**
 * Prometheus scrape endpoint.
 *
 * Gated by `env.METRICS_ENABLED` — when the flag is off we return 404 so a
 * scraper that's accidentally pointed at us doesn't get fed an empty body
 * (which would silently look like a healthy-but-empty target).
 *
 * Optional bearer authentication via `env.METRICS_BEARER`. When the secret is
 * set, requests must carry `Authorization: Bearer <token>` (matched in
 * constant-time). Public scraping is allowed when no secret is configured —
 * the operator opt-in is the explicit env var, not a default-deny — to keep
 * local development frictionless.
 */

import { Hono } from "hono";
import { env } from "../env.ts";
import { register } from "../obs/metrics.ts";

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function buildMetricsRouter(): Hono {
  const router = new Hono();

  router.get("/metrics", async (c) => {
    if (!env.METRICS_ENABLED) {
      return c.json({ code: "metrics_disabled", message: "metrics endpoint disabled" }, 404);
    }
    const expected = env.METRICS_BEARER;
    if (expected) {
      const header = c.req.header("authorization");
      if (!header || !header.toLowerCase().startsWith("bearer ")) {
        return c.json({ code: "auth_missing", message: "metrics requires bearer token" }, 401);
      }
      const provided = header.slice(7).trim();
      if (!timingSafeEqualHex(provided, expected)) {
        return c.json({ code: "auth_invalid", message: "invalid metrics token" }, 401);
      }
    }
    const body = await register.metrics();
    return c.body(body, 200, {
      "Content-Type": register.contentType,
    });
  });

  return router;
}

export const metricsRouter = buildMetricsRouter();
