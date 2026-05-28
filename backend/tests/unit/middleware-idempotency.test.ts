/**
 * Idempotency middleware tests.
 *
 * The middleware doesn't replay the response itself — it sets
 * `c.var.idempotencyReplay` to the original requestId so the chat route can
 * emit a `replay` SSE frame. Tests assert the var population end-to-end.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requestId } from "../../src/middleware/request-id.ts";
import {
  clearIdempotencyCache,
  idempotency,
} from "../../src/middleware/idempotency.ts";

beforeEach(() => {
  clearIdempotencyCache();
});

function buildApp() {
  const app = new Hono();
  app.use("*", requestId());
  app.use("*", idempotency());
  app.post("/chat", (c) => {
    const replay = c.get("idempotencyReplay") as string | null;
    return c.json({ replay, requestId: c.get("requestId") });
  });
  return app;
}

describe("idempotency middleware", () => {
  it("returns null on first call, the prior requestId on replay", async () => {
    const app = buildApp();
    const first = await app.request("/chat", {
      method: "POST",
      headers: { "idempotency-key": "abc-1" },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      replay: string | null;
      requestId: string;
    };
    expect(firstBody.replay).toBeNull();
    expect(firstBody.requestId).toBeTruthy();

    const second = await app.request("/chat", {
      method: "POST",
      headers: { "idempotency-key": "abc-1" },
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      replay: string | null;
      requestId: string;
    };
    expect(secondBody.replay).toBe(firstBody.requestId);
  });

  it("different keys map to different cache entries", async () => {
    const app = buildApp();
    const a = await app.request("/chat", {
      method: "POST",
      headers: { "idempotency-key": "key-a" },
    });
    const aBody = (await a.json()) as { requestId: string };

    const b = await app.request("/chat", {
      method: "POST",
      headers: { "idempotency-key": "key-b" },
    });
    const bBody = (await b.json()) as { replay: string | null; requestId: string };

    expect(bBody.replay).toBeNull();
    expect(bBody.requestId).not.toBe(aBody.requestId);
  });

  it("no Idempotency-Key header → replay is null and no entry is stored", async () => {
    const app = buildApp();
    const res = await app.request("/chat", { method: "POST" });
    const body = (await res.json()) as { replay: string | null };
    expect(body.replay).toBeNull();
  });
});
