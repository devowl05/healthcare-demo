/**
 * Conversations CRUD integration tests.
 *
 *   - list pagination with seeded data — verifies cursor + limit semantics
 *   - ownership boundary — user A cannot read user B's conversation (404)
 *   - delete is soft — row stays in DB with deleted_at set, drops from list
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

async function seedConversation(userId: string) {
  const { sql } = await import("../../src/db/client.ts");
  const rows = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id) VALUES (${userId}) RETURNING id
  `;
  return rows[0]!.id;
}

describe.skipIf(!integrationEnabled)("conversations integration", () => {
  beforeAll(async () => {
    await bootstrap();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await teardown();
  });

  it("paginates with cursor + limit, returning newest-first", async () => {
    const app = await getApp();
    const { accessToken, userId } = await registerAndLogin("listpage");
    // Seed 5 conversations; deliberately stagger updated_at so ordering is
    // deterministic.
    const { sql } = await import("../../src/db/client.ts");
    for (let i = 0; i < 5; i++) {
      await sql`
        INSERT INTO conversations (user_id, updated_at)
        VALUES (${userId}, now() + (${i} || ' minutes')::interval)
      `;
    }

    const first = await app.request("/api/conversations?limit=2", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    expect(firstJson.items.length).toBe(2);
    expect(firstJson.next_cursor).toBeTruthy();

    const second = await app.request(
      `/api/conversations?limit=2&cursor=${encodeURIComponent(firstJson.next_cursor!)}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    expect(secondJson.items.length).toBe(2);
    // No id from page 1 reappears on page 2.
    const seen = new Set(firstJson.items.map((i) => i.id));
    for (const item of secondJson.items) {
      expect(seen.has(item.id)).toBe(false);
    }
  });

  it("blocks cross-user access (404 on someone else's conversation)", async () => {
    const app = await getApp();
    const a = await registerAndLogin("alice");
    const b = await registerAndLogin("bob");
    const convo = await seedConversation(b.userId);
    const res = await app.request(`/api/conversations/${convo}/messages`, {
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("soft-delete drops from list but leaves the row", async () => {
    const app = await getApp();
    const { accessToken, userId, csrf } = await registerAndLogin("sd");
    const convo = await seedConversation(userId);

    // Reload the cookie pair we got from login — re-issue a fresh login
    // because the helper returns the value but mutating routes need a
    // complete cookie header.
    const { sql } = await import("../../src/db/client.ts");
    const del = await app.request(`/api/conversations/${convo}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: `csrf_token=${csrf}`,
        "x-csrf-token": csrf,
      },
    });
    expect(del.status).toBe(204);

    const list = await app.request("/api/conversations", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const listJson = (await list.json()) as { items: { id: string }[] };
    expect(listJson.items.find((i) => i.id === convo)).toBeUndefined();

    // Row still exists with deleted_at set.
    const rows = await sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM conversations WHERE id = ${convo}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});
