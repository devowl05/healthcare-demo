// Single source of chat state. Owns the optimistic-message timeline, drives
// the SSE consumer, handles history pagination + deletes.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteMessage as apiDeleteMessage,
  fetchHistory,
  streamChat,
} from "../api";
import type {
  Message,
  Part,
  ReasoningPart,
  ServerEvent,
  TextPart,
  ToolCallPart,
} from "../protocol/frames";
import type { ChatError } from "../types";

type InternalState = {
  messages: Message[];
  streaming: boolean;
  error?: ChatError;
  prevCursor?: string;
  hasMoreOlder: boolean;
  isLoadingOlder: boolean;
  conversationId?: string;
};

const initialState: InternalState = {
  messages: [],
  streaming: false,
  hasMoreOlder: false,
  isLoadingOlder: false,
};

function nowIso(): string {
  return new Date().toISOString();
}

function tempId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function genIdempotencyKey(): string {
  return tempId("idem");
}

// -------------------------------------------------------------------------
// Pure part-merge helpers — keep these out of the component for clarity and
// to make them easy to reason about.
// -------------------------------------------------------------------------

function appendText(parts: Part[], delta: string): Part[] {
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last && last.type === "text") {
      const merged: TextPart = { type: "text", text: last.text + delta };
      return [...parts.slice(0, -1), merged];
    }
  }
  const fresh: TextPart = { type: "text", text: delta };
  return [...parts, fresh];
}

function appendReasoning(parts: Part[], delta: string): Part[] {
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last && last.type === "reasoning") {
      const merged: ReasoningPart = {
        type: "reasoning",
        text: last.text + delta,
      };
      return [...parts.slice(0, -1), merged];
    }
  }
  const fresh: ReasoningPart = { type: "reasoning", text: delta };
  return [...parts, fresh];
}

function upsertToolCall(
  parts: Part[],
  next: ToolCallPart,
): Part[] {
  const idx = parts.findIndex(
    (p) => p.type === "tool_call" && p.id === next.id,
  );
  if (idx === -1) return [...parts, next];
  const existing = parts[idx] as ToolCallPart;
  const merged: ToolCallPart = {
    ...existing,
    state: next.state,
    input: next.input ?? existing.input,
    output: next.output ?? existing.output,
    name: next.name || existing.name,
  };
  const copy = parts.slice();
  copy[idx] = merged;
  return copy;
}

// -------------------------------------------------------------------------
// Hook
// -------------------------------------------------------------------------

