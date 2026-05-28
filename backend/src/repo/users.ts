/**
 * Users repository.
 *
 * Email is stored as CITEXT (case-insensitive) per migration 002. Passwords
 * are argon2id-hashed via `lib/crypto`. Soft-delete here mirrors the
 * conversations/messages contract — we set `deleted_at` and rely on the
 * partial index `idx_users_email_active` to keep auth lookups fast.
 *
 * Refresh-token helpers also live here so the JWT middleware doesn't depend
 * on the `repo/` boundary being crossed in both directions.
 */

import { sql, withRetry } from "../db/client.ts";
import { hashPassword, verifyPassword } from "../lib/crypto.ts";

export type UserRole = "patient" | "clinician" | "admin";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
}

function toPublic(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, role: row.role };
}

/**
 * Create a user. Throws if the email is already in use (Postgres unique
 * violation surfaces with code 23505).
 */
export async function createUser(
  email: string,
  password: string,
  role: UserRole = "patient",
): Promise<PublicUser> {
  const hash = await hashPassword(password);
  return withRetry(async () => {
    const rows = await sql<UserRow[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${email}, ${hash}, ${role})
      RETURNING id, email, password_hash, role, deleted_at, created_at, updated_at
    `;
    const row = rows[0];
    if (!row) throw new Error("createUser: insert returned no row");
    return toPublic(row);
  });
}

/**
 * Lookup by email. Returns the full row (including password_hash) so callers
 * can verify a password; never return this directly to the client.
 */
export async function findUserByEmail(email: string): Promise<UserRow | null> {
  return withRetry(async () => {
    const rows = await sql<UserRow[]>`
      SELECT id, email, password_hash, role, deleted_at, created_at, updated_at
      FROM users
      WHERE email = ${email}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

export async function findUserById(id: string): Promise<UserRow | null> {
  return withRetry(async () => {
    const rows = await sql<UserRow[]>`
      SELECT id, email, password_hash, role, deleted_at, created_at, updated_at
      FROM users
      WHERE id = ${id}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

export async function softDeleteUser(id: string): Promise<boolean> {
  return withRetry(async () => {
    const rows = await sql<{ id: string }[]>`
      UPDATE users
      SET deleted_at = now(), updated_at = now()
      WHERE id = ${id}
        AND deleted_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  });
}

/**
 * Verify an (email, password) pair. Returns the public user record on success
 * or null on any failure (wrong email, wrong password, deleted user). Single
 * exit point so callers can't accidentally branch on the failure reason —
 * that's a known timing-channel pitfall in auth code.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<PublicUser | null> {
  const row = await findUserByEmail(email);
  if (!row) {
    // Spend roughly the same time as a verify call so the response time
    // doesn't disclose whether the email exists.
    await verifyPassword(
      "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      password,
    );
    return null;
  }
  const ok = await verifyPassword(row.password_hash, password);
  return ok ? toPublic(row) : null;
}

// ---------------------------------------------------------------------------
// refresh tokens
// ---------------------------------------------------------------------------

export interface RefreshTokenRow {
  jti: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export async function insertRefreshToken(
  jti: string,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  await withRetry(async () => {
    await sql`
      INSERT INTO refresh_tokens (jti, user_id, expires_at)
      VALUES (${jti}, ${userId}, ${expiresAt.toISOString()}::timestamptz)
    `;
  });
}

export async function findActiveRefreshToken(
  jti: string,
): Promise<RefreshTokenRow | null> {
  return withRetry(async () => {
    const rows = await sql<RefreshTokenRow[]>`
      SELECT jti, user_id, expires_at, revoked_at, created_at
      FROM refresh_tokens
      WHERE jti = ${jti}
        AND revoked_at IS NULL
        AND expires_at > now()
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

export async function revokeRefreshToken(jti: string): Promise<void> {
  await withRetry(async () => {
    await sql`
      UPDATE refresh_tokens
      SET revoked_at = now()
      WHERE jti = ${jti}
        AND revoked_at IS NULL
    `;
  });
}
