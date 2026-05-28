/**
 * Environment validation — fail-fast at import time.
 *
 * Loaded once at module top-level by every entrypoint (server, migrate runner,
 * retention worker, jobs). When NODE_ENV === "test", required secrets are
 * substituted with safe placeholders so unit tests can import dependent modules
 * without provisioning a real database / OpenAI key. This is the ONLY place that
 * branch on NODE_ENV — the rest of the code treats `env` as opaque.
 */

import { z } from "zod";

const csv = (input: string): string[] =>
  input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const csvSchema = z
  .string()
  .min(1, "must be a non-empty CSV string")
  .transform((s, ctx) => {
    const parts = csv(s);
    if (parts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must contain at least one origin",
      });
      return z.NEVER;
    }
    return parts;
  });

const positiveInt = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const nonNegativeInt = (defaultValue: number) =>
  z.coerce.number().int().nonnegative().default(defaultValue);

const positiveNumber = (defaultValue: number) =>
  z.coerce.number().positive().default(defaultValue);

const probability = (defaultValue: number) =>
  z.coerce.number().min(0).max(1).default(defaultValue);

const boolish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v) => {
      if (typeof v === "boolean") return v;
      const lower = v.trim().toLowerCase();
      return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
    });

const logLevelSchema = z
  .enum(["trace", "debug", "info", "warn", "error", "fatal"])
  .default("info");

const nodeEnvSchema = z
  .enum(["development", "test", "production"])
  .default("development");

const EnvSchema = z.object({
  // Runtime
  NODE_ENV: nodeEnvSchema,
  PORT: positiveInt(3000),
  LOG_LEVEL: logLevelSchema,
  METRICS_ENABLED: boolish(false),

  // Secrets / connection strings
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  JWT_SIGNING_KEY_PRIVATE: z.string().min(1, "JWT_SIGNING_KEY_PRIVATE is required"),
  JWT_SIGNING_KEY_PUBLIC: z.string().min(1, "JWT_SIGNING_KEY_PUBLIC is required"),
  CORS_ALLOWED_ORIGINS: csvSchema,

  // OpenAI tuning
  OPENAI_MODEL: z.string().default("gpt-5.2"),
  OPENAI_REASONING_EFFORT: z
    .enum(["none", "low", "medium", "high", "xhigh"])
    .default("medium"),
  OPENAI_BUDGET_MODEL: z.string().default("gpt-5.4-mini"),
  OPENAI_TTS_MODEL: z.string().default("gpt-4o-mini-tts"),
  OPENAI_TTS_VOICE: z.string().default("alloy"),

  // Agent / cost caps
  MAX_OUTPUT_TOKENS: positiveInt(2048),
  MAX_AGENT_STEPS: positiveInt(5),
  MAX_TURN_TOKENS: positiveInt(16000),
  MAX_TOOL_CALLS_PER_TURN: positiveInt(6),
  LLM_TIMEOUT_MS: positiveInt(60_000),
  DAILY_BUDGET_USD: positiveNumber(5.0),

  // Retention
  RETENTION_DAYS_CONVERSATIONS: nonNegativeInt(90),
  RETENTION_DAYS_USAGE: nonNegativeInt(365),
  RETENTION_DAYS_AUDIT: nonNegativeInt(2555),
  RETENTION_DAYS_TTS_CACHE: nonNegativeInt(30),
  RETENTION_GRACE_DAYS: nonNegativeInt(30),

  // Observability
  LANGFUSE_SAMPLE_RATE: probability(1.0),

  // Metrics gate (optional bearer token for /metrics scrape)
  METRICS_BEARER: z.string().optional(),

  // Feature flags
  ALLOW_REGISTRATION: boolish(true),
  MOCK_TTS: boolish(false),

  // When true the agent uses a deterministic scripted LLM (see
  // tests/integration/mock-llm.ts) instead of OpenAI. For integration tests.
  MOCK_LLM: boolish(false),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Pull a raw env var, honoring the documented `OPEN_AI_API_KEY` fallback for
 * the user's legacy `.env`. Returns `undefined` if neither is set so the
 * downstream zod validator can produce a single, well-shaped error.
 */
function rawEnv(source: Record<string, string | undefined>): Record<string, unknown> {
  const merged = { ...source };
  // Legacy fallback: project .env historically used `OPEN_AI_API_KEY`.
  if (!merged.OPENAI_API_KEY && merged.OPEN_AI_API_KEY) {
    merged.OPENAI_API_KEY = merged.OPEN_AI_API_KEY;
  }
  return merged;
}

const TEST_DEFAULTS: Record<string, string> = {
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  OPENAI_API_KEY: "sk-test-placeholder",
  JWT_SIGNING_KEY_PRIVATE:
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n",
  JWT_SIGNING_KEY_PUBLIC:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA==\n-----END PUBLIC KEY-----\n",
  CORS_ALLOWED_ORIGINS: "http://localhost:5173",
};

/**
 * Substitute placeholders for required vars when running under NODE_ENV=test
 * so unit tests can import this module without provisioning real secrets.
 * Tests that *want* to exercise validation can call `loadEnv({...})` directly.
 */
function applyTestDefaultsIfTesting(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (raw.NODE_ENV !== "test") return raw;
  const out = { ...raw };
  for (const [key, value] of Object.entries(TEST_DEFAULTS)) {
    if (out[key] === undefined || out[key] === "") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validate an arbitrary source map and return the parsed env. Throws on
 * failure with a multi-line message listing every issue. Exported so tests can
 * exercise validation against synthetic inputs without poking `process.env`.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const raw = applyTestDefaultsIfTesting(rawEnv(source));
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();
