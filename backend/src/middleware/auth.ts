/**
 * Authentication middleware.
 *
 * Tokens:
 *   - Access token  — EdDSA-signed JWT, 15 min TTL, carries { sub, role, scopes }.
 *                     Verified on every protected request via `requireAuth()`.
 *   - Refresh token — opaque JWT-style envelope, 30 day TTL, recorded in
 *                     `refresh_tokens`. Caller is responsible for inserting
 *                     the row (`repo/users.insertRefreshToken`) when handing the
 *                     token to the client so we can revoke it without rolling keys.
 *
 * Key material comes from `env.JWT_SIGNING_KEY_*`. Both keys are PEM-encoded
 * Ed25519 keys; we parse them once at module load via the cached promises so
 * the per-request hot path doesn't touch the key parser.
 */

import type { Context, MiddlewareHandler } from "hono";
import {
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  errors as joseErrors,
} from "jose";
import type { JWTPayload, KeyLike } from "jose";
import { env } from "../env.ts";
import { patchCtx } from "../obs/context.ts";
import { childLogger } from "../obs/logger.ts";

const ALG = "EdDSA";
const log = childLogger("middleware/auth");

let privateKeyPromise: Promise<KeyLike> | null = null;
let publicKeyPromise: Promise<KeyLike> | null = null;
let ephemeralPair: Promise<{ privateKey: KeyLike; publicKey: KeyLike }> | null = null;

/**
 * Best-effort PEM normalizer. Accepts:
 *   - A raw PEM string (`-----BEGIN ...-----\n...`).
 *   - A single-line base64 of the PEM (handy for .env files which choke on
 *     literal newlines).
 * Returns the PEM string ready for `importPKCS8` / `importSPKI`.
 */
function normalizePem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  // Try base64-decode. Bun + Node both expose atob globally.
  try {
    const decoded = atob(trimmed);
    if (decoded.startsWith("-----BEGIN")) return decoded;
  } catch {
    /* fall through */
  }
  // Caller will throw on import; we return the raw value so the error message
  // mentions whatever the user actually pasted.
  return trimmed;
}

async function getEphemeralPair() {
  if (!ephemeralPair) {
    ephemeralPair = generateKeyPair(ALG, { crv: "Ed25519", extractable: true });
    log.warn(
      { event: "auth_keys_ephemeral" },
      "JWT signing keys are missing or malformed; generated ephemeral Ed25519 keys for this process. " +
        "Tokens will be invalidated on every restart. Run `bun run scripts/generate-jwt-keys.ts` " +
        "and paste the output into .env to persist sessions.",
    );
  }
  return ephemeralPair;
}

function getPrivateKey(): Promise<KeyLike> {
  if (!privateKeyPromise) {
    privateKeyPromise = (async () => {
      try {
        return await importPKCS8(normalizePem(env.JWT_SIGNING_KEY_PRIVATE), ALG);
      } catch (err) {
        if (env.NODE_ENV === "production") {
          log.error(
            { err: { message: (err as Error).message } },
            "JWT_SIGNING_KEY_PRIVATE is not a valid PKCS#8 PEM (raw or base64-encoded). Refusing to start.",
          );
          throw err;
        }
        const pair = await getEphemeralPair();
        return pair.privateKey;
      }
    })();
  }
  return privateKeyPromise;
}

function getPublicKey(): Promise<KeyLike> {
  if (!publicKeyPromise) {
    publicKeyPromise = (async () => {
      try {
        return await importSPKI(normalizePem(env.JWT_SIGNING_KEY_PUBLIC), ALG);
      } catch (err) {
        if (env.NODE_ENV === "production") {
          log.error(
            { err: { message: (err as Error).message } },
            "JWT_SIGNING_KEY_PUBLIC is not a valid SPKI PEM (raw or base64-encoded). Refusing to start.",
          );
          throw err;
        }
        const pair = await getEphemeralPair();
        return pair.publicKey;
      }
    })();
  }
  return publicKeyPromise;
}

