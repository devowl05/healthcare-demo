/**
 * Streaming chat route.
 *
 * `POST /api/chat` is the single entrypoint into the agent loop. It:
 *
 *   1. Validates the body via zod (`ChatBody`).
 *   2. Resolves the conversation (creating it if no id was passed), persists
 *      the user message immediately so history survives crashes.
 *   3. Runs safety/quota/budget checks; rejects early with structured codes.
 *   4. Opens an SSE stream and proxies `runAgent()` events through.
 *   5. On the `done` event, persists the assistant message and a
 *      `usage_records` row before emitting the terminal `done` frame so the
 *      client sees the canonical messageId.
 *
 * The handler never throws once the SSE stream is opened — any error that
 * surfaces mid-flight becomes an `event: error` frame and the stream closes.
 * Pre-stream errors fall through to the central error handler.
 *
 * Idempotency: `c.var.idempotencyReplay` is set by the `idempotency()`
 * middleware. When present, we emit a `replay` frame and close — the agent
 * is NOT re-invoked.
 */

import type { Context, Next } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { runAgent } from "../agent/agent.ts";
import { estimateInputTokens, wouldExceedTurnCap } from "../agent/budget.ts";
import { chooseModel } from "../agent/model-router.ts";
import { createOpenAIClient } from "../agent/openai-client.ts";
import { SYSTEM_PROMPT } from "../agent/prompt.ts";
import { crisisPrependSystemMessage, detectCrisis } from "../agent/safety-filters.ts";
import { TOOLS } from "../agent/tools.ts";
import type { AgentEvent, ChatMessage, ContentBlock } from "../agent/types.ts";
import { sql } from "../db/client.ts";
import { env } from "../env.ts";
import type { AuthUser } from "../middleware/auth.ts";
import { BudgetGuard } from "../obs/budget-guard.ts";
import { patchCtx } from "../obs/context.ts";
import { withTrace } from "../obs/langfuse.ts";
import { childLogger } from "../obs/logger.ts";
import {
  chatErrorsTotal,
  chatLatencyMs,
  chatRequestsTotal,
  chatTokensTotal,
  chatToolCallsTotal,
  chatCachedTokensTotal,
  chatCostUsdTotal,
} from "../obs/metrics.ts";
import { append as auditAppend } from "../repo/audit-log.ts";
import { conversationTokensLast24h, recordUsage } from "../repo/usage.ts";
import {
  bumpConversation,
  ensureConversation,
} from "../repo/conversations.ts";
import { getMessages, insertMessage, type MessagePart } from "../repo/messages.ts";
import { ChatBody } from "./schemas.ts";

const log = childLogger("routes/chat");

const CONVERSATION_TOKEN_CAP_PER_24H = 100_000;

/**
 * Lazy-initialized daily budget guard. The chat route is the only consumer
 * for now; if other routes need it, lift this into `obs/`. We construct on
 * first request so unit tests that never hit the route don't open a DB
 * connection just to instantiate the guard.
 */
let budgetGuard: BudgetGuard | null = null;
function getBudgetGuard(): BudgetGuard {
  if (budgetGuard) return budgetGuard;
  budgetGuard = new BudgetGuard(
    sql as unknown as ConstructorParameters<typeof BudgetGuard>[0],
    env.DAILY_BUDGET_USD,
    { refreshMs: 60_000 },
  );
  // Fire-and-forget initial refresh; failures are absorbed by the guard.
  void budgetGuard.start();
  return budgetGuard;
}

/** Test hook to replace the guard (e.g. with one whose refreshMs is 0). */
export function setBudgetGuardForTesting(guard: BudgetGuard | null): void {
  budgetGuard = guard;
}

