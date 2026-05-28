/**
 * TTS cache repository (the `tts_cache` table indirection).
 *
 * The actual audio bytes live on disk under /data/tts/<hash>.mp3; this table
 * records the (message_id, voice, model) -> path mapping and the byte count
 * for retention metrics. The retention worker deletes rows + files older than
 * RETENTION_DAYS_TTS_CACHE.
 */

import { sql, withRetry } from "../db/client.ts";

export interface TtsCacheRow {
  message_id: string;
  voice: string;
  model: string;
  path: string;
  bytes: number;
  created_at: string;
}

export async function getCachedTtsPath(
  messageId: string,
  voice: string,
  model: string,
): Promise<TtsCacheRow | null> {
  return withRetry(async () => {
    const rows = await sql<TtsCacheRow[]>`
      SELECT message_id, voice, model, path, bytes, created_at
      FROM tts_cache
      WHERE message_id = ${messageId}
        AND voice = ${voice}
        AND model = ${model}
      LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

/**
 * Upsert. We use ON CONFLICT so re-synthesizing the same (message,voice,model)
 * is idempotent — the on-disk file is replaced separately by the caller.
 */
export async function putCachedTtsPath(
  messageId: string,
  voice: string,
  model: string,
  path: string,
  bytes: number,
): Promise<void> {
  await withRetry(async () => {
    await sql`
      INSERT INTO tts_cache (message_id, voice, model, path, bytes)
      VALUES (${messageId}, ${voice}, ${model}, ${path}, ${bytes})
      ON CONFLICT (message_id, voice, model)
      DO UPDATE SET path = EXCLUDED.path, bytes = EXCLUDED.bytes, created_at = now()
    `;
  });
}

/**
 * Remove every cache row for a message (all voice/model combinations). Used
 * when the source message is soft-deleted so we don't keep audio for content
 * the user revoked. Returns the count of rows removed.
 */
export async function deleteCachedTts(messageId: string): Promise<number> {
  return withRetry(async () => {
    const rows = await sql<{ message_id: string }[]>`
      DELETE FROM tts_cache
      WHERE message_id = ${messageId}
      RETURNING message_id
    `;
    return rows.length;
  });
}
