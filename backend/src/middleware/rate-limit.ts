/**
 * Rate-limiting middleware.
 *
 * Backed by `rate-limiter-flexible`. Each protected route gets a pair of
 * limiters — one keyed by client IP, one by authenticated user id — so a
 * single user can't burn through everyone else's IP quota and vice versa.
 *
 * Redis is preferred (shared across replicas via `env.REDIS_URL`); if the
 * Redis client never opens we fall back to an in-process `RateLimiterMemory`
 * and log a warning. The fallback is correct-but-permissive for a single
 * replica; horizontal scaleout needs Redis.
 *
 * On exceed we surface 429 + `Retry-After` (in seconds). For SSE-mid-stream
 * trips we expose `tripStreamLimit(retryAfter)` which returns an envelope
 * the chat handler can emit as an error frame before closing the stream.
 */

import type { MiddlewareHandler } from "hono";
import IORedis from "ioredis";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
  type RateLimiterRes,
} from "rate-limiter-flexible";
import { env } from "../env.ts";
import { logger } from "../obs/logger.ts";
import type { AuthUser } from "./auth.ts";

let redisClient: IORedis | null = null;
let redisFailed = false;

function getRedis(): IORedis | null {
  if (redisFailed) return null;
  if (redisClient) return redisClient;
  try {
    redisClient = new IORedis(env.REDIS_URL, {
      lazyConnect: true,
      // Keep offline queue enabled so a transient drop doesn't immediately
      // throw "Stream isn't writeable" — ioredis buffers commands and replays
      // when reconnected. Bounded retries prevent us from blocking forever.
      enableOfflineQueue: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      retryStrategy(times) {
        // Exponential backoff up to 10s between reconnect attempts.
        return Math.min(times * 200, 10_000);
      },
    });
    redisClient.on("error", (err) => {
      if (!redisFailed) {
        logger.warn({ err }, "rate_limit_redis_error");
      }
      // Mark failed so live limiters know to use memory; the client keeps
      // trying to reconnect in the background. We never re-promote it during
      // the process lifetime because that could cause double-counting on the
      // boundary; a restart picks up Redis cleanly.
      redisFailed = true;
    });
    return redisClient;
  } catch (err) {
    logger.warn({ err }, "rate_limit_redis_init_failed");
    redisFailed = true;
    return null;
  }
}

/** Test/admin hook for forcing the memory backend (e.g. unit tests). */
export function forceMemoryBackendForTesting(): void {
  redisFailed = true;
  redisClient = null;
}

/** Common signature of a Redis-down (vs limit-exceeded) failure. */
function isRedisInfrastructureError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message ?? "";
  return (
    msg.includes("Stream isn't writeable") ||
    msg.includes("Connection is closed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("Reached the max retries per request") ||
    msg.includes("Command timed out") ||
    msg.toLowerCase().includes("redis")
  );
}

export interface RateLimitOpts {
  /** Stable name — used as the Redis keyPrefix and the metric label. */
  name: string;
  /** Max requests allowed per `windowSec`. */
  points: number;
  /** Sliding window length in seconds. */
  windowSec: number;
}

function makeLimiter(opts: RateLimitOpts, suffix: "ip" | "user"): RateLimiterAbstract {
  const keyPrefix = `${opts.name}:${suffix}`;
  const redis = getRedis();
  if (redis) {
    return new RateLimiterRedis({
      storeClient: redis,
      keyPrefix,
      points: opts.points,
      duration: opts.windowSec,
    });
  }
  return new RateLimiterMemory({
    keyPrefix,
    points: opts.points,
    duration: opts.windowSec,
  });
}

function getClientIp(headers: Record<string, string | undefined>, remote?: string): string {
  const xff = headers["x-forwarded-for"];
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return remote ?? "unknown";
}

function rateLimitResponseHeaders(res: RateLimiterRes): { retryAfter: number } {
  const ms = res.msBeforeNext ?? 1000;
  return { retryAfter: Math.max(1, Math.ceil(ms / 1000)) };
}

/**
 * Factory that returns a Hono middleware. Limits per IP AND per user when a
 * user is present (auth middleware must run first to set `c.var.user`); when
 * no user is present (anonymous endpoints) only the IP limit applies.
 */
export function rateLimit(opts: RateLimitOpts): MiddlewareHandler {
  let ipLimiter = makeLimiter(opts, "ip");
  let userLimiter = makeLimiter(opts, "user");
  let fellBackToMemory = false;

  function ensureMemoryFallback(reason: unknown): void {
    if (fellBackToMemory) return;
    fellBackToMemory = true;
    redisFailed = true;
    logger.warn(
      { err: reason },
      "rate_limit_redis_unavailable_falling_back_to_memory",
    );
    ipLimiter = new RateLimiterMemory({
      keyPrefix: `${opts.name}:ip`,
      points: opts.points,
      duration: opts.windowSec,
    });
    userLimiter = new RateLimiterMemory({
      keyPrefix: `${opts.name}:user`,
      points: opts.points,
      duration: opts.windowSec,
    });
  }

  async function consume(ip: string, userId: string | undefined): Promise<void> {
    try {
      await ipLimiter.consume(ip);
      if (userId) await userLimiter.consume(userId);
    } catch (err) {
      // Limit hit — propagate so the caller can return 429.
      if (err && typeof err === "object" && "msBeforeNext" in err) {
        throw err;
      }
      // Redis infrastructure failure — fall back to memory and replay once.
      if (isRedisInfrastructureError(err)) {
        ensureMemoryFallback(err);
        await ipLimiter.consume(ip);
        if (userId) await userLimiter.consume(userId);
        return;
      }
      throw err;
    }
  }

  return async (c, next) => {
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const remote =
      (c.env as { remoteAddr?: string } | undefined)?.remoteAddr ?? undefined;
    const ip = getClientIp(headers, remote);
    const user = c.get("user") as AuthUser | undefined;

    try {
      await consume(ip, user?.id);
    } catch (err) {
      if (err && typeof err === "object" && "msBeforeNext" in err) {
        const { retryAfter } = rateLimitResponseHeaders(err as RateLimiterRes);
        c.header("Retry-After", String(retryAfter));
        return c.json(
          {
            code: "rate_limited",
            message: "Too many requests; slow down.",
            retry_after_seconds: retryAfter,
          },
          429,
        );
      }
      // Last-resort safety net: never 500 because of rate-limit infra. Log and
      // pass through — the chat route still enforces token quotas at a higher
      // layer.
      logger.error(
        { err },
        "rate_limit_unexpected_error_passing_through",
      );
    }
    await next();
  };
}

/**
 * Convenience for the SSE streaming path: returns a payload the chat route
 * can emit as an `error` frame before closing the stream. Keeps the protocol
 * frame shape out of the middleware abstraction.
 */
export interface StreamLimitFrame {
  type: "error";
  code: "rate_limited";
  retry_after_seconds: number;
  message: string;
}

export function tripStreamLimit(retryAfter: number): StreamLimitFrame {
  return {
    type: "error",
    code: "rate_limited",
    retry_after_seconds: retryAfter,
    message: "rate limit exceeded mid-stream",
  };
}
