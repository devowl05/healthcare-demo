/**
 * Conversation CRUD routes.
 *
 *   GET    /api/conversations              — paginated list (owner-scoped)
 *   GET    /api/conversations/:id/messages — reverse-cursor message page
 *   DELETE /api/conversations/:id          — soft delete
 *
 * Every read goes through `repo/conversations` whose queries already enforce
 * (user_id, deleted_at IS NULL); on a miss we return 404 rather than 403 so
 * the API never reveals whether the id exists under a different user.
 *
 * Message listing JOINs `usage_records` so the SPA can render per-turn token
 * counts + cost without a follow-up request — saves a round trip on every
 * "open conversation" interaction. Non-assistant messages get a null metadata
 * field (the JOIN naturally drops them since usage_records is assistant-only).
 */

import { Hono } from "hono";
import { z } from "zod";
import { sql, withRetry } from "../db/client.ts";
import { decodeCursor, encodeCursor, MessagesCursor } from "../lib/cursor.ts";
import type { AuthUser } from "../middleware/auth.ts";
import { requireAuth } from "../middleware/auth.ts";
import {
  getConversation,
  listConversations,
  softDeleteConversation,
} from "../repo/conversations.ts";
import { append as auditAppend } from "../repo/audit-log.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const MessagesQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

interface MessageWithMeta {
  id: string;
  conversation_id: string;
  role: string;
  parts: unknown;
  created_at: string;
  metadata: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cost_usd: string;
    latency_ms: number;
  } | null;
}

/**
 * Reverse-cursor message query with usage JOIN. We re-implement the keyset
 * pagination here (rather than calling `getMessages`) so we can include the
 * `metadata` shape in a single SQL round trip.
 */
async function listMessagesWithMeta(
  conversationId: string,
  beforeCursor: string | undefined,
  limit: number,
): Promise<{ items: MessageWithMeta[]; prev_cursor: string | null }> {
  const fetchN = limit + 1;
  const decoded = beforeCursor ? decodeCursor(beforeCursor, MessagesCursor) : null;

  const rows = await withRetry(async () => {
    if (decoded) {
      return sql<MessageWithMeta[]>`
        SELECT m.id,
               m.conversation_id,
               m.role,
               m.parts,
               m.created_at,
               CASE
                 WHEN u.id IS NULL THEN NULL
                 ELSE jsonb_build_object(
                   'model', u.model,
                   'input_tokens', u.input_tokens,
                   'output_tokens', u.output_tokens,
                   'cached_input_tokens', u.cached_input_tokens,
                   'cost_usd', u.cost_usd,
                   'latency_ms', u.latency_ms
                 )
               END AS metadata
          FROM messages m
          LEFT JOIN LATERAL (
            SELECT id, model, input_tokens, output_tokens,
                   cached_input_tokens, cost_usd, latency_ms
              FROM usage_records
             WHERE message_id = m.id
             ORDER BY created_at DESC
             LIMIT 1
          ) u ON true
         WHERE m.conversation_id = ${conversationId}
           AND m.deleted_at IS NULL
           AND (m.created_at, m.id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ${fetchN}
      `;
    }
    return sql<MessageWithMeta[]>`
      SELECT m.id,
             m.conversation_id,
             m.role,
             m.parts,
             m.created_at,
             CASE
               WHEN u.id IS NULL THEN NULL
               ELSE jsonb_build_object(
                 'model', u.model,
                 'input_tokens', u.input_tokens,
                 'output_tokens', u.output_tokens,
                 'cached_input_tokens', u.cached_input_tokens,
                 'cost_usd', u.cost_usd,
                 'latency_ms', u.latency_ms
               )
             END AS metadata
        FROM messages m
        LEFT JOIN LATERAL (
          SELECT id, model, input_tokens, output_tokens,
                 cached_input_tokens, cost_usd, latency_ms
            FROM usage_records
           WHERE message_id = m.id
           ORDER BY created_at DESC
           LIMIT 1
        ) u ON true
       WHERE m.conversation_id = ${conversationId}
         AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${fetchN}
    `;
  });

  let prevCursor: string | null = null;
  if (rows.length > limit) {
    rows.pop();
    const last = rows[rows.length - 1]!;
    prevCursor = encodeCursor({ ts: last.created_at, id: last.id });
  }
  rows.reverse(); // chronological for caller
  return { items: rows, prev_cursor: prevCursor };
}

export function buildConversationsRouter(): Hono {
  const router = new Hono();
  router.use("*", requireAuth());

  // -------------------------------------------------------------------------
  // GET /
  // -------------------------------------------------------------------------
  router.get("/", async (c) => {
    const user = c.get("user") as AuthUser;
    const parsed = ListQuery.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json(
        { code: "validation_failed", message: "invalid query", details: parsed.error.issues },
        400,
      );
    }
    const page = await listConversations(user.id, parsed.data.cursor, parsed.data.limit);
    return c.json({
      items: page.items.map((row) => ({
        id: row.id,
        cheap_mode: row.cheap_mode,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      next_cursor: page.next_cursor,
    });
  });

  // -------------------------------------------------------------------------
  // GET /:id/messages
  // -------------------------------------------------------------------------
  router.get("/:id/messages", async (c) => {
    const user = c.get("user") as AuthUser;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      return c.json({ code: "not_found", message: "conversation not found" }, 404);
    }
    const convo = await getConversation(id, user.id);
    if (!convo) {
      return c.json({ code: "not_found", message: "conversation not found" }, 404);
    }
    const parsed = MessagesQuery.safeParse({
      before: c.req.query("before"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json(
        { code: "validation_failed", message: "invalid query", details: parsed.error.issues },
        400,
      );
    }
    const limit = parsed.data.limit ?? 50;
    const page = await listMessagesWithMeta(convo.id, parsed.data.before, limit);
    return c.json(page);
  });

  // -------------------------------------------------------------------------
  // DELETE /:id
  // -------------------------------------------------------------------------
  router.delete("/:id", async (c) => {
    const user = c.get("user") as AuthUser;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      return c.json({ code: "not_found", message: "conversation not found" }, 404);
    }
    const ok = await softDeleteConversation(id, user.id);
    if (!ok) {
      return c.json({ code: "not_found", message: "conversation not found" }, 404);
    }
    await auditAppend({
      ctx: { userId: user.id },
      action: "conversation.delete",
      resourceType: "conversation",
      resourceId: id,
    });
    return c.body(null, 204);
  });

  return router;
}

export const conversationsRouter = buildConversationsRouter();
