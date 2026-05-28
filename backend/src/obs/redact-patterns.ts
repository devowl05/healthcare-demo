/**
 * Regex catalog for PII / secret patterns that must be scrubbed from logs and
 * Langfuse payloads. This module is intentionally logic-free: just strings so
 * the same definitions can be referenced by `redact.ts`, by tests, and (if
 * needed) by docs without pulling in any heavy code.
 *
 * The CC pattern is deliberately permissive at the regex layer — `redact.ts`
 * runs a Luhn check on every match and rejects non-cards. This keeps the
 * regex simple (and fast) while preventing false positives like phone
 * numbers, order ids, etc.
 */

export const PATTERNS: Record<string, RegExp> = {
  // 9 digits with optional dashes; rejects 000-/666-/9xx-* and the four
  // commonly published "advertising" SSNs (e.g. 078-05-1120) by post-filter
  // in redact.ts. Regex alone is broad on purpose.
  SSN: /\b(?!000|666|9\d{2})(\d{3})[- ]?(?!00)(\d{2})[- ]?(?!0000)(\d{4})\b/g,

  // RFC-5322-ish; we accept a generous superset because we'd rather over-redact
  // logs than leak a real address through a corner case.
  EMAIL: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,

  // North American phone numbers: optional +1, optional parens, optional
  // separators. Requires the area code to start with [2-9] to skip
  // year-like sequences ("123-456-7890" still matches; user can disable
  // if it's a problem in practice).
  US_PHONE: /(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?([2-9]\d{2})[\s.\-]?(\d{4})\b/g,

  // YYYY-MM-DD and MM/DD/YYYY and DD-Mon-YYYY shapes — over-redacts in prose
  // (any ISO date will trigger), which is the safer failure mode.
  DOB: /\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/g,

  // Medical Record Number heuristic — 6–10 alphanumerics preceded by
  // "MRN" or "MRN#" (case-insensitive). Without that anchor we'd flag
  // every order id; with it we get high precision.
  MRN: /\bMRN[#:\s]*([A-Z0-9-]{6,12})\b/gi,

  // 13–19 digits with optional separators. redact.ts runs Luhn on the
  // digit-only form before redacting.
  CC: /\b(?:\d[ -]?){12,18}\d\b/g,
};
