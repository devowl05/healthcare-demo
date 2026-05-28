// Re-exports the wire protocol plus app-only state shapes.

export type {
  ToolState,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  Part,
  Metadata,
  Role,
  Message,
  ServerEvent,
  ServerEventName,
} from "./protocol/frames";

import type { Message } from "./protocol/frames";

export type Conversation = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatError = {
  code: string;
  message: string;
  requestId?: string;
  retryAfter?: number;
};

export type ChatState = {
  conversationId: string | null;
  messages: Message[];
  streaming: boolean;
  error: ChatError | null;
};
