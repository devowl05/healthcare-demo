/**
 * Conversations repository.
 *
 * Every query is scoped to (user_id, deleted_at IS NULL). The list endpoint
 * uses keyset pagination on (updated_at, id) so we get stable ordering even
 * when many rows share the same `updated_at` second.
 *
 * `bumpConversation` is called every time we write a message — the partial
 * index `idx_conversations_user_updated` keeps that update cheap.
 */

import { sql, withRetry } from "../db/client.ts";
import {
  ConversationsCursor,
  type ConversationsCursorT,
  decodeCursor,
  encodeCursor,
} from "../lib/cursor.ts";

export interface ConversationRow {
  id: string;
  user_id: string;
  cheap_mode: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConversationListPage {
  items: ConversationRow[];
  next_cursor: string | null;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function clampLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

/**
 * Ensure a conversation exists for the user. If `id` is provided and a row
 * exists and belongs to the user, return it; otherwise insert a fresh row.
 * Used by the chat route which accepts an optional client-supplied id so the
 * frontend can keep an in-flight conversation across reloads.
 */
export async function ensureConversation(
  userId: string,
  id?: string,
): Promise<ConversationRow> {
  if (id) {
    const existing = await getConversation(id, userId);
    if (existing) return existing;
  }
  return withRetry(async () => {
    const rows = id
      ? await sql<ConversationRow[]>`
          INSERT INTO conversations (id, user_id)
          VALUES (${id}, ${userId})
          RETURNING id, user_id, cheap_mode, created_at, updated_at
        `
      : await sql<ConversationRow[]>`
          INSERT INTO conversations (user_id)
          VALUES (${userId})
          RETURNING id, user_id, cheap_mode, created_at, updated_at
        `;
    const row = rows[0];
    if (!row) throw new Error("ensureConversation: insert returned no row");
    return row;
  });
}

export async function getConversation(
  id: string,
  userId: string,
): Promise<ConversationRow | null> {
  return withRetry(async () => {
    const rows = await sql<ConversationRow[]>`
      SELECT id, user_id, cheap_mode, created_at, updated_at
      FROM conversations
      WHERE id = ${id}
        AND user_id = ${userId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

export async function listConversations(
  userId: string,
  cursor?: string,
  limit?: number,
): Promise<ConversationListPage> {
  const pageSize = clampLimit(limit);
  // We fetch pageSize+1 to know whether a next page exists.
  const fetchN = pageSize + 1;

  const decoded: ConversationsCursorT | null = cursor
    ? decodeCursor(cursor, ConversationsCursor)
    : null;

  const rows = await withRetry(async () => {
    if (decoded) {
      return sql<ConversationRow[]>`
        SELECT id, user_id, cheap_mode, created_at, updated_at
        FROM conversations
        WHERE user_id = ${userId}
          AND deleted_at IS NULL
          AND (updated_at, id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)
        ORDER BY updated_at DESC, id DESC
        LIMIT ${fetchN}
      `;
    }
    return sql<ConversationRow[]>`
      SELECT id, user_id, cheap_mode, created_at, updated_at
      FROM conversations
      WHERE user_id = ${userId}
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT ${fetchN}
    `;
  });

  let nextCursor: string | null = null;
  if (rows.length > pageSize) {
    const overflow = rows.pop()!;
    // Encode the cursor pointing at the last row of THIS page so the next
    // page starts at the overflow row.
    const last = rows[rows.length - 1]!;
    nextCursor = encodeCursor({ ts: last.updated_at, id: last.id });
    // Suppress unused warning; overflow is intentional sentinel.
    void overflow;
  }

  return { items: rows, next_cursor: nextCursor };
}

/**
 * Soft delete: stamp `deleted_at` and rely on the partial index to hide the
 * row from every other query. Returns true if a row was deleted (i.e. the
 * conversation belonged to this user and was not already deleted).
 */
export async function softDeleteConversation(
  id: string,
  userId: string,
): Promise<boolean> {
  return withRetry(async () => {
    const rows = await sql<{ id: string }[]>`
      UPDATE conversations
      SET deleted_at = now(), updated_at = now()
      WHERE id = ${id}
        AND user_id = ${userId}
        AND deleted_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  });
}

/**
 * Touch `updated_at`. Called by message insert so list ordering reflects the
 * most recent activity, not just the conversation create time.
 */
export async function bumpConversation(id: string): Promise<void> {
  await withRetry(async () => {
    await sql`
      UPDATE conversations
      SET updated_at = now()
      WHERE id = ${id}
        AND deleted_at IS NULL
    `;
  });
}
