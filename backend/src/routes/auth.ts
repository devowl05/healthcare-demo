/**
 * Authentication routes.
 *
 * Login uses argon2 verification (constant-time) and on success issues:
 *   - an EdDSA access JWT (15 min) returned in the JSON body so the SPA can
 *     stash it in memory; and
 *   - an opaque-from-the-client refresh JWT recorded in `refresh_tokens` and
 *     set as `HttpOnly; Secure; SameSite=Strict` cookie. The matching
 *     CSRF cookie is set on the same response so the first mutating call
 *     after login can double-submit.
 *
 * Refresh implements strict rotation — every successful refresh revokes the
 * old jti and emits a new one. The middleware already validates signature,
 * expiry, and the `typ: refresh` claim; we additionally require the row to
 * still be present and not revoked (anti-replay).
 *
 * Logout best-effort revokes the current refresh row and clears both cookies.
 *
 * Register exists for the demo seed flow and is gated behind
 * `env.ALLOW_REGISTRATION` (default true) so a future production deploy can
 * flip it off without code changes.
 */

import { Hono } from "hono";
import { z } from "zod";
import { env } from "../env.ts";
import {
  AuthError,
  issueAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
} from "../middleware/auth.ts";
import { setCsrfCookie } from "../middleware/csrf.ts";
import { append as auditAppend } from "../repo/audit-log.ts";
import {
  createUser,
  findActiveRefreshToken,
  findUserById,
  insertRefreshToken,
  revokeRefreshToken,
  verifyCredentials,
} from "../repo/users.ts";
import { childLogger } from "../obs/logger.ts";

const log = childLogger("routes/auth");

const REFRESH_COOKIE = "refresh_token";
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const PATIENT_SCOPES = ["chat:write", "tts:write"];

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

const RegisterBody = z.object({
  email: z.string().email().max(254),
  // Light validation only — argon2 will happily hash anything; we still want
  // to refuse the obvious "" / 1-char demo footguns.
  password: z.string().min(8).max(1024),
});

function isProd(): boolean {
  return env.NODE_ENV === "production";
}

function refreshCookieAttrs(): string[] {
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    isProd() ? "Secure" : "",
    `Max-Age=${REFRESH_TTL_SECONDS}`,
  ].filter(Boolean);
}

function readRefreshCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === REFRESH_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function actorIp(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

export function buildAuthRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // POST /register
  // -------------------------------------------------------------------------
  router.post("/register", async (c) => {
    if (!env.ALLOW_REGISTRATION) {
      return c.json({ code: "registration_disabled", message: "self-registration is disabled" }, 403);
    }
    const json = await c.req.json().catch(() => ({}));
    const parsed = RegisterBody.safeParse(json);
    if (!parsed.success) {
      return c.json(
        {
          code: "validation_failed",
          message: "invalid registration payload",
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      const user = await createUser(parsed.data.email, parsed.data.password, "patient");
      await auditAppend({
        ctx: { actorIp: actorIp(c) },
        action: "auth.register",
        resourceType: "user",
        resourceId: user.id,
        metadata: { email: user.email },
      });
      return c.json({ user }, 201);
    } catch (err) {
      // 23505 = unique_violation (email already exists)
      if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
        return c.json({ code: "email_taken", message: "email already registered" }, 409);
      }
      log.error({ err }, "register_failed");
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // POST /login
  // -------------------------------------------------------------------------
  router.post("/login", async (c) => {
    const json = await c.req.json().catch(() => ({}));
    const parsed = LoginBody.safeParse(json);
    if (!parsed.success) {
      return c.json(
        {
          code: "validation_failed",
          message: "invalid login payload",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const user = await verifyCredentials(parsed.data.email, parsed.data.password);
    if (!user) {
      await auditAppend({
        ctx: { actorIp: actorIp(c) },
        action: "auth.login_failed",
        resourceType: "user",
        resourceId: null,
        metadata: { email: parsed.data.email },
      });
      return c.json({ code: "invalid_credentials", message: "invalid email or password" }, 401);
    }

    const scopes = user.role === "admin" ? [...PATIENT_SCOPES, "admin"] : PATIENT_SCOPES;
    const access = await issueAccessToken(user.id, scopes, user.role);
    const refresh = await issueRefreshToken(user.id);
    await insertRefreshToken(refresh.jti, user.id, refresh.expiresAt);

    const cookieAttrs = refreshCookieAttrs();
    c.header(
      "Set-Cookie",
      `${REFRESH_COOKIE}=${refresh.token}; ${cookieAttrs.join("; ")}`,
      { append: true },
    );
    setCsrfCookie(c);

    await auditAppend({
      ctx: { userId: user.id, actorIp: actorIp(c) },
      action: "auth.login",
      resourceType: "user",
      resourceId: user.id,
    });

    return c.json({
      user,
      accessToken: access.token,
      expiresAt: access.expiresAt.toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /refresh
  // -------------------------------------------------------------------------
  router.post("/refresh", async (c) => {
    const token = readRefreshCookie(c.req.header("cookie"));
    if (!token) {
      throw new AuthError("AUTH_MISSING", 401, "missing refresh token");
    }

    let claims: { sub: string; jti: string };
    try {
      const verified = await verifyRefreshToken(token);
      claims = { sub: verified.sub, jti: verified.jti };
    } catch {
      throw new AuthError("AUTH_INVALID", 401, "invalid refresh token");
    }

    const row = await findActiveRefreshToken(claims.jti);
    if (!row || row.user_id !== claims.sub) {
      throw new AuthError("AUTH_INVALID", 401, "refresh token revoked or unknown");
    }

    const user = await findUserById(claims.sub);
    if (!user) {
      throw new AuthError("AUTH_INVALID", 401, "user no longer exists");
    }

    // Rotate: revoke the old jti, issue a fresh pair.
    await revokeRefreshToken(claims.jti);
    const scopes = user.role === "admin" ? [...PATIENT_SCOPES, "admin"] : PATIENT_SCOPES;
    const access = await issueAccessToken(user.id, scopes, user.role);
    const next = await issueRefreshToken(user.id);
    await insertRefreshToken(next.jti, user.id, next.expiresAt);

    const cookieAttrs = refreshCookieAttrs();
    c.header(
      "Set-Cookie",
      `${REFRESH_COOKIE}=${next.token}; ${cookieAttrs.join("; ")}`,
      { append: true },
    );
    setCsrfCookie(c);

    return c.json({
      user: { id: user.id, email: user.email, role: user.role },
      accessToken: access.token,
      expiresAt: access.expiresAt.toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /logout
  // -------------------------------------------------------------------------
  router.post("/logout", async (c) => {
    const token = readRefreshCookie(c.req.header("cookie"));
    let userId: string | null = null;
    if (token) {
      try {
        const verified = await verifyRefreshToken(token);
        userId = verified.sub;
        await revokeRefreshToken(verified.jti);
      } catch {
        // Best-effort — even if the refresh token is malformed we still
        // want to clear cookies and respond 204.
      }
    }

    // Clear refresh + csrf cookies. Setting Max-Age=0 is the standard way.
    const clearAttrs = ["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", isProd() ? "Secure" : ""]
      .filter(Boolean)
      .join("; ");
    c.header("Set-Cookie", `${REFRESH_COOKIE}=; ${clearAttrs}`, { append: true });
    c.header(
      "Set-Cookie",
      `csrf_token=; Path=/; SameSite=Strict; Max-Age=0${isProd() ? "; Secure" : ""}`,
      { append: true },
    );

    if (userId) {
      await auditAppend({
        ctx: { userId, actorIp: actorIp(c) },
        action: "auth.logout",
        resourceType: "user",
        resourceId: userId,
      });
    }

    return c.body(null, 204);
  });

  return router;
}

export const authRouter = buildAuthRouter();