function actorIp(c: Context): string | null {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

function getUser(c: Context): AuthUser {
  const user = c.get("user") as AuthUser | undefined;
  if (!user) throw new Error("requireAuth() did not set user");
  return user;
}

/** Build the in-memory ChatMessage history from persisted message rows.
 *
 * Persistence stores a tool call AND its result as a single `tool_call` part
 * on the assistant message (with an embedded `output` field), but OpenAI's
 * chat API needs them split: an `assistant` message carrying `tool_calls`,
 * followed immediately by a `tool` message per `tool_call_id` carrying the
 * result. We synthesize the paired `tool` message here. Old rows that used
 * the legacy `type: "tool_use"` shape are also handled (backwards compat).
 */
function historyFromRows(
  rows: Array<{ role: "user" | "assistant" | "system" | "tool"; parts: MessagePart[] }>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of rows) {
    if (r.role === "user") {
      const text = r.parts.map((p) => (p.type === "text" ? String(p.text ?? "") : "")).join("");
      out.push({ role: "user", content: text });
      continue;
    }

    if (r.role === "assistant") {
      const blocks: ContentBlock[] = [];
      const pairedResults: ContentBlock[] = [];
      for (const p of r.parts) {
        if (p.type === "text") {
          blocks.push({ type: "text", text: String(p.text ?? "") });
        } else if (p.type === "tool_call" || p.type === "tool_use") {
          // Canonical (`tool_call`) and legacy (`tool_use`) part shapes both
          // carry id / name / input + an embedded `output` string from the
          // tool execution. Split them here.
          const id = String(p.id ?? "");
          const name = String(p.name ?? "");
          const input = p.input ?? {};
          blocks.push({ type: "tool_use", id, name, input });
          // Skip results for tool calls that never completed (still pending
          // or running — shouldn't happen in persisted rows but be safe).
          const state = (p as { state?: string }).state;
          const output = (p as { output?: unknown }).output;
          if (state === "complete" || state === "failed" || output != null) {
            pairedResults.push({
              type: "tool_result",
              tool_use_id: id,
              content: output == null ? "" : String(output),
              ...(state === "failed" ? { is_error: true } : {}),
            });
          }
        }
      }
      out.push({ role: "assistant", content: blocks });
      // Emit a single `tool` role message immediately after the assistant
      // turn carrying every result. OpenAI accepts a tool message per id OR
      // a tool message with multiple `tool_result` blocks; our adapter
      // (`toOpenAIMessages`) splits the multi-block tool message into one
      // OpenAI tool message per `tool_use_id`.
      if (pairedResults.length > 0) {
        out.push({ role: "tool", content: pairedResults });
      }
      continue;
    }

    if (r.role === "tool") {
      // Legacy rows: a separate tool-role message persisted from older code.
      const blocks: ContentBlock[] = [];
      for (const p of r.parts) {
        if (p.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: String(p.tool_use_id ?? ""),
            content: String(p.content ?? ""),
            ...(p.is_error ? { is_error: true } : {}),
          });
        }
      }
      if (blocks.length > 0) out.push({ role: "tool", content: blocks });
    }
  }
  return out;
}

/**
 * Build the persisted assistant `parts` array from the live event stream so
 * the message we save matches what the client rendered.
 *
 * Order matters: the assignment requires tool calls rendered INLINE where they
 * occurred. We walk the original event list in order, coalescing contiguous
 * text deltas between tool boundaries into a single text part, and emitting
 * one `tool_call` part per unique tool id (collapsing pending → running →
 * complete/failed into a single entry with its FINAL state + output). Earlier
 * states for the same id are overwritten in place so the resulting array
 * preserves the position of the FIRST event for that id.
 *
 * Reasoning events are intentionally dropped — they remain ephemeral and are
 * not persisted to the message row.
 */
interface AssistantPart {
  type: "text" | "tool_call" | "tool_result";
  [k: string]: unknown;
}

