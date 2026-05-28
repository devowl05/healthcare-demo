/**
 * Centralized Hono `onError` handler.
 *
 * Maps known error classes to stable response envelopes — every error body
 * carries `{ code, requestId, ... }` so the frontend can show actionable
 * messages and the on-call can correlate via the logs.
 *
 * Anything we don't recognize becomes a 500 with `code: "internal"` and the
 * original error logged at error level (NEVER returned in the body — that
 * leaks internals).
 */

import type { Context } from "hono";
import { ZodError } from "zod";
import { BreakerOpenError } from "../obs/breaker.ts";
import { CursorError } from "../lib/cursor.ts";
import { logger } from "../obs/logger.ts";
import { AuthError } from "./auth.ts";
import { CsrfError } from "./csrf.ts";

export type ErrorEnvelope = {
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
};

function requestIdFrom(c: Context): string {
  return (c.get("requestId") as string | undefined) ?? "unknown";
}

// Hono types `onError` as accepting a value of `unknown` shape via the
// framework's error interface; we accept the same.
type ErrorHandler = (err: Error, c: Context) => Response | Promise<Response>;

export const errorHandler: ErrorHandler = (err, c) => {
  const requestId = requestIdFrom(c);

  // 1. zod validation
  if (err instanceof ZodError) {
    const body: ErrorEnvelope = {
      code: "validation_failed",
      message: "request payload failed validation",
      requestId,
      details: err.issues,
    };
    return c.json(body, 400);
  }

  // 2. cursor decode
  if (err instanceof CursorError) {
    const body: ErrorEnvelope = {
      code: err.code === "CURSOR_MALFORMED" ? "cursor_malformed" : "cursor_invalid",
      message: err.message,
      requestId,
    };
    return c.json(body, 400);
  }

  // 3. breaker open
  if (err instanceof BreakerOpenError) {
    const retryAt = Math.max(0, Math.ceil((err.retryAt - Date.now()) / 1000));
    c.header("Retry-After", String(retryAt));
    const body: ErrorEnvelope = {
      code: "service_unavailable",
      message: "upstream provider is temporarily unavailable",
      requestId,
    };
    return c.json(body, 503);
  }

  // 4. auth / csrf
  if (err instanceof AuthError) {
    const body: ErrorEnvelope = {
      code: err.code.toLowerCase(),
      message: err.message,
      requestId,
    };
    return c.json(body, err.status);
  }
  if (err instanceof CsrfError) {
    const body: ErrorEnvelope = {
      code: err.code.toLowerCase(),
      message: err.message,
      requestId,
    };
    return c.json(body, err.status);
  }

  // 5. fallthrough — log + opaque 500
  logger.error({ err, requestId }, "unhandled_error");
  const body: ErrorEnvelope = {
    code: "internal",
    message: "internal server error",
    requestId,
  };
  return c.json(body, 500);
};
