/**
 * TTS integration tests.
 *
 *   - provenance check: a message owned by user B cannot be voiced by user A
 *     (returns 404, not 403, to avoid id enumeration).
 *   - cache hit: a second call for the same (message_id, voice) returns the
 *     bytes that the DB row points at, with `X-TTS-Cache: hit`.
 *   - cache miss → persist: first call generates + writes a row + file.
 *
 * `MOCK_TTS=1` is set by `_helpers.ts` so we don't burn API credits; the
 * route returns a 32-byte placeholder mp3 in that mode.
 */

import { unlink } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  bootstrap,
  getApp,
  integrationEnabled,
  registerAndLogin,
  teardown,
  truncateAll,
} from "./_helpers.ts";

async function seedMessage(userId: string, text: string): Promise<{ messageId: string }> {
  const { sql } = await import("../../src/db/client.ts");
  const convo = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id) VALUES (${userId}) RETURNING id
  `;
  const cid = convo[0]!.id;
  // Use `sql.json(...)` (not `${JSON.stringify(...)}::jsonb`) so postgres-js
  // serializes a real JSONB *array*. The string-literal form is stored as a
  // JSON string and trips the `messages_parts_is_array` check — same gotcha
  // already fixed in src/repo/messages.ts.
  const parts = [{ type: "text", text }];
  const msg = await sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, parts)
    VALUES (${cid}, 'assistant', ${sql.json(parts)})
    RETURNING id
  `;
  return { messageId: msg[0]!.id };
}

describe.skipIf(!integrationEnabled)("tts integration", () => {
  beforeAll(async () => {
    await bootstrap();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await teardown();
  });

  it("rejects voicing someone else's message with 404 (no enumeration)", async () => {
    const app = await getApp();
    const a = await registerAndLogin("a");
    const b = await registerAndLogin("b");
    const { messageId } = await seedMessage(b.userId, "hello from bob");
    const res = await app.request("/api/tts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${a.accessToken}`,
        cookie: `csrf_token=${a.csrf}`,
        "x-csrf-token": a.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message_id: messageId }),
    });
    expect(res.status).toBe(404);
  });

  it("cache miss synthesizes + persists; second call is a cache hit", async () => {
    const app = await getApp();
    const { accessToken, userId, csrf } = await registerAndLogin("tts");
    const { messageId } = await seedMessage(userId, "hi there friend");
    const body = JSON.stringify({ message_id: messageId });
    const headers = {
      authorization: `Bearer ${accessToken}`,
      cookie: `csrf_token=${csrf}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };

    const miss = await app.request("/api/tts", { method: "POST", headers, body });
    expect(miss.status).toBe(200);
    expect(miss.headers.get("x-tts-cache")).toBe("miss");
    const missBytes = new Uint8Array(await miss.arrayBuffer());
    expect(missBytes.byteLength).toBeGreaterThan(0);

    // Row + file persisted.
    const { sql } = await import("../../src/db/client.ts");
    const rows = await sql<{ path: string; bytes: number }[]>`
      SELECT path, bytes FROM tts_cache WHERE message_id = ${messageId}
    `;
    expect(rows.length).toBe(1);
    const path = rows[0]!.path;

    const hit = await app.request("/api/tts", { method: "POST", headers, body });
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-tts-cache")).toBe("hit");
    const hitBytes = new Uint8Array(await hit.arrayBuffer());
    expect(hitBytes).toEqual(missBytes);

    // Cleanup: remove the file so repeated runs don't pile up in tts_data/.
    await unlink(path).catch(() => undefined);
  });
});
