/**
 * Tool registry.
 *
 * Two tools, both key-less so the demo runs without extra credentials:
 *
 *  - `lookup_drug`: hits openFDA's `/drug/label.json` against a HARDCODED base
 *    URL — no part of the user input ever influences the host or path. SSRF
 *    locked. 8s deadline, 2 retries on 5xx/network, 404 returns a clean
 *    "not found" string, response body capped at 512 KB. Returns a formatted
 *    multi-line block (Drug / Indications / Warnings / Source).
 *
 *  - `check_symptoms`: pure function over the bundled `SYMPTOM_DB`. Returns
 *    matched terms + overall urgency + bullets + the standing disclaimer.
 *
 * Contract: `execute()` must return a string and must NEVER throw. We catch
 * every error at the seam and convert it to a readable string. Callers
 * (the agent loop) rely on this to keep streaming forward on tool failures.
 */

import { withBackoff } from "../lib/retry.ts";
import { matchSymptoms } from "./symptoms.ts";
import type { Tool } from "./types.ts";

const OPENFDA_BASE = "https://api.fda.gov/drug/label.json";
const RESPONSE_CAP_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Read up to `cap` bytes from a Response body. We can't trust `Content-Length`
 * (some openFDA proxies omit it), so we stream the reader and bail at the cap.
 */
async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        try {
          await reader.cancel();
        } catch {
          /* swallow */
        }
        throw new Error(`response too large (>${cap} bytes)`);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Combine the outer agent abort with a per-call timeout. We can't use
 * AbortSignal.any() in older runtimes; manual wiring keeps it portable.
 */
function withTimeout(outer: AbortSignal, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error("tool timeout")), ms);
  const onOuter = () => ctl.abort(outer.reason);
  if (outer.aborted) {
    ctl.abort(outer.reason);
  } else {
    outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ctl.signal,
    cancel: () => {
      clearTimeout(t);
      outer.removeEventListener("abort", onOuter);
    },
  };
}

function escapeFdaQuery(name: string): string {
  // openFDA's search uses Lucene-like syntax; escape the operator chars we
  // care about and strip newlines. We don't URL-encode here — `URL` does that.
  return name
    .replace(/[\\:"+\-!(){}\[\]^~?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function lookupDrugExec(input: any, signal: AbortSignal): Promise<string> {
  try {
    const rawName = typeof input?.name === "string" ? input.name : "";
    const name = rawName.slice(0, 100).trim();
    if (!name) return "lookup_drug: missing 'name' input.";

    const safe = escapeFdaQuery(name);
    if (!safe) return `lookup_drug: input '${rawName}' produced an empty query after sanitization.`;

    const url = new URL(OPENFDA_BASE);
    url.searchParams.set(
      "search",
      `openfda.brand_name:"${safe}" openfda.generic_name:"${safe}"`,
    );
    url.searchParams.set("limit", "1");

    const doFetch = async (): Promise<string> => {
      const { signal: inner, cancel } = withTimeout(signal, FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url.toString(), {
          method: "GET",
          signal: inner,
          redirect: "error", // never follow redirects
          headers: { accept: "application/json" },
        });
        if (res.status === 404) {
          return `No openFDA label found for "${rawName}". Try the generic or alternate brand name, or consult a pharmacist.`;
        }
        if (res.status >= 500) {
          const err = new Error(`openFDA ${res.status}`);
          (err as Error & { status: number }).status = res.status;
          throw err;
        }
        if (!res.ok) {
          return `openFDA returned ${res.status} for "${rawName}".`;
        }
        const body = await readCapped(res, RESPONSE_CAP_BYTES);
        const parsed = JSON.parse(body) as {
          results?: Array<{
            openfda?: { brand_name?: string[]; generic_name?: string[] };
            indications_and_usage?: string[];
            warnings?: string[];
            warnings_and_cautions?: string[];
          }>;
        };
        const row = parsed.results?.[0];
        if (!row) {
          return `No openFDA label found for "${rawName}".`;
        }
        const brand = row.openfda?.brand_name?.[0] ?? rawName;
        const generic = row.openfda?.generic_name?.[0] ?? "(unknown generic)";
        const ind = (row.indications_and_usage?.[0] ?? "Not provided.").slice(0, 1200);
        const warn =
          (row.warnings?.[0] ?? row.warnings_and_cautions?.[0] ?? "Not provided.").slice(0, 1200);
        return [
          `Drug: ${brand} (${generic})`,
          `Indications: ${ind}`,
          `Warnings: ${warn}`,
          "Source: openFDA (https://open.fda.gov/) — general information only, not medical advice.",
        ].join("\n");
      } finally {
        cancel();
      }
    };

    return await withBackoff(doFetch, {
      maxAttempts: 3, // 2 retries beyond the initial attempt
      baseMs: 250,
      capMs: 2_000,
      retryOn: (err) => {
        if (signal.aborted) return false;
        if (err && typeof err === "object") {
          const e = err as { status?: number; name?: string; code?: string };
          if (e.name === "AbortError") return false;
          if (typeof e.status === "number") return e.status >= 500;
        }
        return true; // network / unknown → retry
      },
    });
  } catch (err) {
    if (signal.aborted) {
      return "lookup_drug: aborted.";
    }
    return `lookup_drug: ${stringifyErr(err)}`;
  }
}

async function checkSymptomsExec(input: any, _signal: AbortSignal): Promise<string> {
  try {
    const arr: string[] = Array.isArray(input?.symptoms)
      ? input.symptoms.filter((s: unknown) => typeof s === "string").slice(0, 12)
      : [];
    const trimmed = arr.map((s) => s.slice(0, 80));
    const { matched, urgency, bullets } = matchSymptoms(trimmed);

    if (matched.length === 0) {
      return [
        "Matched symptoms: (none recognised from the built-in list).",
        "OVERALL URGENCY: unknown",
        "- If symptoms are severe, sudden, or worsening, contact a clinician.",
        "Reminder: this is general information, not a diagnosis.",
      ].join("\n");
    }

    return [
      `Matched symptoms: ${matched.join(", ")}`,
      `OVERALL URGENCY: ${String(urgency).toUpperCase()}`,
      ...bullets.map((b) => `- ${b}`),
      "Reminder: this is general information, not a diagnosis.",
    ].join("\n");
  } catch (err) {
    return `check_symptoms: ${stringifyErr(err)}`;
  }
}

export const TOOLS: Tool[] = [
  {
    name: "lookup_drug",
    description:
      "Look up FDA label information for a medication by brand or generic name (openFDA, no PHI sent).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Drug name (brand or generic), max 100 chars.",
          maxLength: 100,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: lookupDrugExec,
  },
  {
    name: "check_symptoms",
    description:
      "Triage a list of symptom phrases against a built-in conservative reference and return urgency + general guidance.",
    inputSchema: {
      type: "object",
      properties: {
        symptoms: {
          type: "array",
          items: { type: "string", maxLength: 80 },
          maxItems: 12,
          description: "Symptom phrases the user described.",
        },
      },
      required: ["symptoms"],
      additionalProperties: false,
    },
    execute: checkSymptomsExec,
  },
];

export const TOOL_REGISTRY: Record<string, Tool> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);
