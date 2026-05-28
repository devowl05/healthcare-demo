/**
 * Auth integration tests.
 *
 * Walk the full register → login → access protected → refresh → logout →
 * access fails flow against a real Postgres. Also asserts that failed logins
 * land in the audit_log (proves the auth.login_failed path actually writes
 * a row, not just returns 401).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  bootstrap,
  getApp,
  getSetCookie,
  integrationEnabled,
  registerAndLogin,
  teardown,
  truncateAll,
} from "./_helpers.ts";

describe.skipIf(!integrationEnabled)("auth integration", () => {
  beforeAll(async () => {
    await bootstrap();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await teardown();
  });

  it("register → login → /api/conversations → refresh → logout → access fails", async () => {
    const app = await getApp();
    const { accessToken, cookie } = await registerAndLogin("flow");

    // Protected route works with access token.
    const list1 = await app.request("/api/conversations", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(list1.status).toBe(200);

    // Refresh — uses cookie only.
    const refresh = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { cookie },
    });
    expect(refresh.status).toBe(200);
    const refreshJson = (await refresh.json()) as { accessToken: string };
    expect(refreshJson.accessToken).toBeTruthy();
    expect(refreshJson.accessToken).not.toBe(accessToken);

    // New cookie should be different (rotated).
    const newRefreshCookie = getSetCookie(refresh, "refresh_token");
    expect(newRefreshCookie).toBeTruthy();

    // Old refresh cookie must no longer work (revoked).
    const reuse = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { cookie },
    });
    expect(reuse.status).toBe(401);

    // Logout (use the NEW cookie).
    const newCookie = `refresh_token=${newRefreshCookie}`;
    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: newCookie },
    });
    expect(logout.status).toBe(204);

    // After logout the new refresh is revoked too.
    const postLogout = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { cookie: newCookie },
    });
    expect(postLogout.status).toBe(401);
  });

  it("rejects bad credentials and audits the attempt", async () => {
    const app = await getApp();
    const email = `bad+${crypto.randomUUID()}@example.test`;
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "ok-password-123" }),
    });
    const bad = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong" }),
    });
    expect(bad.status).toBe(401);
    const body = (await bad.json()) as { code: string };
    expect(body.code).toBe("invalid_credentials");

    // Audit row should exist.
    const { sql } = await import("../../src/db/client.ts");
    const rows = await sql<{ action: string }[]>`
      SELECT action FROM audit_log WHERE action = 'auth.login_failed'
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("rejects unauthenticated access to protected route", async () => {
    const app = await getApp();
    const res = await app.request("/api/conversations");
    expect(res.status).toBe(401);
  });
});
