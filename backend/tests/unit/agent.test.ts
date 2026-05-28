import { describe, expect, it } from "bun:test";
import { runAgent } from "../../src/agent/agent.ts";
import { TOOL_REGISTRY } from "../../src/agent/tools.ts";
import type { AgentEvent, StreamTurnEvent, Tool } from "../../src/agent/types.ts";
import { mockLLM, type Script } from "./mock-llm.ts";

const SYS = "test-system";

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function turnComplete(
  args: Partial<Extract<StreamTurnEvent, { type: "turn_complete" }>> = {},
): StreamTurnEvent {
  return {
    type: "turn_complete",
    content: [],
    stopReason: "end",
    usage: { inputTokens: 10, outputTokens: 5 },
    ...args,
  } as StreamTurnEvent;
}

// A trivial stub tool we register only for the duration of the test by
// monkey-patching TOOL_REGISTRY. Tests that need it set the key before running.
function withTempTool<T>(tool: Tool, fn: () => Promise<T>): Promise<T> {
  const prev = TOOL_REGISTRY[tool.name];
  TOOL_REGISTRY[tool.name] = tool;
  return fn().finally(() => {
    if (prev) TOOL_REGISTRY[tool.name] = prev;
    else delete TOOL_REGISTRY[tool.name];
  });
}

