/**
 * Route aggregator for Tier 3b CRUD endpoints.
 *
 * Tier 3a owns `src/index.ts` and the streaming chat route. To avoid editing
 * the entrypoint from two agents, this module exposes `attachRoutes(app)`
 * which 3a calls once after its own middleware stack is in place.
 *
 * Mount points:
 *   /api/auth/*           — login, refresh, logout, register
 *   /api/conversations/*  — list, messages, soft delete
 *   /api/messages/*       — soft delete a single message
 *   /api/tts              — synthesize audio with provenance + cache
 *   /api/users/me/*       — GDPR export + erasure
 *   /api/admin/*          — admin-only audit query
 *
 * Each sub-router carries its own auth/scope middleware so this file stays
 * declarative. Mutating routes still need CSRF in front of them — 3a should
 * apply the csrf() middleware before calling attachRoutes() (or scope it
 * narrowly via a wrapper if some routes need to bypass it).
 */

import type { Hono } from "hono";
import { adminRouter } from "./admin.ts";
import { authRouter } from "./auth.ts";
import { conversationsRouter } from "./conversations.ts";
import { messagesRouter } from "./messages.ts";
import { ttsRouter } from "./tts.ts";
import { usersRouter } from "./users.ts";

/**
 * Mount every Tier 3b sub-router onto the supplied Hono app. Idempotent in
 * the sense that calling it twice would just register duplicate routes —
 * call it once.
 */
export function attachRoutes(app: Hono): void {
  app.route("/api/auth", authRouter);
  app.route("/api/conversations", conversationsRouter);
  app.route("/api/messages", messagesRouter);
  app.route("/api/tts", ttsRouter);
  app.route("/api/users", usersRouter);
  app.route("/api/admin", adminRouter);
}

// Re-export the individual routers so tests can mount just one slice without
// dragging in every neighbor.
export {
  adminRouter,
  authRouter,
  conversationsRouter,
  messagesRouter,
  ttsRouter,
  usersRouter,
};
