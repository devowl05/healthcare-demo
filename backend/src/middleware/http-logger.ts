/**
 * HTTP access-log middleware.
 *
 * Thin equivalent of `hono-pino`: writes one JSON line per request with the
 * method, normalized path, status, duration, and request id. Skips `/health`
 * and `/ready` so the noise floor stays sane under k8s liveness probes.
 *
 * The pino logger already attaches `requestId` via its `mixin`; we still log
 * it explicitly so the access-log line is self-contained when grepping.
 */

import type { MiddlewareHandler } from "hono";
import { logger } from "../obs/logger.ts";

const SKIP = new Set(["/health", "/ready", "/metrics"]);

export function httpLogger(): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (SKIP.has(path)) {
      await next();
      return;
    }
    const start = performance.now();
    let errored: unknown;
    try {
      await next();
    } catch (err) {
      errored = err;
      throw err;
    } finally {
      const duration = Math.round(performance.now() - start);
      const status = c.res?.status ?? 0;
      const requestId = c.get("requestId") as string | undefined;
      const line = {
        method: c.req.method,
        path,
        status,
        durationMs: duration,
        requestId,
      };
      if (errored || status >= 500) {
        logger.error({ ...line, err: errored }, "http_request");
      } else if (status >= 400) {
        logger.warn(line, "http_request");
      } else {
        logger.info(line, "http_request");
      }
    }
  };
}
