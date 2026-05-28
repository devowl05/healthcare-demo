import { describe, expect, it } from "bun:test";
import { estimateInputTokens, wouldExceedTurnCap } from "../../src/agent/budget.ts";
import type { ChatMessage } from "../../src/agent/types.ts";

describe("estimateInputTokens", () => {
  it("returns a positive count for non-empty input", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "Hello, world!" }];
    expect(estimateInputTokens(msgs, "gpt-5.2")).toBeGreaterThan(0);
  });

  it("grows when more messages are added", () => {
    const small: ChatMessage[] = [{ role: "user", content: "hi" }];
    const big: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello, this is a much longer reply with detail" },
      { role: "user", content: "tell me more, please, with examples" },
    ];
    expect(estimateInputTokens(big, "gpt-5.2")).toBeGreaterThan(
      estimateInputTokens(small, "gpt-5.2"),
    );
  });

  it("counts content blocks", () => {
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking..." },
          { type: "tool_use", id: "t1", name: "lookup_drug", input: { name: "Advil" } },
        ],
      },
    ];
    expect(estimateInputTokens(msgs, "gpt-5.2")).toBeGreaterThan(0);
  });
});

describe("wouldExceedTurnCap", () => {
  it("returns true when estimate + maxOutput exceeds cap", () => {
    expect(wouldExceedTurnCap(15_000, 2_000, 16_000)).toBe(true);
  });

  it("returns false when within the cap", () => {
    expect(wouldExceedTurnCap(1_000, 2_000, 16_000)).toBe(false);
  });

  it("treats the boundary as 'not exceeded' (equal is fine)", () => {
    expect(wouldExceedTurnCap(14_000, 2_000, 16_000)).toBe(false);
  });
});
