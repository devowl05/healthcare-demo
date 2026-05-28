/**
 * Messages repository.
 *
 * `parts` is the ordered JSONB array described in `001_init.sql`. We treat
 * it as opaque here — repo callers serialize the parts in render order before
 * passing them in, and we hand them back unchanged.
 *
 * List queries paginate in REVERSE chronological order (newest first) using
 * a keyset cursor on (created_at, id), then we flip the result to render order
 * before returning. This matches the chat UI which scrolls "load older" upward.
 */

import { sql, withRetry } from "../db/client.ts";
import {
  decodeCursor,
  encodeCursor,
  MessagesCursor,
  type MessagesCursorT,
} from "../lib/cursor.ts";
import { bumpConversation } from "./conversations.ts";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface MessagePart {
  type: string;
  [key: string]: unknown;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  parts: MessagePart[];
  created_at: string;
}

export interface InsertMessageInput {
  conversationId: string;
  role: MessageRole;
  parts: MessagePart[];
  requestId?: string;
}

export interface InsertedMessage {
  id: string;
  createdAt: string;
}

export interface MessagesPage {
  items: MessageRow[];
  next_cursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function clampLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

/**
 * Insert a message and bump the parent conversation's `updated_at`. We do the
 * insert + bump as two separate statements rather than a transaction because
 * the bump is idempotent and a partial failure (insert ok, bump fails) just
 * means the conversation list is briefly out of date — recoverable on the
 * next message.
 */
export async function insertMessage(
  input: InsertMessageInput,
): Promise<InsertedMessage> {
  // postgres-js's `sql.json(...)` helper serializes a JS array/object as JSONB
  // unambiguously. The earlier approach (`${JSON.stringify(parts)}::jsonb`)
  // round-tripped through text and ended up storing the array as a JSONB
  // *string* literal, which tripped the `messages_parts_is_array` check.
  const inserted = await withRetry(async () => {
    const rows = await sql<{ id: string; created_at: string }[]>`
      INSERT INTO messages (conversation_id, role, parts)
      VALUES (${input.conversationId}, ${input.role}, ${sql.json(input.parts as unknown as Parameters<typeof sql.json>[0])})
      RETURNING id, created_at
    `;
    const row = rows[0];
    if (!row) throw new Error("insertMessage: insert returned no row");
    return row;
  });

  // Best-effort bump; swallow errors so a transient FK problem doesn't poison
  // the parent caller (which has already persisted the actual message).
  try {
    await bumpConversation(input.conversationId);
  } catch {
    // intentionally swallowed
  }

  return { id: inserted.id, createdAt: inserted.created_at };
}

/**
 * Reverse-cursor pagination. Returns the page in CHRONOLOGICAL order; callers
 * who want newest-first should reverse client-side or pass the page as-is to
 * a UI that scrolls bottom-up.
 */
export async function getMessages(
  conversationId: string,
  beforeCursor?: string,
  limit?: number,
): Promise<MessagesPage> {
  const pageSize = clampLimit(limit);
  const fetchN = pageSize + 1;

  const decoded: MessagesCursorT | null = beforeCursor
    ? decodeCursor(beforeCursor, MessagesCursor)
    : null;

  const rows = await withRetry(async () => {
    if (decoded) {
      return sql<MessageRow[]>`
        SELECT id, conversation_id, role, parts, created_at
        FROM messages
        WHERE conversation_id = ${conversationId}
          AND deleted_at IS NULL
          AND (created_at, id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)
        ORDER BY created_at DESC, id DESC
        LIMIT ${fetchN}
      `;
    }
    return sql<MessageRow[]>`
      SELECT id, conversation_id, role, parts, created_at
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ${fetchN}
    `;
  });

  let nextCursor: string | null = null;
  if (rows.length > pageSize) {
    rows.pop();
    const last = rows[rows.length - 1]!;
    nextCursor = encodeCursor({ ts: last.created_at, id: last.id });
  }

  // Flip to chronological (oldest -> newest) for caller convenience.
  rows.reverse();
  return { items: rows, next_cursor: nextCursor };
}

/**
 * Soft delete a single message, scoped to the owning user via the parent
 * conversation. Returns true if a row was actually deleted.
 */
export async function softDeleteMessage(
  id: string,
  userId: string,
): Promise<boolean> {
  return withRetry(async () => {
    const rows = await sql<{ id: string }[]>`
      UPDATE messages m
      SET deleted_at = now()
      FROM conversations c
      WHERE m.id = ${id}
        AND m.conversation_id = c.id
        AND c.user_id = ${userId}
        AND m.deleted_at IS NULL
        AND c.deleted_at IS NULL
      RETURNING m.id
    `;
    return rows.length > 0;
  });
}
