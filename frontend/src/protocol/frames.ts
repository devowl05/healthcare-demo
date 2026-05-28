// Shared SSE/message protocol types for the Healthcare Agent frontend.
// These are pure TypeScript discriminated unions — no runtime validation library.
// Backend frames must conform to ServerEvent; persisted messages conform to Message.

export type ToolState = "pending" | "running" | "complete" | "failed";

export type TextPart = { type: "text"; text: string };

export type ReasoningPart = { type: "reasoning"; text: string };

export type ToolCallPart = {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  state: ToolState;
  output?: string;
};

export type Part = TextPart | ReasoningPart | ToolCallPart;

export type Metadata = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd: number;
  latencyMs: number;
  traceId?: string;
  requestId: string;
};

export type Role = "user" | "assistant" | "system";

export type Message = {
  id: string;
  role: Role;
  parts: Part[];
  createdAt: string;
  metadata?: Metadata;
};

export type ServerEvent =
  | { event: "conversation"; data: { id: string } }
  | { event: "text"; data: { delta: string } }
  | { event: "reasoning"; data: { delta: string } }
  | {
      event: "tool_call";
      data: {
        id: string;
        name: string;
        input: unknown;
        state: ToolState;
        output?: string;
      };
    }
  | { event: "done"; data: { messageId: string } & Metadata }
  | {
      event: "error";
      data: {
        code: string;
        message: string;
        requestId: string;
        retryAfter?: number;
      };
    }
  | { event: "replay"; data: { requestId: string } };

export type ServerEventName = ServerEvent["event"];