/** Test/admin hook for swapping in test-generated keys. */
export function setAuthKeysForTesting(
  privateKey: KeyLike,
  publicKey: KeyLike,
): void {
  privateKeyPromise = Promise.resolve(privateKey);
  publicKeyPromise = Promise.resolve(publicKey);
}

/** Reset cached keys (also for tests). */
export function resetAuthKeysForTesting(): void {
  privateKeyPromise = null;
  publicKeyPromise = null;
}

export type UserRole = "patient" | "clinician" | "admin";

export interface AuthUser {
  id: string;
  role: UserRole;
  scopes: string[];
}

interface AccessTokenClaims extends JWTPayload {
  sub: string;
  role: UserRole;
  scopes: string[];
}

interface RefreshTokenClaims extends JWTPayload {
  sub: string;
  jti: string;
  typ: "refresh";
}

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Sign a fresh access token. The route handler logs are the source of truth
 * for issuance — this function only emits the token string.
 */
export async function issueAccessToken(
  userId: string,
  scopes: string[],
  role: UserRole,
): Promise<{ token: string; expiresAt: Date }> {
  const key = await getPrivateKey();
  const expiresAt = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000);
  const token = await new SignJWT({ role, scopes })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);
  return { token, expiresAt };
}

/**
 * Issue a refresh token. Returns the signed JWT, the random `jti`, and the
 * computed expiry so the caller can write the matching `refresh_tokens` row.
 */
export async function issueRefreshToken(userId: string): Promise<{
  token: string;
  jti: string;
  expiresAt: Date;
}> {
  const key = await getPrivateKey();
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  const token = await new SignJWT({ typ: "refresh" })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);
  return { token, jti, expiresAt };
}

export async function verifyRefreshToken(
  token: string,
): Promise<RefreshTokenClaims> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify<RefreshTokenClaims>(token, key, {
    algorithms: [ALG],
  });
  if (payload.typ !== "refresh" || !payload.jti) {
    throw new joseErrors.JWTInvalid("not a refresh token");
  }
  return payload;
}

export class AuthError extends Error {
  readonly code: "AUTH_MISSING" | "AUTH_INVALID" | "AUTH_EXPIRED" | "AUTH_FORBIDDEN";
  readonly status: 401 | 403;
  constructor(code: AuthError["code"], status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

function readBearerOrCookie(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const cookieHeader = c.req.header("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === "access_token") {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Middleware that requires a valid access token. Sets `c.var.user`
 * and patches the obs context with `userId`. Throws `AuthError` on failure
 * so the central error handler can map to 401/403.
 */
export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const token = readBearerOrCookie(c);
    if (!token) {
      throw new AuthError("AUTH_MISSING", 401, "missing access token");
    }
    let payload: AccessTokenClaims;
    try {
      const key = await getPublicKey();
      const verified = await jwtVerify<AccessTokenClaims>(token, key, {
        algorithms: [ALG],
      });
      payload = verified.payload;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new AuthError("AUTH_EXPIRED", 401, "access token expired");
      }
      throw new AuthError("AUTH_INVALID", 401, "invalid access token");
    }
    if (!payload.sub || !payload.role) {
      throw new AuthError("AUTH_INVALID", 401, "malformed access token");
    }
    const user: AuthUser = {
      id: payload.sub,
      role: payload.role,
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
    };
    c.set("user", user);
    patchCtx({ userId: user.id });
    await next();
  };
}

/**
 * Middleware factory requiring a specific scope. Use after `requireAuth()`.
 * Admins implicitly satisfy any scope check — keeps the call sites simple
 * without us having to maintain admin-equivalent scope arrays.
 */
export function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user) {
      throw new AuthError("AUTH_MISSING", 401, "auth required");
    }
    if (user.role === "admin") {
      await next();
      return;
    }
    if (!user.scopes.includes(scope)) {
      throw new AuthError("AUTH_FORBIDDEN", 403, `missing scope: ${scope}`);
    }
    await next();
  };
}
