/**
 * Opaque cursor pagination.
 *
 * Cursors are base64url-encoded JSON validated by a caller-supplied zod
 * schema. We deliberately don't sign them: a tampered cursor that's
 * still schema-valid only lets the client request a different slice of
 * THEIR OWN data — auth is enforced at the row level by the listing query.
 * If a future feature exposes cross-user cursors, switch to the HMAC
 * signing helper in `crypto.ts`.
 *
 * Throws `CursorError` (with stable `code`) on malformed input so HTTP
 * handlers can return a clean 400.
 */

import { z } from "zod";

export class CursorError extends Error {
  readonly code: "CURSOR_MALFORMED" | "CURSOR_INVALID_SHAPE";
  constructor(code: "CURSOR_MALFORMED" | "CURSOR_INVALID_SHAPE", message: string) {
    super(message);
    this.code = code;
    this.name = "CursorError";
  }
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(std, "base64");
}

export function encodeCursor(value: unknown): string {
  const json = JSON.stringify(value);
  return toBase64Url(Buffer.from(json, "utf8"));
}

export function decodeCursor<T>(input: string, schema: z.ZodType<T>): T {
  let json: string;
  try {
    json = fromBase64Url(input).toString("utf8");
  } catch {
    throw new CursorError("CURSOR_MALFORMED", "cursor is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CursorError("CURSOR_MALFORMED", "cursor is not valid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new CursorError("CURSOR_INVALID_SHAPE", result.error.issues[0]?.message ?? "invalid cursor shape");
  }
  return result.data;
}

// --- shared schemas ---

const isoDatetime = z.string().refine(
  (s) => !Number.isNaN(Date.parse(s)),
  { message: "ts must be a parseable ISO timestamp" },
);
const uuid = z.string().uuid("id must be a uuid");

export const MessagesCursor = z.object({ ts: isoDatetime, id: uuid });
export type MessagesCursorT = z.infer<typeof MessagesCursor>;

export const ConversationsCursor = z.object({ ts: isoDatetime, id: uuid });
export type ConversationsCursorT = z.infer<typeof ConversationsCursor>;
