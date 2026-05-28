import { describe, expect, it } from "bun:test";
import { loadEnv } from "../../src/env.ts";

/**
 * `env.ts` is imported by every entrypoint, so its validation behavior is
 * load-bearing. We test the three things that can break in surprising ways:
 *   1. The `OPEN_AI_API_KEY` -> `OPENAI_API_KEY` fallback for the legacy .env.
 *   2. Hard failure when required vars are missing in non-test envs.
 *   3. The test-mode bypass that lets unit tests import dependent modules.
 */

const baseProduction = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@h:5432/d",
  REDIS_URL: "redis://h:6379",
  OPENAI_API_KEY: "sk-real",
  JWT_SIGNING_KEY_PRIVATE: "priv",
  JWT_SIGNING_KEY_PUBLIC: "pub",
  CORS_ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com",
};

describe("env.loadEnv", () => {
  it("accepts OPEN_AI_API_KEY as a fallback for OPENAI_API_KEY", () => {
    const { OPENAI_API_KEY, ...withoutKey } = baseProduction;
    const env = loadEnv({
      ...withoutKey,
      OPEN_AI_API_KEY: "sk-from-legacy-name",
    });
    expect(env.OPENAI_API_KEY).toBe("sk-from-legacy-name");
  });

  it("prefers OPENAI_API_KEY over OPEN_AI_API_KEY when both are set", () => {
    const env = loadEnv({
      ...baseProduction,
      OPEN_AI_API_KEY: "sk-legacy",
    });
    expect(env.OPENAI_API_KEY).toBe("sk-real");
  });

  it("rejects missing required vars in production", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        // everything else missing
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it("rejects when CORS_ALLOWED_ORIGINS is empty", () => {
    expect(() =>
      loadEnv({
        ...baseProduction,
        CORS_ALLOWED_ORIGINS: "",
      }),
    ).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it("parses CSV CORS_ALLOWED_ORIGINS into a trimmed array", () => {
    const env = loadEnv({
      ...baseProduction,
      CORS_ALLOWED_ORIGINS: " https://a.example.com , https://b.example.com ",
    });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("substitutes safe defaults under NODE_ENV=test so unit tests can import", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.NODE_ENV).toBe("test");
    expect(env.DATABASE_URL).toContain("postgres://");
    expect(env.OPENAI_API_KEY.length).toBeGreaterThan(0);
    expect(env.JWT_SIGNING_KEY_PRIVATE.length).toBeGreaterThan(0);
    expect(env.JWT_SIGNING_KEY_PUBLIC.length).toBeGreaterThan(0);
    expect(env.CORS_ALLOWED_ORIGINS.length).toBeGreaterThan(0);
  });

  it("applies declared defaults for optional knobs", () => {
    const env = loadEnv(baseProduction);
    expect(env.OPENAI_MODEL).toBe("gpt-5.2");
    expect(env.OPENAI_REASONING_EFFORT).toBe("medium");
    expect(env.OPENAI_BUDGET_MODEL).toBe("gpt-5.4-mini");
    expect(env.OPENAI_TTS_MODEL).toBe("gpt-4o-mini-tts");
    expect(env.OPENAI_TTS_VOICE).toBe("alloy");
    expect(env.MAX_OUTPUT_TOKENS).toBe(2048);
    expect(env.MAX_AGENT_STEPS).toBe(5);
    expect(env.MAX_TURN_TOKENS).toBe(16_000);
    expect(env.MAX_TOOL_CALLS_PER_TURN).toBe(6);
    expect(env.LLM_TIMEOUT_MS).toBe(60_000);
    expect(env.DAILY_BUDGET_USD).toBe(5.0);
    expect(env.RETENTION_DAYS_CONVERSATIONS).toBe(90);
    expect(env.RETENTION_DAYS_USAGE).toBe(365);
    expect(env.RETENTION_DAYS_AUDIT).toBe(2555);
    expect(env.RETENTION_DAYS_TTS_CACHE).toBe(30);
    expect(env.RETENTION_GRACE_DAYS).toBe(30);
    expect(env.LANGFUSE_SAMPLE_RATE).toBe(1.0);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.METRICS_ENABLED).toBe(false);
    expect(env.PORT).toBe(3000);
  });

  it("coerces numeric env strings into numbers", () => {
    const env = loadEnv({
      ...baseProduction,
      MAX_OUTPUT_TOKENS: "1024",
      DAILY_BUDGET_USD: "2.5",
      LANGFUSE_SAMPLE_RATE: "0.1",
      PORT: "4000",
    });
    expect(env.MAX_OUTPUT_TOKENS).toBe(1024);
    expect(env.DAILY_BUDGET_USD).toBe(2.5);
    expect(env.LANGFUSE_SAMPLE_RATE).toBeCloseTo(0.1);
    expect(env.PORT).toBe(4000);
  });

  it("rejects out-of-range LANGFUSE_SAMPLE_RATE", () => {
    expect(() =>
      loadEnv({
        ...baseProduction,
        LANGFUSE_SAMPLE_RATE: "1.5",
      }),
    ).toThrow(/LANGFUSE_SAMPLE_RATE/);
  });

  it("parses METRICS_ENABLED truthy strings", () => {
    for (const v of ["1", "true", "yes", "on"]) {
      const env = loadEnv({ ...baseProduction, METRICS_ENABLED: v });
      expect(env.METRICS_ENABLED).toBe(true);
    }
    for (const v of ["0", "false", "no", ""]) {
      const env = loadEnv({ ...baseProduction, METRICS_ENABLED: v });
      expect(env.METRICS_ENABLED).toBe(false);
    }
  });
});
