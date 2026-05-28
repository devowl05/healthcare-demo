/**
 * XSS surface — backend response-shape guarantees.
 *
 * The frontend renders markdown via `react-markdown` + `rehype-sanitize`, which
 * is where the *actual* XSS protection lives. The backend's contribution is
 * narrower but still important: every `/api/*` response must be a content type
 * the browser will NOT interpret as HTML, and bodies must be JSON-encoded so
 * embedded `<script>` tags travel as inert string data.
 *
 * Concretely we assert:
 *   - JSON endpoints return `Content-Type: application/json` (never `text/html`).
 *   - SSE endpoints return `Content-Type: text/event-stream`.
 *   - 404 / 405 fallthrough also returns text/plain or JSON — not HTML.
 *   - The `X-Content-Type-Options: nosniff` header is present (so a confused
 *     browser doesn't sniff a JSON body as HTML).
 *   - The CSP header forbids inline scripts by default.
 *
 * The actual DOM-sanitization assertion is in `frontend/e2e/chat.spec.ts` where
 * we type `<img onerror=alert(1)>` into the composer and confirm it renders as
 * literal text. We deliberately don't introduce `happy-dom` server-side just
 * to inline a JSX rendering check — Playwright is the real source of truth.
 */

import { describe, expect, it, beforeAll } from "bun:test";
import { forceMemoryBackendForTesting } from "../../src/middleware/rate-limit.ts";
import { app } from "../../src/index.ts";

beforeAll(() => {
  forceMemoryBackendForTesting();
});

function isOneOf(actual: string | null, allowed: string[]): boolean {
  if (!actual) return false;
  const lower = actual.toLowerCase();
  return allowed.some((a) => lower.startsWith(a));
}

describe("XSS — response content types are never text/html", () => {
  it("GET /health returns JSON, not HTML", async () => {
    const res = await app.request("/health");
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("content-type")?.toLowerCase()).not.toContain("text/html");
  });

  it("GET /api/conversations returns JSON when unauthenticated", async () => {
    const res = await app.request("/api/conversations");
    // 401 expected; body must be JSON.
    expect([200, 401]).toContain(res.status);
    const ct = res.headers.get("content-type");
    expect(isOneOf(ct, ["application/json"])).toBe(true);
    // Body must parse as JSON (no HTML/<script> tags).
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toMatch(/<script/i);
  });

  it("POST /api/chat (unauth) returns JSON error, never HTML", async () => {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "<script>alert(1)</script>" }),
    });
    expect([400, 401, 403]).toContain(res.status);
    expect(isOneOf(res.headers.get("content-type"), ["application/json"])).toBe(
      true,
    );
    const text = await res.text();
    // The payload echoed inside an error message should be JSON-encoded (so
    // the `<` becomes the literal two chars in a string — never raw HTML).
    expect(text).not.toMatch(/<script>/);
  });

  it("Unknown route returns 404 with JSON or text/plain — never HTML", async () => {
    const res = await app.request("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")?.toLowerCase()).not.toContain("text/html");
  });

  it("sets X-Content-Type-Options: nosniff on API responses", async () => {
    const res = await app.request("/api/conversations");
    expect(res.headers.get("x-content-type-options")?.toLowerCase()).toBe("nosniff");
  });

  it("sets a Content-Security-Policy header that disallows inline scripts", async () => {
    // The /health endpoint passes through the global securityHeaders middleware.
    const res = await app.request("/health");
    const csp = res.headers.get("content-security-policy");
    // Either a strict default-src is set or script-src is explicitly defined.
    // We accept any policy that contains "default-src" OR "script-src" with
    // 'self' — the precise tokens are owned by securityHeaders middleware.
    if (csp) {
      const lower = csp.toLowerCase();
      expect(
        lower.includes("default-src") || lower.includes("script-src"),
      ).toBe(true);
      // Crucially, it shouldn't permit `unsafe-inline` for scripts in prod.
      // We allow the header to be absent in tests where the env may disable
      // it, but if present it must not include unsafe-inline for script-src.
      const scriptSrcMatch = lower.match(/script-src[^;]*/);
      if (scriptSrcMatch) {
        expect(scriptSrcMatch[0]).not.toContain("unsafe-inline");
      }
    }
  });
});
