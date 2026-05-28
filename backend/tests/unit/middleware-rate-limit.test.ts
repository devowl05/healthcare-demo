/**
 * Rate-limit middleware tests.
 *
 * Forces the in-memory backend so we never touch Redis. We use a 5-points /
 * 60-second bucket and assert that the 6th hit gets 429 with `Retry-After`
 * in the response headers.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import {
  forceMemoryBackendForTesting,
  rateLimit,
  tripStreamLimit,
} from "../../src/middleware/rate-limit.ts";

beforeAll(() => {
  forceMemoryBackendForTesting();
});

function buildApp() {
  const app = new Hono();
  app.use("/api/*", rateLimit({ name: "test-bucket", points: 5, windowSec: 60 }));
  app.get("/api/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimit middleware", () => {
  it("allows up to N requests, then 429s with Retry-After", async () => {
    const app = buildApp();
    const ip = "203.0.113.5";
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/ping", {
        headers: { "x-forwarded-for": ip },
      });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request("/api/ping", {
      headers: { "x-forwarded-for": ip },
    });
    expect(blocked.status).toBe(429);
    const retry = blocked.headers.get("retry-after");
    expect(retry).not.toBeNull();
    expect(Number(retry)).toBeGreaterThan(0);
    const body = (await blocked.json()) as { code: string };
    expect(body.code).toBe("rate_limited");
  });

  it("buckets per IP independently", async () => {
    const app = buildApp();
    const ipA = "203.0.113.10";
    const ipB = "203.0.113.11";
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/ping", {
        headers: { "x-forwarded-for": ipA },
      });
      expect(res.status).toBe(200);
    }
    // ipB has its own bucket; should still succeed.
    const res = await app.request("/api/ping", {
      headers: { "x-forwarded-for": ipB },
    });
    expect(res.status).toBe(200);
  });
});

describe("tripStreamLimit", () => {
  it("returns the SSE-friendly error frame", () => {
    const frame = tripStreamLimit(42);
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("rate_limited");
    expect(frame.retry_after_seconds).toBe(42);
  });
});
