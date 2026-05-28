/**
 * Double-submit-cookie CSRF protection.
 *
 * On safe methods (GET/HEAD/OPTIONS) we no-op. On any mutating method we
 * require the `X-CSRF-Token` header to equal the `csrf_token` cookie. The
 * cookie itself is *not* HttpOnly (the SPA reads it via `document.cookie` and
 * echoes it on the header); we set `SameSite=Strict` to prevent same-origin
 * subresources from forging the header.
 *
 * The token is opaque random bytes — there's no signing or rotation per
 * request because the security property comes from "same-origin can read,
 * cross-origin can't".
 */

import type { Context, MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const COOKIE_NAME = "csrf_token";
const HEADER_NAME = "x-csrf-token";

export class CsrfError extends Error {
  readonly code = "CSRF_FAILED";
  readonly status = 403 as const;
  constructor(message: string) {
    super(message);
    this.name = "CsrfError";
  }
}

function readCookie(c: Context, name: string): string | null {
  const cookieHeader = c.req.header("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Constant-time string comparison. We don't trust JS's `===` to short-circuit
 * predictably on token length, even though the practical risk is low here.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Set the CSRF cookie. Call from `/login` (and any auth-transition route) so
 * the SPA has something to echo on the first mutating request.
 */
export function setCsrfCookie(c: Context): string {
  const token = crypto.randomUUID().replaceAll("-", "");
  // SameSite=Strict + Secure in prod. We keep `httpOnly` OFF so JS can read it.
  const isProd = process.env.NODE_ENV === "production";
  const flags = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "SameSite=Strict",
    isProd ? "Secure" : "",
    `Max-Age=${60 * 60 * 24 * 7}`,
  ].filter(Boolean);
  c.header("Set-Cookie", flags.join("; "), { append: true });
  return token;
}

export function csrf(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }
    const headerToken = c.req.header(HEADER_NAME);
    const cookieToken = readCookie(c, COOKIE_NAME);
    if (!headerToken || !cookieToken) {
      throw new CsrfError("missing csrf token");
    }
    if (!timingSafeEqual(headerToken, cookieToken)) {
      throw new CsrfError("csrf token mismatch");
    }
    await next();
  };
}
