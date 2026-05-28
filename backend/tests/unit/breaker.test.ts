import { describe, expect, it } from "bun:test";
import { BreakerOpenError, CircuitBreaker } from "../../src/obs/breaker";

function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const fail = () => Promise.reject(new Error("boom"));
const ok = () => Promise.resolve("ok");

describe("CircuitBreaker", () => {
  it("starts closed and lets calls through", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ now: clock.now });
    expect(b.state("openai")).toBe("closed");
    const r = await b.exec("openai", ok);
    expect(r).toBe("ok");
    expect(b.state("openai")).toBe("closed");
  });

  it("trips to open after 5 consecutive failures within the window", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < 5; i++) {
      await expect(b.exec("openai", fail)).rejects.toThrow("boom");
    }
    expect(b.state("openai")).toBe("open");
  });

  it("fast-fails with BreakerOpenError while open", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < 5; i++) {
      await expect(b.exec("openai", fail)).rejects.toThrow("boom");
    }
    await expect(b.exec("openai", ok)).rejects.toBeInstanceOf(BreakerOpenError);
  });

  it("moves to half_open after the cooldown elapses", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < 5; i++) {
      await expect(b.exec("openai", fail)).rejects.toThrow();
    }
    expect(b.state("openai")).toBe("open");

    clock.advance(29_999);
    expect(b.state("openai")).toBe("open");

    clock.advance(2);
    expect(b.state("openai")).toBe("half_open");
  });

  it("closes after two successes from half_open", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < 5; i++) {
      await expect(b.exec("openai", fail)).rejects.toThrow();
    }
    clock.advance(30_000);
    expect(b.state("openai")).toBe("half_open");

    await b.exec("openai", ok);
    expect(b.state("openai")).toBe("half_open");

    await b.exec("openai", ok);
    expect(b.state("openai")).toBe("closed");
  });

  it("re-opens immediately if a half_open probe fails", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < 5; i++) {
      await expect(b.exec("openai", fail)).rejects.toThrow();
    }
    clock.advance(30_000);
    expect(b.state("openai")).toBe("half_open");

    await expect(b.exec("openai", fail)).rejects.toThrow("boom");
    expect(b.state("openai")).toBe("open");
  });

  it("does not trip when failures are spread beyond the failure window", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker({ now: clock.now });
    // 4 failures, then wait 61s, then 4 more — never 5 in any 60s window.
    for (let i = 0; i < 4; i++) {
      await expect(b.exec("openai", fail)).rejects.toThrow();
    }
    clock.advance(61_000);
    for (let i = 0; i < 4; i++) {
      await expect(b.exec("openai", fail)).rejects.toThrow();
    }
    expect(b.state("openai")).toBe("closed");
  });
});
