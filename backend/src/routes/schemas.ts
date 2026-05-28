/**
 * Centralized request-shape schemas for the HTTP layer.
 *
 * Every route should parse its inputs through these so failure modes — and
 * thus the error envelopes — stay consistent across the API. The error handler
 * (`middleware/error-handler.ts`) already maps `ZodError` to a stable
 * `{ code: "validation_failed", details }` body, so handlers just call
 * `.parse()` and let the framework do the rest.
 */

import { z } from "zod";

/**
 * Body for `POST /api/chat`. Message size cap is generous (8000 chars) so
 * voice transcripts and long pasted snippets work, but bounded so a runaway
 * client can't OOM us at the parser.
 */
export const ChatBody = z.object({
  message: z.string().min(1, "message must be non-empty").max(8000, "message too long"),
  conversationId: z.string().uuid().optional(),
  model: z.enum(["gpt-5.2", "gpt-5.4-mini"]).optional(),
  cheap: z.boolean().optional(),
});
export type ChatBodyT = z.infer<typeof ChatBody>;

/** UUID path-param for any route that takes a conversation id. */
export const ConversationIdParam = z.object({
  id: z.string().uuid("invalid conversation id"),
});
export type ConversationIdParamT = z.infer<typeof ConversationIdParam>;

/** UUID path-param for any route that takes a message id. */
export const MessageIdParam = z.object({
  id: z.string().uuid("invalid message id"),
});
export type MessageIdParamT = z.infer<typeof MessageIdParam>;

/**
 * Cursor query-param. The cursor itself is opaque (base64url JSON validated
 * by `lib/cursor.ts`); we only require it be a non-empty string here so we
 * can return a clean `cursor_malformed` later if it doesn't decode.
 */
export const BeforeQuery = z.object({
  before: z.string().min(1).optional(),
});
export type BeforeQueryT = z.infer<typeof BeforeQuery>;

/**
 * Page-size query-param. Coerced from string (URLs are stringy) and clamped
 * to a sane range — the repositories also clamp again at their own boundary.
 */
export const LimitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type LimitQueryT = z.infer<typeof LimitQuery>;
