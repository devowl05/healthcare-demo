/**
 * Usage records repository.
 *
 * One row per assistant turn. The 24-hour aggregate drives the per-conversation
 * soft cap surfaced in the UI. We use a partial day range scan against the
 * (conversation_id, created_at DESC) index added in 001_init.sql.
 */

import { sql, withRetry } from "../db/client.ts";

export interface RecordUsageInput {
  conversationId: string;
  messageId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  latencyMs: number;
  requestId: string;
}

export interface UsageRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: string;
  latency_ms: number;
  request_id: string | null;
  created_at: string;
}

export async function recordUsage(input: RecordUsageInput): Promise<void> {
  await withRetry(async () => {
    await sql`
      INSERT INTO usage_records (
        conversation_id, message_id, model,
        input_tokens, output_tokens, cached_input_tokens,
        cost_usd, latency_ms, request_id
      ) VALUES (
        ${input.conversationId},
        ${input.messageId},
        ${input.model},
        ${input.inputTokens},
        ${input.outputTokens},
        ${input.cachedInputTokens},
        ${input.costUsd},
        ${input.latencyMs},
        ${input.requestId}
      )
    `;
  });
}

/**
 * Sum of (input + output) tokens for a conversation in the last 24 hours.
 * NUMERIC/BIGINT may come back as a string from postgres-js; we coerce to
 * Number once. For >2^53 token totals (we'd be very rich), this still rounds
 * but that's far outside the operating range.
 */
export async function conversationTokensLast24h(
  conversationId: string,
): Promise<number> {
  const rows = await withRetry(async () => {
    return sql<{ total: string | number | null }[]>`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total
      FROM usage_records
      WHERE conversation_id = ${conversationId}
        AND created_at >= now() - interval '24 hours'
    `;
  });
  const total = rows[0]?.total;
  if (total === null || total === undefined) return 0;
  return typeof total === "number" ? total : Number(total);
}

/**
 * Per-message usage metadata used by the streaming `done` frame. Returns
 * null if no usage row exists yet (the chat route emits usage in two phases:
 * insert first, then update with token counts, so this can briefly return null).
 */
export async function getMessageMetadata(
  messageId: string,
): Promise<UsageRow | null> {
  const rows = await withRetry(async () => {
    return sql<UsageRow[]>`
      SELECT id, conversation_id, message_id, model,
             input_tokens, output_tokens, cached_input_tokens,
             cost_usd, latency_ms, request_id, created_at
      FROM usage_records
      WHERE message_id = ${messageId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
  });
  return rows[0] ?? null;
}
