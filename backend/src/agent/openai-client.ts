/**
 * OpenAI adapter implementing the provider-neutral `LLMClient` interface.
 *
 * This is the ONLY file in `agent/` that imports the OpenAI SDK. Everything
 * else (the loop, the splitter, tools, pricing) speaks `ChatMessage` /
 * `StreamTurnEvent`. To swap providers, write another file like this one.
 *
 * Reliability layering for `streamTurn`:
 *   - `runWithCtx` so any log lines inside still carry `requestId`.
 *   - `breaker.exec("openai", …)` — circuit breaker fast-fails when the
 *     provider has been unhealthy.
 *   - `withBackoff` — retry once or twice on 429 / 5xx / network errors,
 *     never on 4xx-validation, honoring `Retry-After`.
 *   - try/catch — every error becomes either a thrown `BreakerOpenError`
 *     (passed through unchanged for the agent loop to label
 *     `upstream_unavailable`) or a normalized provider error.
 *
 * The streaming consumer routes text deltas through a `ThinkingSplitter`,
 * splitting `<thinking>...</thinking>` content into the `reasoning` channel.
 * Tool-call argument fragments are accumulated by `id` (the OpenAI streaming
 * format chunks `arguments` JSON) and emitted as a single `tool_use_complete`
 * once the chunk that closes the tool_call arrives.
 */

import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { env } from "../env.ts";
import { withBackoff } from "../lib/retry.ts";
import { breaker } from "../obs/breaker.ts";
import { getCtx, runWithCtx } from "../obs/context.ts";
import { childLogger } from "../obs/logger.ts";
import { createSplitter } from "./thinking-splitter.ts";
import type {
  ChatMessage,
  ContentBlock,
  LLMClient,
  StreamTurnEvent,
  Tool,
} from "./types.ts";

const log = childLogger("openai-client");

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  cachedClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return cachedClient;
}

/** Map our provider-neutral messages to the OpenAI chat completions shape. */
function toOpenAIMessages(
  system: string,
  messages: ChatMessage[],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];

  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: stringContent(m.content) });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: stringContent(m.content) });
      continue;
    }
    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        out.push({ role: "assistant", content: m.content });
        continue;
      }
      // Split blocks into the text + tool_calls pair OpenAI expects.
      const textParts: string[] = [];
      const toolCalls: NonNullable<
        Extract<ChatCompletionMessageParam, { role: "assistant" }>["tool_calls"]
      > = [];
      for (const b of m.content) {
        if (b.type === "text") textParts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: safeJsonStringify(b.input),
            },
          });
        }
      }
      out.push({
        role: "assistant",
        content: textParts.join("") || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (m.role === "tool") {
      // Each tool_result becomes its own `role: "tool"` message.
      if (typeof m.content === "string") {
        out.push({ role: "tool", content: m.content, tool_call_id: "unknown" });
        continue;
      }
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({
            role: "tool",
            content: b.content,
            tool_call_id: b.tool_use_id,
          });
        }
      }
    }
  }
  return out;
}

