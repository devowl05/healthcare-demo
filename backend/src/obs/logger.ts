/**
 * Root pino logger.
 *
 * Production: writes line-delimited JSON to stdout for ingestion by Loki /
 * Datadog / etc. Development: pretty-prints via `pino-pretty` if it's
 * installed; otherwise silently falls back to JSON (we don't make
 * `pino-pretty` a hard dependency because nothing breaks without it).
 *
 * Every log line gets `requestId` (and `userId`/`conversationId` when
 * present) automatically via a `mixin` that reads our AsyncLocalStorage
 * context. Secrets and PII are redacted via pino's path-based `redact`
 * config — for user-content payloads that need pattern-based redaction,
 * pass them through `redactForLogs` / `redactJson` BEFORE handing them to
 * the logger.
 */

import pino, { type Logger, type LoggerOptions } from "pino";
import { env } from "../env";
import { getCtx } from "./context";

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.OPENAI_API_KEY',
  '*.LANGFUSE_SECRET_KEY',
  'user.email',
  'body.message',
  'body.messages[*].content',
];

function makeOptions(): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    base: { service: "healthcare-agent" },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const ctx = getCtx();
      if (!ctx) return {};
      const out: Record<string, string> = { requestId: ctx.requestId };
      if (ctx.userId) out.userId = ctx.userId;
      if (ctx.conversationId) out.conversationId = ctx.conversationId;
      return out;
    },
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
      remove: false,
    },
  };
}

/**
 * Try to load `pino-pretty` for dev. We do this synchronously via `require`
 * resolved through `createRequire` so the logger is usable at module load
 * (no top-level await). Missing module: fall through to JSON.
 */
function maybePretty(): Logger {
  const opts = makeOptions();
  if (env.NODE_ENV !== "development") {
    return pino(opts);
  }
  try {
    // Resolve pino-pretty lazily; pino will load it via its transport mechanism.
    // If unavailable, pino throws a "unable to determine transport target" — we
    // catch and fall back to plain JSON below.
    return pino({
      ...opts,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
      },
    });
  } catch {
    return pino(opts);
  }
}

export const logger: Logger = maybePretty();

/**
 * Helper for sub-loggers scoped to a module. Use this in feature code:
 *   const log = childLogger("agent");
 * so log lines get `{ component: "agent" }` automatically.
 */
export function childLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ component, ...bindings });
}
