/**
 * Provider-neutral types for the agent loop.
 *
 * The whole agent runs against these shapes; only `openai-client.ts` translates
 * to/from the OpenAI SDK. Swapping providers means writing a new `LLMClient`
 * implementation and leaving everything else untouched.
 */

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type ChatRole = "system" | "user" | "assistant" | "tool";
export type ChatMessage = { role: ChatRole; content: string | ContentBlock[] };

export type ToolState = "pending" | "running" | "complete" | "failed";

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: any, signal: AbortSignal): Promise<string>;
};

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};

export type StreamTurnEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_use_complete"; id: string; name: string; input: unknown }
  | {
      type: "turn_complete";
      content: ContentBlock[];
      stopReason: "end" | "tool_use" | "length" | "error";
      usage: ProviderUsage;
    };

export type LLMClient = {
  streamTurn(args: {
    model: string;
    system: string;
    messages: ChatMessage[];
    tools: Tool[];
    signal: AbortSignal;
    reasoningEffort?: string;
    maxOutputTokens?: number;
  }): AsyncIterable<StreamTurnEvent>;
};

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
      state: ToolState;
      output?: string;
    }
  | {
      type: "done";
      messageId?: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      costUsd: number;
      latencyMs: number;
      traceId?: string;
    }
  | { type: "error"; code: string; message: string; retryAfter?: number };
