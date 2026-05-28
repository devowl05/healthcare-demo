/**
 * Auth middleware tests.
 *
 * Generates a fresh Ed25519 key pair per test run via `jose.generateKeyPair`
 * and injects it into the auth module via `setAuthKeysForTesting`. This
 * sidesteps the placeholder PEMs in env test defaults (which are not valid
 * keys — they're just length-1 strings).
 */

import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { generateKeyPair, SignJWT, type KeyLike } from "jose";
import {
  AuthError,
  issueAccessToken,
  requireAuth,
  resetAuthKeysForTesting,
  setAuthKeysForTesting,
} from "../../src/middleware/auth.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";

let priv: KeyLike;
let pub: KeyLike;
let foreignPriv: KeyLike;

beforeAll(async () => {
  const a = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  priv = a.privateKey;
  pub = a.publicKey;
  const b = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  foreignPriv = b.privateKey;
  setAuthKeysForTesting(priv, pub);
});

afterAll(() => {
  resetAuthKeysForTesting();
});

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("/protected/*", requireAuth());
  app.get("/protected/me", (c) => c.json({ user: c.get("user") }));
  return app;
}

describe("issueAccessToken / requireAuth round-trip", () => {
  it("issues a token that verifies", async () => {
    const { token } = await issueAccessToken("user-1", ["chat:write"], "patient");
    const app = buildApp();
    const res = await app.request("/protected/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; role: string } };
    expect(body.user.id).toBe("user-1");
    expect(body.user.role).toBe("patient");
  });

  it("returns 401 with missing token", async () => {
    const app = buildApp();
    const res = await app.request("/protected/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("auth_missing");
  });

  it("rejects tokens signed by a different key", async () => {
    const token = await new SignJWT({ role: "patient", scopes: [] })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(foreignPriv);
    const app = buildApp();
    const res = await app.request("/protected/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("auth_invalid");
  });

  it("rejects expired tokens", async () => {
    const token = await new SignJWT({ role: "patient", scopes: [] })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("user-1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(priv);
    const app = buildApp();
    const res = await app.request("/protected/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("auth_expired");
  });

  it("reads access_token cookie when no Authorization header is present", async () => {
    const { token } = await issueAccessToken("user-cookie", [], "patient");
    const app = buildApp();
    const res = await app.request("/protected/me", {
      headers: { cookie: `access_token=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe("user-cookie");
  });

  it("constructs AuthError with the expected shape", () => {
    const e = new AuthError("AUTH_MISSING", 401, "no token");
    expect(e.status).toBe(401);
    expect(e.code).toBe("AUTH_MISSING");
  });
});
