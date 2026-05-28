/**
 * Langfuse wrapper.
 *
 * Three guarantees:
 *   1. If LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set, the module
 *      exports `langfuse = null` and every helper becomes a no-op. We log a
 *      single warn at boot — never throw.
 *   2. Every `input` / `output` value handed to Langfuse is passed through
 *      `redactJson` first. There is no other code path that uploads payloads
 *      to Langfuse; all callers go through `generation()` / `span()` /
 *      `withTrace()` here.
 *   3. Langfuse failures never propagate. Every call is wrapped in
 *      `try/catch` returning `undefined`. The SDK already retries
 *      transient failures internally; we just refuse to let an outage
 *      become an app outage.
 */

import { Langfuse } from "langfuse";
import { env } from "../env";
import { logger } from "./logger";
import { redactJson } from "./redact";

const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;
const BASE_URL = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

function buildClient(): Langfuse | null {
  if (!PUBLIC_KEY || !SECRET_KEY) {
    logger.warn(
      { component: "langfuse" },
      "Langfuse not configured (missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY); tracing disabled",
    );
    return null;
  }
  try {
    return new Langfuse({
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      baseUrl: BASE_URL,
      sampleRate: env.LANGFUSE_SAMPLE_RATE,
      flushAt: 10,
      flushInterval: 5000,
    });
  } catch (err) {
    logger.warn({ component: "langfuse", err }, "Langfuse init failed; tracing disabled");
    return null;
  }
}

export const langfuse: Langfuse | null = buildClient();

/** Coerce arbitrary payloads through PII redaction before they leave the process. */
function clean<T>(value: T): T {
  return redactJson(value);
}

export interface TraceOptions {
  name: string;
  userId?: string;
  sessionId?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface GenerationOptions {
  name: string;
  model?: string;
  modelParameters?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SpanOptions {
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Open a Langfuse trace, run `fn`, and close it. The trace handle is passed
 * to `fn` so nested code can attach generations/spans; when Langfuse is
 * disabled, the handle is `null` and child calls become no-ops.
 *
 * Errors from `fn` are rethrown after the trace is updated with the error
 * message — i.e. tracing is observational, not a swallow.
 */
export async function withTrace<T>(
  opts: TraceOptions,
  fn: (trace: ReturnType<NonNullable<typeof langfuse>["trace"]> | null) => Promise<T>,
): Promise<T> {
  if (!langfuse) {
    return fn(null);
  }
  let trace: ReturnType<NonNullable<typeof langfuse>["trace"]> | null = null;
  try {
    trace = langfuse.trace({
      name: opts.name,
      userId: opts.userId,
      sessionId: opts.sessionId,
      input: opts.input !== undefined ? clean(opts.input) : undefined,
      metadata: opts.metadata ? clean(opts.metadata) : undefined,
      tags: opts.tags,
    });
  } catch (err) {
    logger.debug({ component: "langfuse", err }, "trace() failed; continuing untraced");
  }
  try {
    const result = await fn(trace);
    try {
      trace?.update({ output: clean(result) });
    } catch {
      /* swallow */
    }
    return result;
  } catch (err) {
    try {
      trace?.update({
        output: { error: (err as Error).message },
        metadata: { error: true },
      });
    } catch {
      /* swallow */
    }
    throw err;
  }
}

/**
 * Standalone generation observation. Caller passes the parent trace if any;
 * otherwise it's created at the trace root.
 */
export function generation(opts: GenerationOptions) {
  if (!langfuse) return null;
  try {
    return langfuse.generation({
      name: opts.name,
      model: opts.model,
      modelParameters: opts.modelParameters as never,
      input: opts.input !== undefined ? clean(opts.input) : undefined,
      output: opts.output !== undefined ? clean(opts.output) : undefined,
      metadata: opts.metadata ? clean(opts.metadata) : undefined,
    });
  } catch (err) {
    logger.debug({ component: "langfuse", err }, "generation() failed");
    return null;
  }
}

export function span(opts: SpanOptions) {
  if (!langfuse) return null;
  try {
    return langfuse.span({
      name: opts.name,
      input: opts.input !== undefined ? clean(opts.input) : undefined,
      output: opts.output !== undefined ? clean(opts.output) : undefined,
      metadata: opts.metadata ? clean(opts.metadata) : undefined,
    });
  } catch (err) {
    logger.debug({ component: "langfuse", err }, "span() failed");
    return null;
  }
}

/**
 * Flush any queued events then disable the client. Called on SIGTERM. Wraps
 * the SDK's `flushAsync()` in a 2-second timeout so a stuck Langfuse endpoint
 * can't block shutdown.
 */
export async function shutdown(): Promise<void> {
  if (!langfuse) return;
  const flush = (async () => {
    try {
      await langfuse.flushAsync();
    } catch (err) {
      logger.debug({ component: "langfuse", err }, "flushAsync failed");
    }
  })();
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
  await Promise.race([flush, timeout]);
  try {
    langfuse.shutdown();
  } catch {
    /* swallow */
  }
}
