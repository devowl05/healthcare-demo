/**
 * CORS middleware.
 *
 * Thin wrapper over `hono/cors` that pulls the allowlist from `env.CORS_ALLOWED_ORIGINS`.
 * `credentials: true` is required so the access-token cookie is sent on
 * cross-origin requests from the SPA dev server. The browser will refuse to
 * honor `Access-Control-Allow-Origin: *` with credentials, hence the explicit
 * allowlist.
 */

import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { env } from "../env.ts";

export function corsMiddleware(): MiddlewareHandler {
  return cors({
    origin: env.CORS_ALLOWED_ORIGINS,
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Request-Id",
      "X-CSRF-Token",
      "Idempotency-Key",
    ],
    exposeHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: 600,
  });
}
