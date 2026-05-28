/**
 * Prometheus metrics.
 *
 * Two modes:
 *   - METRICS_ENABLED=true → real prom-client metrics registered against the
 *     module-local `register`. `/metrics` route serializes via `register.metrics()`.
 *   - METRICS_ENABLED=false → every exported metric is a no-op shim with the
 *     same shape (`.inc`, `.observe`, etc.). Call sites stay unconditional;
 *     this keeps the hot path branch-free.
 *
 * Histograms use buckets tuned for HTTP / LLM latencies. Adjust per
 * observation of real traffic, not on a whim.
 */

import client from "prom-client";
import { env } from "../env";

/**
 * Minimal call-site interface. Both real prom-client metrics and our no-op
 * shims conform to this. We deliberately do NOT re-export prom-client's
 * fuller types — call sites only need `.inc()` / `.observe()` with labels.
 */
export interface CounterLike {
  inc(labels?: Partial<Record<string, string | number>>, value?: number): void;
}

export interface HistogramLike {
  observe(labels: Partial<Record<string, string | number>>, value: number): void;
}

const noopCounter: CounterLike = {
  inc() {
    /* no-op */
  },
};

const noopHistogram: HistogramLike = {
  observe() {
    /* no-op */
  },
};

const enabled = env.METRICS_ENABLED;

export const register = enabled ? new client.Registry() : new client.Registry();
if (enabled) {
  // Process / event-loop metrics for free.
  client.collectDefaultMetrics({ register });
}

function counter(name: string, help: string, labelNames: string[]): CounterLike {
  if (!enabled) return noopCounter;
  return new client.Counter({ name, help, labelNames, registers: [register] });
}

function histogram(
  name: string,
  help: string,
  labelNames: string[],
  buckets: number[],
): HistogramLike {
  if (!enabled) return noopHistogram;
  return new client.Histogram({
    name,
    help,
    labelNames,
    buckets,
    registers: [register],
  });
}

// HTTP latency buckets in ms: covers fast cached hits up to slow LLM turns.
const LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000,
];

export const chatRequestsTotal = counter(
  "chat_requests_total",
  "Total number of chat requests by terminal status",
  ["status"],
);

export const chatToolCallsTotal = counter(
  "chat_tool_calls_total",
  "Total number of tool calls by tool name and outcome state",
  ["name", "state"],
);

export const chatTokensTotal = counter(
  "chat_tokens_total",
  "Total tokens accounted by model and direction (input|output|reasoning)",
  ["model", "direction"],
);

export const chatCachedTokensTotal = counter(
  "chat_cached_tokens_total",
  "Cached tokens reported by the provider per model",
  ["model"],
);

export const chatCostUsdTotal = counter(
  "chat_cost_usd_total",
  "Cumulative cost in USD by model",
  ["model"],
);

export const chatLatencyMs = histogram(
  "chat_latency_ms",
  "End-to-end latency by phase (request|first_token|tool_call|total)",
  ["phase"],
  LATENCY_BUCKETS_MS,
);

export const chatErrorsTotal = counter(
  "chat_errors_total",
  "Errors by stable error code",
  ["code"],
);
