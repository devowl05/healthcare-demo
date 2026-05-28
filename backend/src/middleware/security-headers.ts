/**
 * Security headers middleware.
 *
 * Adds the standard browser-side hardening headers per the plan. The CSP is
 * tight (`'self'` for scripts and styles plus an explicit allowlist for
 * api.openai.com); if the frontend ever needs to inline a script tag we'll
 * switch to a nonce instead of loosening to `'unsafe-inline'`.
 *
 * `/metrics` is skipped so curl-friendly Prometheus scrape clients don't get
 * a CSP they ignore anyway.
 */

import type { MiddlewareHandler } from "hono";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://api.openai.com",
  "media-src 'self' blob:",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const HSTS = "max-age=31536000; includeSubDomains; preload";

const PERMISSIONS_POLICY =
  "microphone=(self), camera=(), geolocation=(), payment=()";

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    await next();
    if (path === "/metrics") return;
    c.header("Strict-Transport-Security", HSTS);
    c.header("Content-Security-Policy", CSP);
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", PERMISSIONS_POLICY);
  };
}
