/**
 * Derived runtime limits and constants. Re-exports a curated, typed view of
 * `env.ts` so other modules import a single, stable surface for cost and
 * agent-loop knobs instead of fishing them out of the raw env each time.
 */

import { env } from "./env.ts";

export const NODE_ENV = env.NODE_ENV;
export const IS_PRODUCTION = env.NODE_ENV === "production";
export const IS_TEST = env.NODE_ENV === "test";

export const PORT = env.PORT;
export const LOG_LEVEL = env.LOG_LEVEL;
export const METRICS_ENABLED = env.METRICS_ENABLED;

// Agent loop caps
export const MAX_OUTPUT_TOKENS = env.MAX_OUTPUT_TOKENS;
export const MAX_AGENT_STEPS = env.MAX_AGENT_STEPS;
export const MAX_TURN_TOKENS = env.MAX_TURN_TOKENS;
export const MAX_TOOL_CALLS_PER_TURN = env.MAX_TOOL_CALLS_PER_TURN;
export const LLM_TIMEOUT_MS = env.LLM_TIMEOUT_MS;

// Cost controls
export const DAILY_BUDGET_USD = env.DAILY_BUDGET_USD;

// Model selection
export const OPENAI_MODEL = env.OPENAI_MODEL;
export const OPENAI_REASONING_EFFORT = env.OPENAI_REASONING_EFFORT;
export const OPENAI_BUDGET_MODEL = env.OPENAI_BUDGET_MODEL;
export const OPENAI_TTS_MODEL = env.OPENAI_TTS_MODEL;
export const OPENAI_TTS_VOICE = env.OPENAI_TTS_VOICE;

// Retention windows (days)
export const RETENTION_DAYS_CONVERSATIONS = env.RETENTION_DAYS_CONVERSATIONS;
export const RETENTION_DAYS_USAGE = env.RETENTION_DAYS_USAGE;
export const RETENTION_DAYS_AUDIT = env.RETENTION_DAYS_AUDIT;
export const RETENTION_DAYS_TTS_CACHE = env.RETENTION_DAYS_TTS_CACHE;
export const RETENTION_GRACE_DAYS = env.RETENTION_GRACE_DAYS;

// Observability
export const LANGFUSE_SAMPLE_RATE = env.LANGFUSE_SAMPLE_RATE;

// CORS / Auth
export const CORS_ALLOWED_ORIGINS = env.CORS_ALLOWED_ORIGINS;
