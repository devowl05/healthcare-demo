/**
 * Shared helpers for integration tests.
 *
 * Gating: every integration test file calls `skipIfNoIntegration()` at the
 * top of its describe block — when `process.env.INTEGRATION !== "1"` we skip
 * (rather than fail) so the default `bun test` run stays green on machines
 * without Docker.
 *
 * Test database: defaults to `postgres://test:test@localhost:55432/test_db`
 * matching docker-compose.test.yml; override with `DATABASE_URL_TEST` or
 * `DATABASE_URL`.
 *
 * Each test file wipes its data via `truncateAll()` in `beforeEach` so order
 * doesn't matter. Migrations are run once per process via `ensureMigrated()`.
 */

import { generateKeyPair, type KeyLike } from "jose";

// Ensure DATABASE_URL points at the test DB BEFORE we import env/db modules.
// We do this here, at module top level, because env.ts caches its parsed
// config the moment it is first imported.
const TEST_DB_URL =
  process.env.DATABASE_URL_TEST ??
  process.env.DATABASE_URL ??
  "postgres://test:test@localhost:55432/test_db";

process.env.DATABASE_URL = TEST_DB_URL;
process.env.NODE_ENV = "test";
// Keep MOCK_TTS on by default so TTS tests don't burn API credits.
if (process.env.MOCK_TTS === undefined) process.env.MOCK_TTS = "1";
// Force memory-backed rate limiter so we don't need Redis up.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

import { runMigrations } from "../../src/db/migrate.ts";
import { sql } from "../../src/db/client.ts";
import {
  resetAuthKeysForTesting,
  setAuthKeysForTesting,
} from "../../src/middleware/auth.ts";
import { forceMemoryBackendForTesting } from "../../src/middleware/rate-limit.ts";

export const integrationEnabled = process.env.INTEGRATION === "1";

let migrated = false;
let keysReady = false;
let priv: KeyLike;
let pub: KeyLike;

/**
 * One-shot bootstrap: forces an in-memory rate limiter (so a missing Redis
 * doesn't kill the suite), generates a fresh JWT keypair, and runs migrations
 * against the test DB. Safe to call repeatedly.
 */
export async function bootstrap(): Promise<void> {
  forceMemoryBackendForTesting();
  if (!keysReady) {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    priv = pair.privateKey;
    pub = pair.publicKey;
    setAuthKeysForTesting(priv, pub);
    keysReady = true;
  }
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
}

/**
 * Wipe every test-touched table. Order matters because of FK cascades but
 * `TRUNCATE ... RESTART IDENTITY CASCADE` handles that for us.
 */
export async function truncateAll(): Promise<void> {
  await sql.unsafe(`
    TRUNCATE
      audit_log,
      tts_cache,
      export_jobs,
      usage_records,
      messages,
      conversations,
      refresh_tokens,
      users
    RESTART IDENTITY CASCADE
  `);
}

export async function teardown(): Promise<void> {
  await sql.end({ timeout: 1 }).catch(() => undefined);
  resetAuthKeysForTesting();
}

/**
 * Skip helper. Bun's `it.skipIf` works on a per-test basis; we use it inside
 * `describe` blocks to gate the whole suite.
 */
export function skip(): boolean {
  return !integrationEnabled;
}

/**
 * Lazily import the app — we have to defer this until env vars are set.
 */
export async function getApp() {
  const { app } = await import("../../src/index.ts");
  return app;
}

/**
 * Read a Set-Cookie value for a given cookie name from a Response.
 */
export function getSetCookie(res: Response, name: string): string | null {
  // Hono on Bun returns multiple Set-Cookie headers concatenated with a comma
  // when read via `.get`. Use the iterable form via `getAll` if available.
  const list: string[] = [];
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    list.push(...anyHeaders.getSetCookie());
  } else {
    const all = res.headers.get("set-cookie");
    if (all) {
      // Naive split on `, ` is wrong if a cookie has a date with comma; we
      // accept the limitation for tests.
      list.push(...all.split(/,\s*(?=[a-zA-Z_][\w-]*=)/));
    }
  }
  for (const c of list) {
    const eq = c.indexOf("=");
    if (eq < 0) continue;
    if (c.slice(0, eq).trim() === name) {
      const sc = c.slice(eq + 1).split(";")[0]!.trim();
      return sc;
    }
  }
  return null;
}

/**
 * Convenience: register + login a fresh user, returning the access token,
 * cookie header, and CSRF token.
 */
export async function registerAndLogin(
  emailSeed?: string,
): Promise<{
  email: string;
  userId: string;
  accessToken: string;
  cookie: string;
  csrf: string;
}> {
  const app = await getApp();
  const email = `${emailSeed ?? "user"}+${crypto.randomUUID()}@example.test`;
  const password = "correct-horse-battery-staple";
  const reg = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (reg.status !== 201) {
    throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  }
  const regJson = (await reg.json()) as { user: { id: string } };
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${await login.text()}`);
  }
  const body = (await login.json()) as { accessToken: string };
  const refresh = getSetCookie(login, "refresh_token") ?? "";
  const csrf = getSetCookie(login, "csrf_token") ?? "";
  return {
    email,
    userId: regJson.user.id,
    accessToken: body.accessToken,
    cookie: `refresh_token=${refresh}; csrf_token=${csrf}`,
    csrf,
  };
}