function stringContent(c: string | ContentBlock[]): string {
  if (typeof c === "string") return c;
  return c
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function toOpenAITools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

/**
 * In-progress tool call accumulated across stream chunks. OpenAI sends the
 * function `arguments` JSON in fragments keyed by `index`; the `id` arrives
 * on the first fragment.
 */
interface PendingToolCall {
  id: string;
  name: string;
  argsText: string;
  emitted: boolean;
}

interface AccumulatedTurn {
  text: string;
  reasoning: string;
  byIndex: Map<number, PendingToolCall>;
  stopReason: "end" | "tool_use" | "length" | "error";
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}

function isRetriable(err: unknown): boolean {
  if (!err || typeof err !== "object") return true;
  const e = err as { status?: number; name?: string; code?: string };
  if (e.name === "AbortError" || e.name === "APIUserAbortError") return false;
  if (typeof e.status === "number") {
    if (e.status === 408 || e.status === 429 || e.status >= 500) return true;
    if (e.status >= 400) return false;
  }
  return true;
}

async function* streamTurnImpl(args: {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: Tool[];
  signal: AbortSignal;
  reasoningEffort?: string;
  maxOutputTokens?: number;
}): AsyncGenerator<StreamTurnEvent> {
  const client = getClient();
  const splitter = createSplitter();

  const baseParams: Record<string, unknown> = {
    model: args.model,
    messages: toOpenAIMessages(args.system, args.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (args.tools.length > 0) {
    baseParams.tools = toOpenAITools(args.tools);
  }
  if (args.maxOutputTokens) {
    // OpenAI deprecated `max_tokens` for reasoning models (gpt-5.x, o1, o3) —
    // they require `max_completion_tokens` instead. Detect the family and pick
    // the right key. Older `gpt-4o*` / `gpt-3.5*` keep `max_tokens` for
    // backwards compatibility.
    const usesCompletionTokens = /^(gpt-5|o\d)/i.test(args.model);
    if (usesCompletionTokens) {
      baseParams.max_completion_tokens = args.maxOutputTokens;
    } else {
      baseParams.max_tokens = args.maxOutputTokens;
    }
  }
  if (args.reasoningEffort && args.reasoningEffort !== "none") {
    baseParams.reasoning_effort = args.reasoningEffort;
  }

  // We open the stream under retry+breaker but consume it OUTSIDE so partially
  // emitted text isn't re-sent on retry. If the open fails transiently, retry;
  // once bytes have flowed, errors bubble straight up.
  const stream = await breaker.exec("openai", () =>
    withBackoff(
      () =>
        client.chat.completions.create(
          baseParams as never,
          { signal: args.signal },
        ) as unknown as Promise<AsyncIterable<ChatCompletionChunk>>,
      {
        maxAttempts: 3,
        baseMs: 400,
        capMs: 4_000,
        retryOn: (err) => !args.signal.aborted && isRetriable(err),
      },
    ),
  );

  const acc: AccumulatedTurn = {
    text: "",
    reasoning: "",
    byIndex: new Map(),
    stopReason: "end",
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  try {
    for await (const chunk of stream) {
      if (args.signal.aborted) break;

      // Usage is sent on the final chunk when stream_options.include_usage=true.
      const usage = (chunk as unknown as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage;
      if (usage) {
        acc.usage.inputTokens = usage.prompt_tokens ?? acc.usage.inputTokens;
        acc.usage.outputTokens = usage.completion_tokens ?? acc.usage.outputTokens;
        if (usage.prompt_tokens_details?.cached_tokens) {
          acc.usage.cachedInputTokens = usage.prompt_tokens_details.cached_tokens;
        }
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        const segs = splitter.push(delta.content);
        for (const s of segs) {
          if (s.kind === "text") {
            acc.text += s.text;
            yield { type: "text_delta", delta: s.text };
          } else {
            acc.reasoning += s.text;
            yield { type: "reasoning_delta", delta: s.text };
          }
        }
      }

      // Some reasoning models echo their internal chain in a separate field.
      const reasoning = (delta as unknown as { reasoning_content?: string })?.reasoning_content;
      if (reasoning) {
        acc.reasoning += reasoning;
        yield { type: "reasoning_delta", delta: reasoning };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const slot =
            acc.byIndex.get(idx) ??
            ({ id: "", name: "", argsText: "", emitted: false } satisfies PendingToolCall);
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.argsText += tc.function.arguments;
          acc.byIndex.set(idx, slot);
        }
      }

      if (choice.finish_reason) {
        if (choice.finish_reason === "tool_calls") acc.stopReason = "tool_use";
        else if (choice.finish_reason === "length") acc.stopReason = "length";
        else if (choice.finish_reason === "stop") acc.stopReason = "end";
        else acc.stopReason = "end";
      }
    }

    // Flush whatever's left in the splitter (e.g. a partial-tag tail).
    const tail = splitter.flush();
    for (const s of tail) {
      if (s.kind === "text") {
        acc.text += s.text;
        yield { type: "text_delta", delta: s.text };
      } else {
        acc.reasoning += s.text;
        yield { type: "reasoning_delta", delta: s.text };
      }
    }

    // Emit each completed tool_use exactly once.
    const sortedIdx = Array.from(acc.byIndex.keys()).sort((a, b) => a - b);
    for (const i of sortedIdx) {
      const slot = acc.byIndex.get(i)!;
      if (!slot.id || !slot.name || slot.emitted) continue;
      let input: unknown = {};
      try {
        input = slot.argsText ? JSON.parse(slot.argsText) : {};
      } catch {
        input = { _rawArguments: slot.argsText };
      }
      slot.emitted = true;
      yield {
        type: "tool_use_complete",
        id: slot.id,
        name: slot.name,
        input,
      };
    }

    // Assemble the final assistant content[] for the loop's next-step messages.
    const content: ContentBlock[] = [];
    if (acc.text) content.push({ type: "text", text: acc.text });
    for (const i of sortedIdx) {
      const slot = acc.byIndex.get(i)!;
      if (!slot.id || !slot.name) continue;
      let input: unknown = {};
      try {
        input = slot.argsText ? JSON.parse(slot.argsText) : {};
      } catch {
        input = { _rawArguments: slot.argsText };
      }
      content.push({ type: "tool_use", id: slot.id, name: slot.name, input });
    }

    yield {
      type: "turn_complete",
      content,
      stopReason: acc.stopReason,
      usage: acc.usage,
    };
  } catch (err) {
    log.debug({ err }, "openai stream consumer error");
    throw err;
  }
}

class OpenAIClient implements LLMClient {
  streamTurn(args: {
    model: string;
    system: string;
    messages: ChatMessage[];
    tools: Tool[];
    signal: AbortSignal;
    reasoningEffort?: string;
    maxOutputTokens?: number;
  }): AsyncIterable<StreamTurnEvent> {
    const ctx = getCtx();
    const inner = streamTurnImpl(args);
    if (!ctx) return inner;
    // Re-wrap so each `next()` runs inside the same context — keeps log lines
    // tagged with the originating requestId even on later chunks.
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamTurnEvent> {
        const it = inner[Symbol.asyncIterator]();
        return {
          next: () => runWithCtx(ctx, () => it.next()),
          return: it.return?.bind(it),
          throw: it.throw?.bind(it),
        };
      },
    };
  }
}

export const openaiClient: LLMClient = new OpenAIClient();

/**
 * Test seam. Set via `setLLMClientForTesting(mock)` to swap in a scripted
 * client for integration tests; `createOpenAIClient()` returns this override
 * (if set) on every call, so tests can reconfigure between assertions.
 * Pass `null` to restore the default OpenAI-backed client.
 */
let testOverride: LLMClient | null = null;
export function setLLMClientForTesting(client: LLMClient | null): void {
  testOverride = client;
}

/**
 * Factory used by the chat route. Returns a test override (if any) so
 * integration tests can swap in a scripted mock, otherwise the real
 * OpenAI-backed client. Callers are expected to invoke this once per request
 * so per-test overrides take effect without a process restart.
 *
 * Note: `env.MOCK_LLM` is also honored for child-process integration runs that
 * cannot easily call `setLLMClientForTesting` before the server boots. When
 * the env flag is true but no test override is registered, we fall back to a
 * no-op deterministic stub so the server can still respond.
 */
export function createOpenAIClient(): LLMClient {
  if (testOverride) return testOverride;
  if (env.MOCK_LLM) return fallbackMockClient;
  return openaiClient;
}

/**
 * Tiny stub client used only when MOCK_LLM=1 and no explicit override has
 * been registered. Streams a one-shot canned response. Real integration
 * tests should always register their own via `setLLMClientForTesting`.
 */
const fallbackMockClient: LLMClient = {
  // eslint-disable-next-line require-yield
  streamTurn() {
    return (async function* () {
      yield {
        type: "text_delta",
        delta: "ok",
      } as StreamTurnEvent;
      yield {
        type: "turn_complete",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage: { inputTokens: 1, outputTokens: 1 },
      } as StreamTurnEvent;
    })();
  },
};
