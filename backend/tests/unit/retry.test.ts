import { describe, expect, it } from "bun:test";
import { withBackoff } from "../../src/lib/retry";

function makeSleep() {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { sleep, sleeps };
}

describe("withBackoff", () => {
  it("returns immediately on first success", async () => {
    const { sleep, sleeps } = makeSleep();
    let calls = 0;
    const out = await withBackoff(async () => {
      calls++;
      return "ok";
    }, { sleep });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("succeeds after N transient failures within maxAttempts", async () => {
    const { sleep, sleeps } = makeSleep();
    let calls = 0;
    const out = await withBackoff(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("temp"), { status: 503 });
        return "done";
      },
      { sleep, maxAttempts: 3, jitter: false, baseMs: 10, capMs: 100 },
    );
    expect(out).toBe("done");
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    // No jitter => exact exponential: 10, 20
    expect(sleeps[0]).toBe(10);
    expect(sleeps[1]).toBe(20);
  });

  it("respects maxAttempts and rethrows the last error", async () => {
    const { sleep } = makeSleep();
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw Object.assign(new Error("nope"), { status: 503 });
        },
        { sleep, maxAttempts: 3, jitter: false, baseMs: 1, capMs: 10 },
      ),
    ).rejects.toThrow("nope");
    expect(calls).toBe(3);
  });

  it("does not retry 4xx errors (other than 408/429)", async () => {
    const { sleep } = makeSleep();
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw Object.assign(new Error("bad request"), { status: 400 });
        },
        { sleep, maxAttempts: 5 },
      ),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  it("honors a numeric Retry-After header (in seconds)", async () => {
    const { sleep, sleeps } = makeSleep();
    let calls = 0;
    const fakeResponseLikeErr = {
      status: 429,
      message: "rate limited",
      headers: {
        get: (k: string) => (k.toLowerCase() === "retry-after" ? "2" : null),
      },
    };
    const out = await withBackoff(
      async () => {
        calls++;
        if (calls === 1) throw fakeResponseLikeErr;
        return "ok";
      },
      { sleep, maxAttempts: 3, baseMs: 10, capMs: 60_000, jitter: false },
    );
    expect(out).toBe("ok");
    // Retry-After: 2s → 2000ms wait
    expect(sleeps).toEqual([2000]);
  });

  it("respects retryAfterMs field if provided", async () => {
    const { sleep, sleeps } = makeSleep();
    let calls = 0;
    await withBackoff(
      async () => {
        calls++;
        if (calls === 1) throw { retryAfterMs: 750, status: 503 };
        return "ok";
      },
      { sleep, maxAttempts: 2, baseMs: 5, capMs: 60_000, jitter: false },
    );
    expect(sleeps).toEqual([750]);
  });
});
