/**
 * Cryptographic primitives used across the app.
 *
 *   - Password hash/verify: `argon2` (memory-hard; current OWASP recommendation).
 *     Parameters follow OWASP "argon2id, m=19MiB, t=2, p=1" — argon2's default
 *     ships with these.
 *   - HMAC-SHA256: used by redaction fingerprints and any future cursor-signing.
 *   - `hashChain`: tamper-evident append for the audit log. Each row's
 *     `prev_hash` is SHA-256(prev_hash_of_predecessor || canonical_payload),
 *     so any mutation downstream invalidates every successor.
 *
 * argon2 is a native CJS module; we import it as a default to dodge ESM
 * interop traps. The verify wrapper swallows the library's "argon2 verify
 * failed" exception and returns `false` so callers can write a clean `if`.
 */

import argon2 from "argon2";
import { createHash, createHmac } from "node:crypto";

/** Hash a password with argon2id using current OWASP defaults. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("hashPassword: password must be a non-empty string");
  }
  return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * Verify a password against a stored hash. Returns false on mismatch OR on
 * any malformed-digest error from argon2 — callers should treat both as
 * "wrong password" and never branch on the underlying reason.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (typeof hash !== "string" || typeof password !== "string") return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** HMAC-SHA256 helper. Returns lowercase hex by default. */
export function hmacSha256(key: string | Buffer, data: string | Buffer, encoding: "hex" | "base64url" = "hex"): string {
  const buf = createHmac("sha256", key).update(data).digest();
  if (encoding === "base64url") {
    return buf
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  return buf.toString("hex");
}

/**
 * Audit log hash chain step.
 *
 *   prev      — the previous row's `row_hash` (empty/zero buffer for the
 *               very first row in a chain)
 *   payload   — canonical JSON of the new row's substantive fields
 *
 * Deterministic: same `(prev, payload)` always yields the same digest.
 * Any change to `payload` or to any predecessor's payload propagates
 * forward through every subsequent hash, which is what makes the chain
 * tamper-evident.
 */
export function hashChain(prev: Buffer, payload: string): Buffer {
  const h = createHash("sha256");
  h.update(prev);
  // A NUL byte separator prevents prev||payload collisions where a chunk
  // boundary could be ambiguous.
  h.update(Buffer.from([0x00]));
  h.update(payload, "utf8");
  return h.digest();
}
