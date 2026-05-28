/**
 * String + JSON redaction used by the logger, Langfuse exporter, and any code
 * path that emits user-influenced data to an external sink.
 *
 * Matches are replaced with `[REDACTED:KIND:<hmac6>]` where `<hmac6>` is the
 * first six hex chars of HMAC-SHA256(key, original). This keeps logs
 * non-reversible while letting operators correlate repeat occurrences across
 * lines without storing the original PII.
 *
 * `redactJson` walks objects/arrays and only touches string leaves — numbers,
 * booleans, null pass through unchanged. We intentionally avoid mutating the
 * input so the original payload remains intact for the caller.
 */

import { createHmac } from "node:crypto";
import { PATTERNS } from "./redact-patterns";

const HMAC_KEY = process.env.REDACT_HMAC_KEY ?? "healthcare-redact-dev-key";

function fingerprint(original: string): string {
  return createHmac("sha256", HMAC_KEY).update(original).digest("hex").slice(0, 6);
}

/**
 * Luhn check on the digit-only form of a candidate credit card number.
 * Rejects e.g. phone-like sequences that happen to have the right length.
 */
function luhnValid(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    let n = ch;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// SSN advertising/sample numbers that public guidance says to avoid using as
// real SSNs. We still redact for safety, but listing here for documentation.
// (The pattern itself already excludes 000/666/9xx area numbers.)

function replaceAll(
  source: string,
  pattern: RegExp,
  kind: string,
  validate?: (match: string) => boolean,
): string {
  // Each call gets a fresh regex copy so lastIndex from prior runs doesn't bleed.
  const re = new RegExp(pattern.source, pattern.flags);
  return source.replace(re, (match) => {
    if (validate && !validate(match)) return match;
    return `[REDACTED:${kind}:${fingerprint(match)}]`;
  });
}

/**
 * Redact PII patterns from a string. Idempotent: re-running over an already
 * redacted string is a no-op because `[REDACTED:...]` doesn't match any of
 * the patterns.
 */
export function redactForLogs(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  out = replaceAll(out, PATTERNS.CC!, "CC", luhnValid);
  out = replaceAll(out, PATTERNS.SSN!, "SSN");
  out = replaceAll(out, PATTERNS.EMAIL!, "EMAIL");
  out = replaceAll(out, PATTERNS.US_PHONE!, "PHONE");
  out = replaceAll(out, PATTERNS.DOB!, "DOB");
  out = replaceAll(out, PATTERNS.MRN!, "MRN");
  return out;
}

/**
 * Deep-walk an object/array and redact every string leaf. Returns a new value;
 * the input is not mutated. Cycles are detected via a WeakSet so circular
 * graphs don't blow the stack — cycle re-references are passed through as-is.
 */
export function redactJson<T>(value: T, _seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactForLogs(value) as unknown as T;
  if (typeof value !== "object") return value;
  if (_seen.has(value as object)) return value;
  _seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redactJson(v, _seen)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactJson(v, _seen);
  }
  return out as unknown as T;
}