describe("runAgent", () => {
  it("emits text deltas and a final 'done' for a direct answer (no tool)", async () => {
    const llm = mockLLM([
      [
        { type: "text_delta", delta: "Hel" },
        { type: "text_delta", delta: "lo!" },
        turnComplete({
          content: [{ type: "text", text: "Hello!" }],
          stopReason: "end",
          usage: { inputTokens: 12, outputTokens: 3 },
        }),
      ],
    ]);

    const events = await collect(
      runAgent({
        llm,
        tools: [],
        system: SYS,
        history: [],
        userMessage: "hi",
        model: "gpt-5.2",
      }),
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("text");
    expect(types[types.length - 1]).toBe("done");
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hello!");

    const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
    expect(done.inputTokens).toBe(12);
    expect(done.outputTokens).toBe(3);
    expect(done.model).toBe("gpt-5.2");
  });

  it("executes a tool then answers — pending → running → complete ordering", async () => {
    const stub: Tool = {
      name: "fake_tool",
      description: "test",
      inputSchema: { type: "object" },
      execute: async () => "TOOL_OUTPUT_OK",
    };

    await withTempTool(stub, async () => {
      const llm = mockLLM([
        [
          { type: "text_delta", delta: "Let me check." },
          { type: "tool_use_complete", id: "t1", name: "fake_tool", input: { q: 1 } },
          turnComplete({
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_use", id: "t1", name: "fake_tool", input: { q: 1 } },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 5, outputTokens: 4 },
          }),
        ],
        [
          { type: "text_delta", delta: "Done." },
          turnComplete({
            content: [{ type: "text", text: "Done." }],
            stopReason: "end",
            usage: { inputTokens: 8, outputTokens: 1 },
          }),
        ],
      ]);

      const events = await collect(
        runAgent({
          llm,
          tools: [stub],
          system: SYS,
          history: [],
          userMessage: "go",
          model: "gpt-5.2",
        }),
      );

      const toolEvents = events.filter((e) => e.type === "tool_call") as Array<
        Extract<AgentEvent, { type: "tool_call" }>
      >;
      expect(toolEvents.map((e) => e.state)).toEqual(["pending", "running", "complete"]);
      expect(toolEvents[2]!.output).toContain("TOOL_OUTPUT_OK");

      // Final done's tokens are the sum across steps.
      const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
      expect(done.inputTokens).toBe(13);
      expect(done.outputTokens).toBe(5);
    });
  });

  it("respects the maxSteps cap — never more than N model turns", async () => {
    // Each script keeps stopReason: "tool_use" so the loop would run forever
    // without the cap.
    const stub: Tool = {
      name: "loop_tool",
      description: "test",
      inputSchema: { type: "object" },
      execute: async () => "ok",
    };

    await withTempTool(stub, async () => {
      const scriptForCall = (callIdx: number): Script => [
        { type: "tool_use_complete", id: `t${callIdx}`, name: "loop_tool", input: {} },
        turnComplete({
          content: [{ type: "tool_use", id: `t${callIdx}`, name: "loop_tool", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ];
      const llm = mockLLM([
        scriptForCall(1),
        scriptForCall(2),
        scriptForCall(3),
        scriptForCall(4),
        scriptForCall(5),
        scriptForCall(6),
      ]);

      const events = await collect(
        runAgent({
          llm,
          tools: [stub],
          system: SYS,
          history: [],
          userMessage: "loop",
          model: "gpt-5.2",
          maxSteps: 3,
        }),
      );

      // Exactly 3 model calls, never more.
      expect(llm.calls.length).toBe(3);
      // And the run still terminates with a done frame, not an error.
      const last = events[events.length - 1]!;
      expect(last.type).toBe("done");
    });
  });

  it("emits agent_error when the provider throws", async () => {
    const llm = mockLLM([[]], { throwOnCall: 0 });

    const events = await collect(
      runAgent({
        llm,
        tools: [],
        system: SYS,
        history: [],
        userMessage: "hi",
        model: "gpt-5.2",
      }),
    );

    const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(err).toBeDefined();
    expect(err.code).toBe("agent_error");
  });

  it("emits a 'failed' tool_call with unknown_tool when the registry doesn't contain the tool", async () => {
    const llm = mockLLM([
      [
        { type: "tool_use_complete", id: "x1", name: "definitely_not_registered", input: {} },
        turnComplete({
          content: [
            { type: "tool_use", id: "x1", name: "definitely_not_registered", input: {} },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
      [
        { type: "text_delta", delta: "ok" },
        turnComplete({
          content: [{ type: "text", text: "ok" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    ]);

    const events = await collect(
      runAgent({
        llm,
        tools: [],
        system: SYS,
        history: [],
        userMessage: "go",
        model: "gpt-5.2",
      }),
    );

    const toolEvents = events.filter((e) => e.type === "tool_call") as Array<
      Extract<AgentEvent, { type: "tool_call" }>
    >;
    expect(toolEvents.find((t) => t.state === "failed")).toBeDefined();
    expect(toolEvents.find((t) => t.state === "failed")?.output).toContain("unknown tool");
  });

  it("emits 'failed' with stringified error when a tool throws", async () => {
    const stub: Tool = {
      name: "broken_tool",
      description: "x",
      inputSchema: { type: "object" },
      execute: async () => {
        throw new Error("BOOM");
      },
    };

    await withTempTool(stub, async () => {
      const llm = mockLLM([
        [
          { type: "tool_use_complete", id: "b1", name: "broken_tool", input: {} },
          turnComplete({
            content: [{ type: "tool_use", id: "b1", name: "broken_tool", input: {} }],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        ],
        [
          { type: "text_delta", delta: "recovered" },
          turnComplete({
            content: [{ type: "text", text: "recovered" }],
            stopReason: "end",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        ],
      ]);

      const events = await collect(
        runAgent({
          llm,
          tools: [stub],
          system: SYS,
          history: [],
          userMessage: "go",
          model: "gpt-5.2",
        }),
      );

      const failed = (events.filter((e) => e.type === "tool_call") as Array<
        Extract<AgentEvent, { type: "tool_call" }>
      >).find((t) => t.state === "failed");
      expect(failed).toBeDefined();
      expect(failed!.output).toContain("BOOM");
    });
  });

  it("classifies mid-stream abort (after a token was sent) as 'stream_interrupted'", async () => {
    const ctl = new AbortController();
    const llm = mockLLM([
      [
        { type: "text_delta", delta: "first" },
        () => {
          // Abort right before the next event would have flowed.
          ctl.abort();
          return { type: "text_delta", delta: "never_seen" };
        },
        turnComplete({
          content: [{ type: "text", text: "first" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    ]);

    const events = await collect(
      runAgent({
        llm,
        tools: [],
        system: SYS,
        history: [],
        userMessage: "hi",
        model: "gpt-5.2",
        signal: ctl.signal,
      }),
    );

    const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(err).toBeDefined();
    expect(err.code).toBe("stream_interrupted");
    // The token we DID emit must have made it through before the abort.
    expect(events.find((e) => e.type === "text")).toBeDefined();
  });
});
