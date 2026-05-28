/**
 * Rate-limit envelope tests.
 *
 * The chat route is protected by `rateLimit({ name: "chat", points: 20, windowSec: 60 })`
 * applied per-IP AND per-user (when authenticated). This suite hammers an
 * unauthenticated endpoint to assert the IP-keyed limiter kicks in even when
 * the request is rejected at auth time — the limiter runs AFTER auth in the
 * middleware stack, so unauth requests don't actually consume the chat
 * limiter. Instead we exercise a route that doesn't require auth but DOES go
 * through a rate limiter: there isn't one in the current setup, so we test
 * the limiter behavior directly via the chat path with a forged authn-shape.
 *
 * Strategy:
 *   - Force the in-memory rate-limiter backend (so Redis isn't required).
 *   - Burst N requests from the same client IP via `app.request()` with the
 *     `X-Forwarded-For` header set. Since requests are missing a valid bearer
 *     they will 401 BEFORE the rate-limiter — that's correct behavior, the
 *     limiter only runs post-auth.
 *
 *   - Therefore the actual coverage here is on the rate-limiter middleware
 *     itself, called as a pure unit. We import `rateLimit()` and call it
 *     against a tiny Hono app so we can drive 30+ requests through it
 *     deterministically.
 */

import { describe, expect, it, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  forceMemoryBackendForTesting,
  rateLimit,
} from "../../src/middleware/rate-limit.ts";

function buildTinyApp(): Hono {
  const app = new Hono();
  app.use("*", rateLimit({ name: "test", points: 5, windowSec: 60 }));
  app.get("/ping", (c) => c.text("pong"));
  return app;
}

beforeAll(() => {
  forceMemoryBackendForTesting();
});

describe("rateLimit middleware", () => {
  it("burst of N+1 requests: first N pass, last gets 429 + Retry-After", async () => {
    const app = buildTinyApp();
    // Use a unique IP so the in-memory store is empty for this test.
    const ip = `10.99.${Math.floor(Math.random() * 254)}.${Math.floor(
      Math.random() * 254,
    )}`;
    const headers = { "x-forwarded-for": ip };

    // 5 should pass.
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/ping", { headers });
      expect(res.status).toBe(200);
    }
    // 6th must be 429.
    const overflow = await app.request("/ping", { headers });
    expect(overflow.status).toBe(429);
    const retryAfter = overflow.headers.get("retry-after");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);

    const body = (await overflow.json()) as {
      code: string;
      retry_after_seconds: number;
    };
    expect(body.code).toBe("rate_limited");
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  it("different IPs have independent buckets", async () => {
    const app = buildTinyApp();
    const ipA = "10.0.0.1";
    const ipB = "10.0.0.2";

    // Use up ipA's quota.
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/ping", { headers: { "x-forwarded-for": ipA } });
      expect(res.status).toBe(200);
    }
    // ipA is now blocked.
    const blockedA = await app.request("/ping", {
      headers: { "x-forwarded-for": ipA },
    });
    expect(blockedA.status).toBe(429);
    // ipB still has a full bucket.
    const passB = await app.request("/ping", {
      headers: { "x-forwarded-for": ipB },
    });
    expect(passB.status).toBe(200);
  });

  it("burst of 30 from one IP returns ~5 successes and the rest 429", async () => {
    const app = buildTinyApp();
    const ip = `192.0.2.${Math.floor(Math.random() * 254)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await app.request("/ping", {
        headers: { "x-forwarded-for": ip },
      });
      statuses.push(res.status);
      // Drain body so we don't leave dangling sockets.
      await res.text();
    }
    const ok = statuses.filter((s) => s === 200).length;
    const limited = statuses.filter((s) => s === 429).length;
    // The first 5 should pass, the remaining 25 should be 429.
    expect(ok).toBe(5);
    expect(limited).toBe(25);
  });
});
