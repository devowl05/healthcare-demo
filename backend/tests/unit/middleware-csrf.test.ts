/**
 * CSRF double-submit-cookie tests.
 *
 * GET requests must pass without a token. Mutating requests require the
 * `X-CSRF-Token` header to match the `csrf_token` cookie.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { csrf, setCsrfCookie } from "../../src/middleware/csrf.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("*", csrf());
  app.get("/safe", (c) => c.json({ ok: true }));
  app.post("/mutate", (c) => c.json({ ok: true }));
  // Endpoint to issue the cookie (we don't go through it in tests; we mint
  // the cookie value directly to assert the equality check).
  app.get("/login", (c) => {
    const token = setCsrfCookie(c);
    return c.json({ token });
  });
  return app;
}

describe("csrf middleware", () => {
  it("passes through safe methods (GET) with no cookie or header", async () => {
    const app = buildApp();
    const res = await app.request("/safe");
    expect(res.status).toBe(200);
  });

  it("rejects POST with missing token", async () => {
    const app = buildApp();
    const res = await app.request("/mutate", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("csrf_failed");
  });

  it("rejects POST when header and cookie mismatch", async () => {
    const app = buildApp();
    const res = await app.request("/mutate", {
      method: "POST",
      headers: {
        cookie: "csrf_token=aaaa",
        "x-csrf-token": "bbbb",
      },
    });
    expect(res.status).toBe(403);
  });

  it("passes POST when header matches cookie", async () => {
    const app = buildApp();
    const token = "0123456789abcdef0123456789abcdef";
    const res = await app.request("/mutate", {
      method: "POST",
      headers: {
        cookie: `csrf_token=${token}`,
        "x-csrf-token": token,
      },
    });
    expect(res.status).toBe(200);
  });

  it("setCsrfCookie writes a Set-Cookie header with the issued token", async () => {
    const app = buildApp();
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("csrf_token=");
    expect(setCookie).toContain("SameSite=Strict");
    const body = (await res.json()) as { token: string };
    expect(body.token.length).toBeGreaterThan(0);
  });
});
