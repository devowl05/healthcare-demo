/**
 * HTTP entrypoint.
 *
 * Composes the global middleware stack, mounts route modules, and exports the
 * Bun-serve config. The order of middleware matters:
 *
 *   1. `requestId()`          — mints/parses `x-request-id` + runWithCtx
 *   2. `httpLogger()`         — one structured access-log line per request
 *   3. `corsMiddleware()`     — CORS preflight + headers
 *   4. `securityHeaders()`    — CSP / HSTS / framing / etc.
 *
 * The central `onError` handler maps known error classes (ZodError,
 * AuthError, CsrfError, BreakerOpenError, CursorError) to stable envelopes;
 * everything else becomes an opaque 500.
 *
 * Per-route middleware (auth / csrf / rate-limit / idempotency) is applied at
 * the route-mount level so health/ready/metrics stay open and inexpensive.
 */

import { Hono } from "hono";
import { env } from "./env.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { csrf } from "./middleware/csrf.ts";
import { errorHandler } from "./middleware/error-handler.ts";
import { httpLogger } from "./middleware/http-logger.ts";
import { idempotency } from "./middleware/idempotency.ts";
import { rateLimit } from "./middleware/rate-limit.ts";
import { requestId } from "./middleware/request-id.ts";
import { requireAuth } from "./middleware/auth.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { authRouter } from "./routes/auth.ts";
import { chatRouter } from "./routes/chat.ts";
import { healthRouter } from "./routes/health.ts";
import { metricsRouter } from "./routes/metrics.ts";
import { adminRouter } from "./routes/admin.ts";
import { conversationsRouter } from "./routes/conversations.ts";
import { messagesRouter } from "./routes/messages.ts";
import { ttsRouter } from "./routes/tts.ts";
import { usersRouter } from "./routes/users.ts";

// Side-effect import to register the Hono ContextVariableMap augmentation.
import "./middleware/types.ts";

export function buildApp(): Hono {
  const app = new Hono();

  // Global middleware — order matters; see file header.
  app.use("*", requestId());
  app.use("*", httpLogger());
  app.use("*", corsMiddleware());
  app.use("*", securityHeaders());

  // Centralized error mapping. Hono passes us `Error`; we return a Response.
  app.onError((err, c) => errorHandler(err, c));

  // ---------------------------------------------------------------------------
  // Unauthenticated routes — health/ready/metrics + auth (login/refresh/etc.)
  // ---------------------------------------------------------------------------
  app.route("/", healthRouter);
  app.route("/", metricsRouter);
  app.route("/auth", authRouter);

  // ---------------------------------------------------------------------------
  // Chat — requires auth + CSRF + rate-limit + idempotency. Order:
  //   auth → csrf → rate-limit (per-user + per-IP) → idempotency
  // ---------------------------------------------------------------------------
  app.use("/api/chat", requireAuth());
  app.use("/api/chat", csrf());
  app.use(
    "/api/chat",
    rateLimit({ name: "chat", points: 20, windowSec: 60 }),
  );
  app.use("/api/chat", idempotency());
  app.route("/api/chat", chatRouter);

  // ---------------------------------------------------------------------------
  // Tier 3b CRUD + admin routes. Auth is enforced inside each sub-router; CSRF
  // applies to mutating verbs only (sub-router handles its own GET vs POST).
  // ---------------------------------------------------------------------------
  app.use("/api/conversations/*", csrf());
  app.route("/api/conversations", conversationsRouter);
  app.use("/api/messages/*", csrf());
  app.route("/api/messages", messagesRouter);
  app.use("/api/tts", csrf());
  app.use(
    "/api/tts",
    rateLimit({ name: "tts", points: 10, windowSec: 60 }),
  );
  app.route("/api/tts", ttsRouter);
  app.use("/api/users/*", csrf());
  app.route("/api/users", usersRouter);
  app.route("/api/admin", adminRouter);
  // Mirror auth router under /api/auth per the public contract; the /auth
  // mount above stays so existing clients aren't broken.
  app.route("/api/auth", authRouter);

  return app;
}

export const app = buildApp();

const port = env.PORT;

export default {
  port,
  fetch: app.fetch,
  // SSE responses can stay open for the full LLM turn; disable Bun's idle
  // timeout so the server doesn't cut a slow tool call off at 10 seconds.
  idleTimeout: 0,
};
