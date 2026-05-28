/**
 * Admin routes — gated behind `role === 'admin'`.
 *
 *   GET /api/admin/audit ?actor_user_id= &action= &resource_type= &cursor= &limit=
 *
 * Cursor pagination is keyset on `(ts DESC, id DESC)` — the same shape the
 * `idx_audit_ts_id` index supports. Filters compose as ANDed predicates.
 */

import { Hono } from "hono";
import { z } from "zod";
import { sql, withRetry } from "../db/client.ts";
import type { AuthUser } from "../middleware/auth.ts";
import { AuthError, requireAuth } from "../middleware/auth.ts";
import { decodeCursor, encodeCursor } from "../lib/cursor.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Query = z.object({
  actor_user_id: z.string().regex(UUID_RE).optional(),
  action: z.string().min(1).max(128).optional(),
  resource_type: z.string().min(1).max(64).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

// Cursor for audit pagination — bigint id + iso ts. We use string for the
// id since BIGINT can overflow JS number range in theory.
const AuditCursor = z.object({
  ts: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "ts must be ISO",
  }),
  id: z.string().regex(/^\d+$/, "id must be a numeric string"),
});

interface AuditListRow {
  id: string;
  ts: string;
  actor_user_id: string | null;
  actor_ip: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  request_id: string | null;
}

function requireAdmin(user: AuthUser): void {
  if (user.role !== "admin") {
    throw new AuthError("AUTH_FORBIDDEN", 403, "admin role required");
  }
}

export function buildAdminRouter(): Hono {
  const router = new Hono();
  router.use("*", requireAuth());

  router.get("/audit", async (c) => {
    const user = c.get("user") as AuthUser;
    requireAdmin(user);

    const parsed = Query.safeParse({
      actor_user_id: c.req.query("actor_user_id"),
      action: c.req.query("action"),
      resource_type: c.req.query("resource_type"),
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json(
        { code: "validation_failed", message: "invalid query", details: parsed.error.issues },
        400,
      );
    }
    const { actor_user_id, action, resource_type, cursor, limit } = parsed.data;
    const pageSize = limit ?? 50;
    const fetchN = pageSize + 1;
    const decoded = cursor ? decodeCursor(cursor, AuditCursor) : null;

    // We compose the query with optional WHERE clauses via tagged template
    // fragments. postgres-js supports embedding `sql.unsafe` fragments, but
    // we keep things explicit with one branch per filter shape instead — the
    // cost of a few dispatch lines is worth never hand-building SQL strings.
    const rows = await withRetry(async () => {
      if (decoded) {
        return sql<AuditListRow[]>`
          SELECT id::text AS id, ts, actor_user_id, actor_ip::text AS actor_ip,
                 action, resource_type, resource_id, metadata, request_id::text AS request_id
            FROM audit_log
           WHERE (ts, id) < (${decoded.ts}::timestamptz, ${decoded.id}::bigint)
             AND (${actor_user_id ?? null}::uuid IS NULL OR actor_user_id = ${actor_user_id ?? null}::uuid)
             AND (${action ?? null}::text IS NULL OR action = ${action ?? null})
             AND (${resource_type ?? null}::text IS NULL OR resource_type = ${resource_type ?? null})
           ORDER BY ts DESC, id DESC
           LIMIT ${fetchN}
        `;
      }
      return sql<AuditListRow[]>`
        SELECT id::text AS id, ts, actor_user_id, actor_ip::text AS actor_ip,
               action, resource_type, resource_id, metadata, request_id::text AS request_id
          FROM audit_log
         WHERE (${actor_user_id ?? null}::uuid IS NULL OR actor_user_id = ${actor_user_id ?? null}::uuid)
           AND (${action ?? null}::text IS NULL OR action = ${action ?? null})
           AND (${resource_type ?? null}::text IS NULL OR resource_type = ${resource_type ?? null})
         ORDER BY ts DESC, id DESC
         LIMIT ${fetchN}
      `;
    });

    let nextCursor: string | null = null;
    if (rows.length > pageSize) {
      rows.pop();
      const last = rows[rows.length - 1]!;
      nextCursor = encodeCursor({ ts: last.ts, id: last.id });
    }
    return c.json({ items: rows, next_cursor: nextCursor });
  });

  return router;
}

export const adminRouter = buildAdminRouter();
