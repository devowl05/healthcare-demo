/**
 * SSE protocol contract test.
 *
 * The backend emits SSE frames via `stream.writeSSE({ event: "<name>", ... })`
 * and the frontend declares the set of accepted events in a discriminated union
 * (`ServerEvent`) inside `frontend/src/protocol/frames.ts`.
 *
 * Both sides MUST stay in lockstep: if the backend introduces a new frame the
 * client can't decode it, and if the frontend drops one the backend's emission
 * becomes dead code. Without a shared schema layer (the frontend deliberately
 * doesn't import zod to keep its bundle small) we can't enforce this at the
 * type level across the bundle boundary.
 *
 * Strategy: read both files as raw text, extract event-name string literals
 * with regexes anchored to the call sites that produce them, set-diff the two
 * collections. Any asymmetry fails the test with the offending names listed.
 *
 * This is a STRUCTURAL check — it does not validate frame *payloads*. Payload
 * shape drift will surface in integration tests instead.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BACKEND_CHAT_PATH = resolve(
  __dirname,
  "..",
  "..",
  "src",
  "routes",
  "chat.ts",
);

const FRONTEND_FRAMES_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "frontend",
  "src",
  "protocol",
  "frames.ts",
);

/**
 * Pull every backend `event: "<name>"` literal out of `writeSSE` call sites.
 * The route uses object-literal syntax: `await stream.writeSSE({ event: "X", ... })`.
 */
function extractBackendEvents(src: string): Set<string> {
  const events = new Set<string>();
  // Match `event: "<name>"` — quotation can be single, double, or backtick.
  const re = /\bevent\s*:\s*(["'`])([a-z_][a-z0-9_]*)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    events.add(m[2]!);
  }
  return events;
}

/**
 * Pull every frontend `ServerEvent` arm's `event` discriminant. The shape is
 * `{ event: "X"; data: ... }` repeated inside the union.
 */
function extractFrontendEvents(src: string): Set<string> {
  const events = new Set<string>();
  const re = /\bevent\s*:\s*(["'`])([a-z_][a-z0-9_]*)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    events.add(m[2]!);
  }
  return events;
}

describe("SSE protocol contract", () => {
  it("backend and frontend declare the same set of SSE event names", () => {
    const backendSrc = readFileSync(BACKEND_CHAT_PATH, "utf8");
    const frontendSrc = readFileSync(FRONTEND_FRAMES_PATH, "utf8");

    const backendEvents = extractBackendEvents(backendSrc);
    const frontendEvents = extractFrontendEvents(frontendSrc);

    // Snapshot the structural shape so changes are visible in code review.
    // (Use sorted arrays so order isn't load-bearing.)
    const backendSorted = [...backendEvents].sort();
    const frontendSorted = [...frontendEvents].sort();

    // Backend must emit at least the canonical set we expect.
    expect(backendSorted.length).toBeGreaterThan(0);
    expect(frontendSorted.length).toBeGreaterThan(0);

    const onlyBackend = backendSorted.filter((e) => !frontendEvents.has(e));
    const onlyFrontend = frontendSorted.filter((e) => !backendEvents.has(e));

    if (onlyBackend.length > 0 || onlyFrontend.length > 0) {
      const msg = [
        "SSE event-name drift between backend and frontend:",
        onlyBackend.length > 0
          ? `  Backend emits but frontend does not declare: ${JSON.stringify(onlyBackend)}`
          : null,
        onlyFrontend.length > 0
          ? `  Frontend declares but backend does not emit: ${JSON.stringify(onlyFrontend)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      throw new Error(msg);
    }

    expect(onlyBackend).toEqual([]);
    expect(onlyFrontend).toEqual([]);
  });

  it("includes the canonical core events", () => {
    // Hard-coded sanity floor. If any of these disappear from either side
    // something serious has changed and we want the test to scream.
    const backendSrc = readFileSync(BACKEND_CHAT_PATH, "utf8");
    const frontendSrc = readFileSync(FRONTEND_FRAMES_PATH, "utf8");
    const backend = extractBackendEvents(backendSrc);
    const frontend = extractFrontendEvents(frontendSrc);

    const canonical = ["conversation", "text", "tool_call", "done", "error", "replay"];
    for (const name of canonical) {
      expect(backend.has(name)).toBe(true);
      expect(frontend.has(name)).toBe(true);
    }
  });
});
