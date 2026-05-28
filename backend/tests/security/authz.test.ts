/**
 * Cross-user authorization tests.
 *
 * Premise: the public API must NEVER acknowledge the existence of a resource
 * owned by another user. Every cross-owner lookup returns 404 — not 403 — so
 * an attacker can't enumerate ids by status code.
 *
 * Scenarios:
 *   1. User A creates a conversation; user B tries `GET /api/conversations/<A's id>/messages` → 404.
 *   2. User A creates a message; user B tries `DELETE /api/messages/<A's msg>` → 404.
 *   3. User A inserts data; user B tries `DELETE /api/conversations/<A's id>` → 404.
 *
 * Requires INTEGRATION=1 + a running Postgres (see docker-compose.test.yml).
 * When the env isn't set we soft-skip via `describe.skipIf` so the default
 * `bun test` run stays green.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  bootstrap,
  getApp,
  integrationEnabled,
  registerAndLogin,
  teardown,
  truncateAll,
} from "../integration/_helpers.ts";

async function seedConversation(userId: string): Promise<string> {
  const { sql } = await import("../../src/db/client.ts");
  const rows = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id) VALUES (${userId}) RETURNING id
  `;
  return rows[0]!.id;
}

async function seedMessage(conversationId: string): Promise<string> {
  const { sql } = await import("../../src/db/client.ts");
  const rows = await sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, parts)
    VALUES (${conversationId}, 'user', ${sql.json([{ type: "text", text: "hi" }])}::jsonb)
    RETURNING id
  `;
  return rows[0]!.id;
}

describe.skipIf(!integrationEnabled)("authz: cross-user access returns 404", () => {
  beforeAll(async () => {
    await bootstrap();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await teardown();
  });

  it("B cannot read A's conversation messages — 404 (not 403)", async () => {
    const app = await getApp();
    const a = await registerAndLogin("alice");
    const b = await registerAndLogin("bob");
    const convo = await seedConversation(a.userId);

    const res = await app.request(`/api/conversations/${convo}/messages`, {
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("B cannot delete A's message — 404", async () => {
    const app = await getApp();
    const a = await registerAndLogin("alice");
    const b = await registerAndLogin("bob");
    const convo = await seedConversation(a.userId);
    const msg = await seedMessage(convo);

    const res = await app.request(`/api/messages/${msg}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${b.accessToken}`,
        "x-csrf-token": b.csrf,
        cookie: b.cookie,
      },
    });
    expect(res.status).toBe(404);
  });

  it("B cannot delete A's conversation — 404", async () => {
    const app = await getApp();
    const a = await registerAndLogin("alice");
    const b = await registerAndLogin("bob");
    const convo = await seedConversation(a.userId);

    const res = await app.request(`/api/conversations/${convo}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${b.accessToken}`,
        "x-csrf-token": b.csrf,
        cookie: b.cookie,
      },
    });
    expect(res.status).toBe(404);
  });

  it("After A's soft-delete, A also gets 404 (no zombie reads)", async () => {
    const app = await getApp();
    const a = await registerAndLogin("alice");
    const convo = await seedConversation(a.userId);

    const del = await app.request(`/api/conversations/${convo}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${a.accessToken}`,
        "x-csrf-token": a.csrf,
        cookie: a.cookie,
      },
    });
    expect(del.status).toBe(204);

    const after = await app.request(`/api/conversations/${convo}/messages`, {
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(after.status).toBe(404);
  });
});