export type UseChatReturn = {
  messages: Message[];
  streaming: boolean;
  error?: ChatError;
  conversationId?: string;
  hasMoreOlder: boolean;
  isLoadingOlder: boolean;
  send: (text: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
  loadOlder: () => Promise<void>;
  reload: () => Promise<void>;
  selectConversation: (id: string | undefined) => void;
  startNew: () => void;
  abort: () => void;
  clearError: () => void;
};

export function useChat(initialConversationId?: string): UseChatReturn {
  const [state, setState] = useState<InternalState>(() => ({
    ...initialState,
    conversationId: initialConversationId,
  }));

  const abortRef = useRef<AbortController | null>(null);
  // Track the streaming assistant placeholder so async event handlers can
  // patch the right message even after rapid re-renders.
  const streamingAssistantIdRef = useRef<string | null>(null);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: undefined }));
  }, []);

  // -------------------------------------------------------------------------
  // Reload — fetches the first page of history for the current conversation.
  // -------------------------------------------------------------------------
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, error: undefined }));
    if (!state.conversationId) {
      // Nothing to load — fresh conversation.
      setState((s) => ({
        ...s,
        messages: [],
        prevCursor: undefined,
        hasMoreOlder: false,
      }));
      return;
    }
    try {
      const page = await fetchHistory(state.conversationId);
      setState((s) => ({
        ...s,
        messages: page.messages,
        prevCursor: page.prevCursor,
        hasMoreOlder: page.hasMore,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        error: {
          code: "history_failed",
          message: err instanceof Error ? err.message : "Failed to load history",
        },
      }));
    }
  }, [state.conversationId]);

  // -------------------------------------------------------------------------
  // selectConversation — wipe local state, set the new id, and let the
  // conversationId-effect below trigger a reload. Also aborts any in-flight
  // stream so the prior conversation can't bleed into the new view.
  // -------------------------------------------------------------------------
  const selectConversation = useCallback(
    (id: string | undefined) => {
      abort();
      streamingAssistantIdRef.current = null;
      setState({
        ...initialState,
        conversationId: id,
      });
    },
    [abort],
  );

  const startNew = useCallback(() => {
    abort();
    streamingAssistantIdRef.current = null;
    setState({ ...initialState, conversationId: undefined });
  }, [abort]);

  // Auto-reload whenever conversationId changes (including the initial mount
  // if an id was provided via props). Skips when there is no id — `reload`
  // already short-circuits in that case and just clears the timeline.
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.conversationId]);

  // -------------------------------------------------------------------------
  // Load older — prepends a previous page.
  // -------------------------------------------------------------------------
  const loadOlder = useCallback(async () => {
    if (!state.conversationId || !state.hasMoreOlder || state.isLoadingOlder) {
      return;
    }
    setState((s) => ({ ...s, isLoadingOlder: true }));
    try {
      const page = await fetchHistory(state.conversationId, state.prevCursor);
      setState((s) => ({
        ...s,
        messages: [...page.messages, ...s.messages],
        prevCursor: page.prevCursor,
        hasMoreOlder: page.hasMore,
        isLoadingOlder: false,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        isLoadingOlder: false,
        error: {
          code: "history_failed",
          message: err instanceof Error ? err.message : "Failed to load older",
        },
      }));
    }
  }, [state.conversationId, state.hasMoreOlder, state.isLoadingOlder, state.prevCursor]);

  // -------------------------------------------------------------------------
  // Delete — optimistic remove; on failure, refetch.
  // -------------------------------------------------------------------------
  const deleteMessage = useCallback(
    async (id: string) => {
      const prev = state.messages;
      setState((s) => ({
        ...s,
        messages: s.messages.filter((m) => m.id !== id),
      }));
      try {
        await apiDeleteMessage(id);
      } catch (err) {
        // Rollback + surface the error.
        setState((s) => ({
          ...s,
          messages: prev,
          error: {
            code: "delete_failed",
            message:
              err instanceof Error ? err.message : "Failed to delete message",
          },
        }));
        // Best-effort resync.
        void reload();
      }
    },
    [state.messages, reload],
  );

  // -------------------------------------------------------------------------
  // Send — the meat of the hook.
  // -------------------------------------------------------------------------
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // 1. Optimistic user message.
      const userMsg: Message = {
        id: tempId("user"),
        role: "user",
        parts: [{ type: "text", text: trimmed }],
        createdAt: nowIso(),
      };
      // 2. Streaming-placeholder assistant message.
      const assistantId = tempId("asst");
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        parts: [],
        createdAt: nowIso(),
      };
      streamingAssistantIdRef.current = assistantId;

      setState((s) => ({
        ...s,
        messages: [...s.messages, userMsg, assistantMsg],
        streaming: true,
        error: undefined,
      }));

      const controller = new AbortController();
      abortRef.current = controller;

      const updateAssistant = (
        updater: (msg: Message) => Message,
      ) => {
        setState((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === streamingAssistantIdRef.current ? updater(m) : m,
          ),
        }));
      };

      try {
        const stream = streamChat({
          message: trimmed,
          conversationId: state.conversationId,
          idempotencyKey: genIdempotencyKey(),
          signal: controller.signal,
        });

        for await (const ev of stream) {
          handleEvent(ev, updateAssistant, setState, streamingAssistantIdRef);
        }
      } catch (err) {
        // Abort is a normal termination — leave whatever has streamed in place.
        if (controller.signal.aborted) {
          setState((s) => ({ ...s, streaming: false }));
        } else {
          const message =
            err instanceof Error ? err.message : "Network error";
          setState((s) => ({
            ...s,
            streaming: false,
            messages: s.messages.map((m) =>
              m.id === streamingAssistantIdRef.current
                ? {
                    ...m,
                    parts:
                      m.parts.length === 0
                        ? [{ type: "text", text: `Error: ${message}` }]
                        : m.parts,
                  }
                : m,
            ),
            error: { code: "stream_failed", message },
          }));
        }
      } finally {
        abortRef.current = null;
        streamingAssistantIdRef.current = null;
        setState((s) => (s.streaming ? { ...s, streaming: false } : s));
      }
    },
    [state.conversationId],
  );

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abort(), [abort]);

  return {
    messages: state.messages,
    streaming: state.streaming,
    error: state.error,
    conversationId: state.conversationId,
    hasMoreOlder: state.hasMoreOlder,
    isLoadingOlder: state.isLoadingOlder,
    send,
    deleteMessage,
    loadOlder,
    reload,
    selectConversation,
    startNew,
    abort,
    clearError,
  };
}

// -------------------------------------------------------------------------
// Event dispatcher — extracted so it stays out of `send` and can be reasoned
// about as a pure switch. The state writer is passed in to avoid coupling.
// -------------------------------------------------------------------------

function handleEvent(
  ev: ServerEvent,
  updateAssistant: (updater: (msg: Message) => Message) => void,
  setState: React.Dispatch<React.SetStateAction<InternalState>>,
  streamingAssistantIdRef: React.MutableRefObject<string | null>,
): void {
  switch (ev.event) {
    case "conversation":
      setState((s) => ({ ...s, conversationId: ev.data.id }));
      break;
    case "text":
      updateAssistant((m) => ({ ...m, parts: appendText(m.parts, ev.data.delta) }));
      break;
    case "reasoning":
      updateAssistant((m) => ({
        ...m,
        parts: appendReasoning(m.parts, ev.data.delta),
      }));
      break;
    case "tool_call": {
      const incoming: ToolCallPart = {
        type: "tool_call",
        id: ev.data.id,
        name: ev.data.name,
        input: ev.data.input,
        state: ev.data.state,
        output: ev.data.output,
      };
      updateAssistant((m) => ({ ...m, parts: upsertToolCall(m.parts, incoming) }));
      break;
    }
    case "done": {
      const { messageId, ...metadata } = ev.data;
      setState((s) => ({
        ...s,
        streaming: false,
        messages: s.messages.map((m) =>
          m.id === streamingAssistantIdRef.current
            ? { ...m, id: messageId, metadata }
            : m,
        ),
      }));
      streamingAssistantIdRef.current = null;
      break;
    }
    case "error": {
      const msg = ev.data.message;
      updateAssistant((m) => ({
        ...m,
        parts:
          m.parts.length === 0
            ? [{ type: "text", text: `Error: ${msg}` }]
            : m.parts,
      }));
      setState((s) => ({
        ...s,
        error: {
          code: ev.data.code,
          message: msg,
          requestId: ev.data.requestId,
          retryAfter: ev.data.retryAfter,
        },
      }));
      break;
    }
    case "replay":
      // Idempotency match — server is replaying a prior response. No-op.
      break;
  }
}