function buildAssistantParts(events: AgentEvent[]): AssistantPart[] {
  const out: AssistantPart[] = [];
  // Map of tool id → index in `out` so we can overwrite earlier (non-terminal)
  // states in place when a later event for the same id arrives.
  const toolIndexById = new Map<string, number>();
  let pendingText = "";

  const flushText = () => {
    if (pendingText) {
      out.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };

  for (const ev of events) {
    if (ev.type === "text") {
      pendingText += ev.delta;
      continue;
    }
    if (ev.type === "tool_call") {
      const existingIdx = toolIndexById.get(ev.id);
      if (existingIdx !== undefined) {
        // Same tool id seen earlier — overwrite in place with the newer state.
        // Don't flush pending text; it belongs AFTER the original tool slot.
        out[existingIdx] = {
          type: "tool_call",
          id: ev.id,
          name: ev.name,
          input: ev.input,
          state: ev.state,
          output: ev.output ?? null,
        };
        continue;
      }
      // First time we see this tool id: close out any text run, then drop
      // the tool entry at the current position.
      flushText();
      toolIndexById.set(ev.id, out.length);
      out.push({
        type: "tool_call",
        id: ev.id,
        name: ev.name,
        input: ev.input,
        state: ev.state,
        output: ev.output ?? null,
      });
      continue;
    }
    // reasoning / done / error: not persisted as parts.
  }
  flushText();
  return out;
}

export function buildChatRouter(): Hono {
  const router = new Hono();

  router.post("/", async (c, next: Next) => handleChat(c, next));

  return router;
}

async function handleChat(c: Context, _next: Next): Promise<Response> {
  const user = getUser(c);
  const requestId = (c.get("requestId") as string) || "unknown";
  const idempotencyReplay = (c.get("idempotencyReplay") as string | null) ?? null;

  // ---------------------------------------------------------------------------
  // Parse + validate body (pre-stream — throws ZodError → 400 via error handler)
  // ---------------------------------------------------------------------------
  const rawJson = await c.req.json().catch(() => ({}));
  const body = ChatBody.parse(rawJson);

  // ---------------------------------------------------------------------------
  // Idempotency replay — short circuit BEFORE touching the DB.
  // ---------------------------------------------------------------------------
  if (idempotencyReplay) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "replay",
        data: JSON.stringify({ requestId: idempotencyReplay }),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Daily-budget guard (pre-stream — return 503 if over budget).
  // ---------------------------------------------------------------------------
  const guard = getBudgetGuard();
  if (guard.isOverBudget()) {
    chatErrorsTotal.inc({ code: "daily_budget_exceeded" });
    return c.json(
      {
        code: "daily_budget_exceeded",
        message: "daily spend cap reached; try again tomorrow",
        requestId,
      },
      503,
    );
  }

  // ---------------------------------------------------------------------------
  // Conversation + user-message persistence + per-conversation quota.
  // ---------------------------------------------------------------------------
  const conversation = await ensureConversation(user.id, body.conversationId);
  patchCtx({ conversationId: conversation.id });

  const tokens24h = await conversationTokensLast24h(conversation.id);
  if (tokens24h >= CONVERSATION_TOKEN_CAP_PER_24H) {
    chatErrorsTotal.inc({ code: "conversation_quota_exceeded" });
    return c.json(
      {
        code: "conversation_quota_exceeded",
        message: `conversation has used ${tokens24h} tokens in the last 24h (cap ${CONVERSATION_TOKEN_CAP_PER_24H})`,
        requestId,
      },
      429,
    );
  }

  // Insert the user message FIRST so history survives any subsequent failure.
  const userMessage = await insertMessage({
    conversationId: conversation.id,
    role: "user",
    parts: [{ type: "text", text: body.message }],
    requestId,
  });

  try {
    await auditAppend({
      ctx: { userId: user.id, requestId, actorIp: actorIp(c) },
      action: "chat.message_sent",
      resourceType: "message",
      resourceId: userMessage.id,
      metadata: { conversationId: conversation.id, len: body.message.length },
    });
  } catch (err) {
    // Audit failures must not stop the chat from streaming.
    log.warn({ err }, "audit_message_sent_failed");
  }

  // ---------------------------------------------------------------------------
  // Load history (chronological, last 100 messages including the just-inserted user).
  // ---------------------------------------------------------------------------
  const historyPage = await getMessages(conversation.id, undefined, 100);
  // Drop the just-inserted user message from history — runAgent() takes it as
  // a separate parameter and would otherwise double-prepend it.
  const persistedHistory = historyPage.items.filter((r) => r.id !== userMessage.id);
  const history = historyFromRows(
    persistedHistory.map((r) => ({ role: r.role, parts: r.parts })),
  );

  // ---------------------------------------------------------------------------
  // Safety filter — prepend crisis instructions when triggered.
  // ---------------------------------------------------------------------------
  const crisis = detectCrisis(body.message);
  const system = crisis.triggered
    ? `${crisisPrependSystemMessage()}\n\n${SYSTEM_PROMPT}`
    : SYSTEM_PROMPT;

  // ---------------------------------------------------------------------------
  // Pre-count tokens and reject runaway turns BEFORE opening the stream.
  // ---------------------------------------------------------------------------
  const estimated = estimateInputTokens(
    [...history, { role: "user", content: body.message }],
    body.model ?? env.OPENAI_MODEL,
  );
  if (
    wouldExceedTurnCap(
      estimated,
      env.MAX_OUTPUT_TOKENS,
      env.MAX_TURN_TOKENS,
    )
  ) {
    chatErrorsTotal.inc({ code: "turn_too_large" });
    return c.json(
      {
        code: "turn_too_large",
        message: `estimated input ${estimated} + reserved output ${env.MAX_OUTPUT_TOKENS} exceeds cap ${env.MAX_TURN_TOKENS}`,
        requestId,
      },
      413,
    );
  }

  // ---------------------------------------------------------------------------
  // Model selection.
  // ---------------------------------------------------------------------------
  const model =
    body.model ??
    chooseModel({
      cheap: body.cheap,
      conversationCheap: conversation.cheap_mode,
    });

  chatRequestsTotal.inc({ status: "started" });
  const turnStart = Date.now();

  // ---------------------------------------------------------------------------
  // Open SSE stream + drive the agent.
  // ---------------------------------------------------------------------------
  return streamSSE(c, async (stream) => {
    // First frame: tell the client which conversation they're in (the id may
    // have been minted server-side).
    await stream.writeSSE({
      event: "conversation",
      data: JSON.stringify({ id: conversation.id }),
    });

    // Ordered event log: every persistable event (text + tool_call) is appended
    // here in arrival order so `buildAssistantParts` can reconstruct the inline
    // interleave (text → tool → text → tool …) when the row is reloaded later.
    const orderedEvents: AgentEvent[] = [];
    let firstTokenAt: number | null = null;

    // AbortController wired to client disconnect so the LLM stream tears down
    // promptly when the user closes the tab.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    try {
      c.req.raw.signal.addEventListener("abort", onAbort);
    } catch {
      // some test runtimes don't expose req.raw.signal — best effort.
    }

    // LLM timeout fail-safe: if the provider never returns, abort after
    // LLM_TIMEOUT_MS. The agent loop classifies the abort into a `timeout`
    // error event for us.
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      env.LLM_TIMEOUT_MS,
    );

    try {
      await withTrace(
        {
          name: "chat.turn",
          userId: user.id,
          sessionId: conversation.id,
          input: { message: body.message, model },
          metadata: { requestId, conversationId: conversation.id },
        },
        async () => {
          const llm = createOpenAIClient();
          const gen = runAgent({
            llm,
            tools: TOOLS,
            system,
            history,
            userMessage: body.message,
            model,
            maxSteps: env.MAX_AGENT_STEPS,
            signal: controller.signal,
            reasoningEffort: env.OPENAI_REASONING_EFFORT,
            maxOutputTokens: env.MAX_OUTPUT_TOKENS,
            conversationId: conversation.id,
            userId: user.id,
          });

          for await (const ev of gen) {
            switch (ev.type) {
              case "text": {
                if (firstTokenAt === null) {
                  firstTokenAt = Date.now();
                  chatLatencyMs.observe(
                    { phase: "first_token" },
                    firstTokenAt - turnStart,
                  );
                }
                orderedEvents.push(ev);
                await stream.writeSSE({
                  event: "text",
                  data: JSON.stringify({ delta: ev.delta }),
                });
                break;
              }
              case "reasoning": {
                await stream.writeSSE({
                  event: "reasoning",
                  data: JSON.stringify({ delta: ev.delta }),
                });
                break;
              }
              case "tool_call": {
                chatToolCallsTotal.inc({ name: ev.name, state: ev.state });
                orderedEvents.push(ev);
                await stream.writeSSE({
                  event: "tool_call",
                  data: JSON.stringify({
                    id: ev.id,
                    name: ev.name,
                    input: ev.input,
                    state: ev.state,
                    output: ev.output ?? null,
                  }),
                });
                break;
              }
              case "done": {
                // Persist the assistant message + usage row BEFORE emitting
                // the terminal `done` frame so the client always sees a real
                // messageId it can reference.
                const parts = buildAssistantParts(orderedEvents);
                let assistantId: string | null = null;
                try {
                  const inserted = await insertMessage({
                    conversationId: conversation.id,
                    role: "assistant",
                    parts: parts as MessagePart[],
                    requestId,
                  });
                  assistantId = inserted.id;
                  await bumpConversation(conversation.id);
                } catch (err) {
                  log.error({ err }, "persist_assistant_failed");
                }

                try {
                  await recordUsage({
                    conversationId: conversation.id,
                    messageId: assistantId,
                    model: ev.model,
                    inputTokens: ev.inputTokens,
                    outputTokens: ev.outputTokens,
                    cachedInputTokens: ev.cachedInputTokens,
                    costUsd: ev.costUsd,
                    latencyMs: ev.latencyMs,
                    requestId,
                  });
                } catch (err) {
                  log.error({ err }, "record_usage_failed");
                }

                // Metrics counters
                chatTokensTotal.inc({ model: ev.model, direction: "input" }, ev.inputTokens);
                chatTokensTotal.inc({ model: ev.model, direction: "output" }, ev.outputTokens);
                chatCachedTokensTotal.inc({ model: ev.model }, ev.cachedInputTokens);
                chatCostUsdTotal.inc({ model: ev.model }, ev.costUsd);
                chatLatencyMs.observe({ phase: "total" }, ev.latencyMs);
                chatRequestsTotal.inc({ status: "ok" });

                if (assistantId) {
                  try {
                    await auditAppend({
                      ctx: { userId: user.id, requestId, actorIp: actorIp(c) },
                      action: "chat.message_received",
                      resourceType: "message",
                      resourceId: assistantId,
                      metadata: {
                        conversationId: conversation.id,
                        model: ev.model,
                        tokensIn: ev.inputTokens,
                        tokensOut: ev.outputTokens,
                      },
                    });
                  } catch (err) {
                    log.warn({ err }, "audit_message_received_failed");
                  }
                }

                await stream.writeSSE({
                  event: "done",
                  data: JSON.stringify({
                    messageId: assistantId,
                    model: ev.model,
                    inputTokens: ev.inputTokens,
                    outputTokens: ev.outputTokens,
                    cachedInputTokens: ev.cachedInputTokens,
                    costUsd: ev.costUsd,
                    latencyMs: ev.latencyMs,
                    traceId: ev.traceId,
                    requestId,
                  }),
                });
                break;
              }
              case "error": {
                chatErrorsTotal.inc({ code: ev.code });
                chatRequestsTotal.inc({ status: "error" });
                await stream.writeSSE({
                  event: "error",
                  data: JSON.stringify({
                    code: ev.code,
                    message: ev.message,
                    requestId,
                    ...(ev.retryAfter !== undefined ? { retryAfter: ev.retryAfter } : {}),
                  }),
                });
                break;
              }
            }
          }
        },
      );
    } catch (err) {
      // Any error that escapes the agent (shouldn't happen — `runAgent`
      // catches everything — but defense in depth).
      log.error({ err }, "chat_stream_unhandled");
      chatErrorsTotal.inc({ code: "agent_error" });
      chatRequestsTotal.inc({ status: "error" });
      try {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            code: "agent_error",
            message: err instanceof Error ? err.message : String(err),
            requestId,
          }),
        });
      } catch {
        /* stream already closed */
      }
    } finally {
      clearTimeout(timeoutHandle);
      try {
        c.req.raw.signal.removeEventListener("abort", onAbort);
      } catch {
        /* ignore */
      }
    }
  });
}

export const chatRouter = buildChatRouter();
