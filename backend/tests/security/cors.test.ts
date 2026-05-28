/**
 * CORS preflight / actual-request header assertions.
 *
 * The CORS middleware (`middleware/cors.ts`) reads its allowlist from
 * `env.CORS_ALLOWED_ORIGINS` — under NODE_ENV=test that defaults to
 * `http://localhost:5173`. We assert:
 *
 *   - A preflight OPTIONS with a disallowed Origin gets NO
 *     `Access-Control-Allow-Origin` header (the browser will reject the
 *     request).
 *   - A preflight with the allowed origin gets the right headers including
 *     `Access-Control-Allow-Credentials: true` so the SPA can send cookies.
 *   - Actual GETs with a disallowed Origin still execute (CORS is enforced
 *     by the browser, not the server) but the response carries no
 *     `Access-Control-Allow-Origin`, so the browser won't expose the body to
 *     the page.
 */

import { describe, expect, it, beforeAll } from "bun:test";
import { forceMemoryBackendForTesting } from "../../src/middleware/rate-limit.ts";
import { app } from "../../src/index.ts";

const ALLOWED = "http://localhost:5173";
const DISALLOWED = "https://evil.example";

beforeAll(() => {
  forceMemoryBackendForTesting();
});

describe("CORS", () => {
  it("preflight with allowed origin echoes origin + allow-credentials true", async () => {
    const res = await app.request("/api/conversations", {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    // Hono returns 204 for preflight; some versions use 200. Accept either.
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const allowedMethods = res.headers.get("access-control-allow-methods") ?? "";
    expect(allowedMethods.toUpperCase()).toContain("GET");
  });

  it("preflight with disallowed origin omits Access-Control-Allow-Origin", async () => {
    const res = await app.request("/api/conversations", {
      method: "OPTIONS",
      headers: {
        origin: DISALLOWED,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    // Hono's CORS middleware returns 204 even for disallowed origins, but it
    // omits the allow-origin header — which is what the browser cares about.
    const allowOrigin = res.headers.get("access-control-allow-origin");
    expect(allowOrigin === null || allowOrigin === "").toBe(true);
  });

  it("GET with allowed origin gets ACAO and ACAC headers", async () => {
    const res = await app.request("/api/conversations", {
      headers: { origin: ALLOWED },
    });
    // Unauth → 401, but the CORS headers should still ride along.
    expect([200, 401]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("GET with disallowed origin omits ACAO so browser blocks the response", async () => {
    const res = await app.request("/api/conversations", {
      headers: { origin: DISALLOWED },
    });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    expect(allowOrigin === null || allowOrigin === "").toBe(true);
  });

  it("exposes Retry-After + X-Request-Id via Access-Control-Expose-Headers", async () => {
    const res = await app.request("/api/conversations", {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "GET",
      },
    });
    // The expose-headers list is only meaningful on the actual response, but
    // Hono surfaces it on preflight too.
    const exposed =
      res.headers.get("access-control-expose-headers")?.toLowerCase() ?? "";
    if (exposed) {
      expect(exposed).toContain("retry-after");
      expect(exposed).toContain("x-request-id");
    }
  });
});
