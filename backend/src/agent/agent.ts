/**
 * `runAgent()` — the provider-neutral agent loop.
 *
 * One call to `runAgent()` drives ONE user turn (the user submits, the model
 * answers, possibly after one or more tool calls). The function is an
 * `AsyncGenerator<AgentEvent>` so the HTTP route can stream events to the
 * client without buffering — what the route sees IS what the user sees.
 *
 * Loop shape (also described in `prompt.md`):
 *
 *   for step in 0..maxSteps:
 *     stream a model turn → relay text/reasoning, accumulate tool_use blocks
 *     if stop_reason != tool_use: break
 *     for each tool_use:
 *       - check allowlist; unknown → emit failed(unknown_tool)
 *       - emit pending → running
 *       - execute under abort signal, catch errors
 *       - sanitize output, emit complete or failed
 *       - append tool_result to next-step input
 *   emit `done`
 *
 * Error mapping (the generator NEVER throws outward):
 *   - AbortError after some token has been emitted → code "stream_interrupted"
 *   - AbortError with no tokens emitted            → code "timeout"
 *   - BreakerOpenError                              → code "upstream_unavailable"
 *   - Provider 4xx (status 400-499 minus 408/429)  → code "provider_input_error"
 *   - anything else                                 → code "agent_error"
 */

import { BreakerOpenError } from "../obs/breaker.ts";
import { childLogger } from "../obs/logger.ts";
import { estimateCostUsd } from "./pricing.ts";
import { sanitizeToolOutput } from "./tool-sanitize.ts";
import { TOOL_REGISTRY } from "./tools.ts";
import type {
  AgentEvent,
  ChatMessage,
  ContentBlock,
  LLMClient,
  Tool,
  ToolUseBlock,
} from "./types.ts";

const log = childLogger("agent");

const DEFAULT_MAX_STEPS = 5;

export interface RunAgentArgs {
  llm: LLMClient;
  tools: Tool[];
  system: string;
  history: ChatMessage[];
  userMessage: string;
  model: string;
  maxSteps?: number;
  signal?: AbortSignal;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  conversationId?: string;
  userId?: string;
}

function classifyError(err: unknown, anyTokenSent: boolean): {
  code: string;
  message: string;
  retryAfter?: number;
} {
  if (err instanceof BreakerOpenError) {
    return {
      code: "upstream_unavailable",
      message: err.message,
      retryAfter: Math.max(0, err.retryAt - Date.now()),
    };
  }
  if (err && typeof err === "object") {
    const e = err as { name?: string; status?: number; message?: string };
    if (e.name === "AbortError" || e.name === "APIUserAbortError") {
      return {
        code: anyTokenSent ? "stream_interrupted" : "timeout",
        message: e.message ?? "aborted",
      };
    }
    if (typeof e.status === "number" && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
      return { code: "provider_input_error", message: e.message ?? `provider ${e.status}` };
    }
  }
  return {
    code: "agent_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Compose the messages array sent on a given step. We always include the
 * caller's `history`, then the user's new message (only on step 0), then any
 * assistant + tool_result pairs accumulated mid-loop.
 */
function buildMessages(
  history: ChatMessage[],
  userMessage: string,
  midLoop: ChatMessage[],
): ChatMessage[] {
  return [
    ...history,
    { role: "user", content: userMessage },
    ...midLoop,
  ];
}

export async function* runAgent(args: RunAgentArgs): AsyncGenerator<AgentEvent> {
  const start = Date.now();
  const signal = args.signal ?? new AbortController().signal;
  const maxSteps = Math.max(1, args.maxSteps ?? DEFAULT_MAX_STEPS);

  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;
  let anyTokenSent = false;
  const midLoop: ChatMessage[] = [];

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }

      const messages = buildMessages(args.history, args.userMessage, midLoop);
      const stream = args.llm.streamTurn({
        model: args.model,
        system: args.system,
        messages,
        tools: args.tools,
        signal,
        reasoningEffort: args.reasoningEffort,
        maxOutputTokens: args.maxOutputTokens,
      });

      const pendingTools: ToolUseBlock[] = [];
      let assistantContent: ContentBlock[] = [];
      let stopReason: "end" | "tool_use" | "length" | "error" = "end";

      for await (const ev of stream) {
        if (ev.type === "text_delta") {
          anyTokenSent = true;
          yield { type: "text", delta: ev.delta };
        } else if (ev.type === "reasoning_delta") {
          anyTokenSent = true;
          yield { type: "reasoning", delta: ev.delta };
        } else if (ev.type === "tool_use_complete") {
          const block: ToolUseBlock = {
            type: "tool_use",
            id: ev.id,
            name: ev.name,
            input: ev.input,
          };
          pendingTools.push(block);
          yield {
            type: "tool_call",
            id: ev.id,
            name: ev.name,
            input: ev.input,
            state: "pending",
          };
        } else if (ev.type === "turn_complete") {
          assistantContent = ev.content;
          stopReason = ev.stopReason;
          totalIn += ev.usage.inputTokens || 0;
          totalOut += ev.usage.outputTokens || 0;
          totalCached += ev.usage.cachedInputTokens || 0;
        }
      }

      // Persist this turn's assistant message for the next iteration's input.
      if (assistantContent.length > 0) {
        midLoop.push({ role: "assistant", content: assistantContent });
      }

      if (stopReason !== "tool_use" || pendingTools.length === 0) {
        break;
      }

      // Execute tool calls sequentially. Determinism > parallelism for the demo.
      const toolResults: ContentBlock[] = [];
      for (const call of pendingTools) {
        const tool = TOOL_REGISTRY[call.name];
        if (!tool) {
          const msg = `unknown tool: ${call.name}`;
          yield {
            type: "tool_call",
            id: call.id,
            name: call.name,
            input: call.input,
            state: "failed",
            output: msg,
          };
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: msg,
            is_error: true,
          });
          continue;
        }

        yield {
          type: "tool_call",
          id: call.id,
          name: call.name,
          input: call.input,
          state: "running",
        };

        let raw: string;
        let isError = false;
        try {
          raw = await tool.execute(call.input, signal);
          if (typeof raw !== "string") raw = String(raw);
        } catch (err) {
          isError = true;
          raw = err instanceof Error ? err.message : String(err);
        }

        const cleaned = sanitizeToolOutput(raw);

        yield {
          type: "tool_call",
          id: call.id,
          name: call.name,
          input: call.input,
          state: isError ? "failed" : "complete",
          output: cleaned,
        };

        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: cleaned,
          ...(isError ? { is_error: true } : {}),
        });
      }

      midLoop.push({ role: "tool", content: toolResults });
    }

    const costUsd = estimateCostUsd(args.model, totalIn, totalOut, totalCached);
    yield {
      type: "done",
      model: args.model,
      inputTokens: totalIn,
      outputTokens: totalOut,
      cachedInputTokens: totalCached,
      costUsd,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const { code, message, retryAfter } = classifyError(err, anyTokenSent);
    log.debug({ err, code }, "agent error");
    yield {
      type: "error",
      code,
      message,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }
}
