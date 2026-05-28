/**
 * GDPR routes integration tests.
 *
 *   - request export → export_jobs row with status='queued'
 *   - delete user → conversations soft-deleted, refresh tokens revoked
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  bootstrap,
  getApp,
  integrationEnabled,
  registerAndLogin,
  teardown,
  truncateAll,
} from "./_helpers.ts";

describe.skipIf(!integrationEnabled)("gdpr integration", () => {
  beforeAll(async () => {
    await bootstrap();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await teardown();
  });

  it("export request enqueues a job in 'queued' status", async () => {
    const app = await getApp();
    const { accessToken, userId, csrf } = await registerAndLogin("exp");
    const res = await app.request("/api/users/me/export", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: `csrf_token=${csrf}`,
        "x-csrf-token": csrf,
      },
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { jobId: string };
    expect(json.jobId).toBeTruthy();

    const { sql } = await import("../../src/db/client.ts");
    const rows = await sql<{ status: string; user_id: string }[]>`
      SELECT status, user_id FROM export_jobs WHERE id = ${json.jobId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.user_id).toBe(userId);

    // Status route returns the same job.
    const status = await app.request(`/api/users/me/export/${json.jobId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(status.status).toBe(200);
    const statusJson = (await status.json()) as { status: string };
    expect(statusJson.status).toBe("queued");
  });

  it("delete user soft-deletes data and revokes refresh tokens", async () => {
    const app = await getApp();
    const { accessToken, userId, csrf } = await registerAndLogin("del");

    // Seed a conversation so we can verify cascade.
    const { sql } = await import("../../src/db/client.ts");
    const convo = await sql<{ id: string }[]>`
      INSERT INTO conversations (user_id) VALUES (${userId}) RETURNING id
    `;
    const conversationId = convo[0]!.id;

    const res = await app.request("/api/users/me", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: `csrf_token=${csrf}`,
        "x-csrf-token": csrf,
      },
    });
    expect(res.status).toBe(204);

    // User soft-deleted.
    const users = await sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM users WHERE id = ${userId}
    `;
    expect(users[0]!.deleted_at).not.toBeNull();

    // Conversation soft-deleted.
    const conversations = await sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM conversations WHERE id = ${conversationId}
    `;
    expect(conversations[0]!.deleted_at).not.toBeNull();

    // Refresh tokens all revoked.
    const activeTokens = await sql<{ jti: string }[]>`
      SELECT jti FROM refresh_tokens
       WHERE user_id = ${userId} AND revoked_at IS NULL
    `;
    expect(activeTokens.length).toBe(0);

    // Audit trail records the request.
    const audit = await sql<{ action: string }[]>`
      SELECT action FROM audit_log
       WHERE action = 'gdpr.delete_requested' AND actor_user_id = ${userId}
    `;
    expect(audit.length).toBe(1);
  });
});
