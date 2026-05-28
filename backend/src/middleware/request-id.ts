/**
 * Request-ID middleware.
 *
 * Pulls `x-request-id` from the incoming request if it's a valid UUID;
 * otherwise mints a fresh one via `crypto.randomUUID()`. The value is echoed
 * on the response and wraps every downstream handler in `runWithCtx({ requestId })`
 * so the pino logger picks it up automatically.
 *
 * We deliberately do NOT echo a client-supplied id verbatim if it's not a
 * UUID — a freeform identifier would muddy correlation when one client sends
 * "hello world" as a request id.
 */

import type { MiddlewareHandler } from "hono";
import { runWithCtx } from "../obs/context.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const id =
      incoming && UUID_RE.test(incoming) ? incoming : crypto.randomUUID();
    c.set("requestId", id);
    c.header("x-request-id", id);
    await runWithCtx({ requestId: id }, async () => {
      await next();
    });
  };
}
