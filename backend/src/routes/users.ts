/**
 * Self-service user routes — GDPR data portability + erasure.
 *
 *   POST   /api/users/me/export             -> enqueues an export_jobs row
 *   GET    /api/users/me/export/:jobId      -> status + file_path on completion
 *   DELETE /api/users/me                    -> soft-delete user + cascade
 *
 * The actual export bundle is built by the worker at
 * `src/jobs/gdpr-export.ts`. We just queue the job here and return its id so
 * the SPA can poll.
 *
 * Deletion soft-deletes (`deleted_at`) the user, cascades the same stamp to
 * conversations + messages, and revokes every active refresh token. The hard
 * delete waits for the retention worker per the project's GDPR grace period
 * (`RETENTION_GRACE_DAYS`).
 */

import { Hono } from "hono";
import { sql, withRetry } from "../db/client.ts";
import type { AuthUser } from "../middleware/auth.ts";
import { requireAuth } from "../middleware/auth.ts";
import { append as auditAppend } from "../repo/audit-log.ts";
import { softDeleteUser } from "../repo/users.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ExportJobRow {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  file_path: string | null;
  error: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

async function enqueueExport(userId: string): Promise<string> {
  return withRetry(async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO export_jobs (user_id, status)
      VALUES (${userId}, 'queued')
      RETURNING id
    `;
    const row = rows[0];
    if (!row) throw new Error("enqueueExport: insert returned no row");
    return row.id;
  });
}

async function getExportJob(
  jobId: string,
  userId: string,
): Promise<ExportJobRow | null> {
  return withRetry(async () => {
    const rows = await sql<ExportJobRow[]>`
      SELECT id, status, file_path, error, expires_at, created_at, updated_at
        FROM export_jobs
       WHERE id = ${jobId} AND user_id = ${userId}
       LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

async function cascadeSoftDelete(userId: string): Promise<void> {
  // Stamp every conversation + descendant message + refresh token in a single
  // serializable transaction so partial cascades can't leak state.
  await sql.begin(async (tx) => {
    await tx`
      UPDATE conversations
         SET deleted_at = now(), updated_at = now()
       WHERE user_id = ${userId}
         AND deleted_at IS NULL
    `;
    await tx`
      UPDATE messages m
         SET deleted_at = now()
        FROM conversations c
       WHERE m.conversation_id = c.id
         AND c.user_id = ${userId}
         AND m.deleted_at IS NULL
    `;
    await tx`
      UPDATE refresh_tokens
         SET revoked_at = now()
       WHERE user_id = ${userId}
         AND revoked_at IS NULL
    `;
  });
}

export function buildUsersRouter(): Hono {
  const router = new Hono();
  router.use("*", requireAuth());

  // -------------------------------------------------------------------------
  // POST /me/export
  // -------------------------------------------------------------------------
  router.post("/me/export", async (c) => {
    const user = c.get("user") as AuthUser;
    const jobId = await enqueueExport(user.id);
    await auditAppend({
      ctx: { userId: user.id },
      action: "gdpr.export_requested",
      resourceType: "export_job",
      resourceId: jobId,
    });
    return c.json({ jobId }, 202);
  });

  // -------------------------------------------------------------------------
  // GET /me/export/:jobId
  // -------------------------------------------------------------------------
  router.get("/me/export/:jobId", async (c) => {
    const user = c.get("user") as AuthUser;
    const jobId = c.req.param("jobId");
    if (!UUID_RE.test(jobId)) {
      return c.json({ code: "not_found", message: "export job not found" }, 404);
    }
    const job = await getExportJob(jobId, user.id);
    if (!job) {
      return c.json({ code: "not_found", message: "export job not found" }, 404);
    }
    return c.json({
      jobId: job.id,
      status: job.status,
      file_path: job.file_path,
      error: job.error,
      expires_at: job.expires_at,
      created_at: job.created_at,
      updated_at: job.updated_at,
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /me
  // -------------------------------------------------------------------------
  router.delete("/me", async (c) => {
    const user = c.get("user") as AuthUser;
    const deleted = await softDeleteUser(user.id);
    if (!deleted) {
      return c.json({ code: "not_found", message: "user not found" }, 404);
    }
    await cascadeSoftDelete(user.id);
    await auditAppend({
      ctx: { userId: user.id },
      action: "gdpr.delete_requested",
      resourceType: "user",
      resourceId: user.id,
    });
    // Clear auth cookies so the now-tombstoned session goes away.
    c.header(
      "Set-Cookie",
      `refresh_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      { append: true },
    );
    return c.body(null, 204);
  });

  return router;
}

export const usersRouter = buildUsersRouter();
