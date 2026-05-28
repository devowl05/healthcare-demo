/**
 * Text-to-speech route.
 *
 *   POST /api/tts  { message_id, voice? }  -> audio/mpeg
 *
 * # Provenance
 * The message text is re-read from Postgres — we never trust a body-supplied
 * string. We then verify the chain message_id -> conversation -> user matches
 * `auth.sub`. On any mismatch we return 404 (rather than 403) so the API never
 * acknowledges that the id exists under someone else's account.
 *
 * # Caching
 * `tts_cache` is keyed by `(message_id, voice, model)`. On hit we serve the
 * file directly from `./tts_data/<sha>.mp3`. On miss we call OpenAI's audio
 * speech endpoint, persist the bytes to disk, then upsert the cache row. The
 * filename is `sha256(message_id|voice|model)` so collisions are impossible
 * and the on-disk layout is stable for the retention worker.
 *
 * # Mock mode
 * `env.MOCK_TTS=true` short-circuits the OpenAI call and returns a 32-byte
 * placeholder mp3 buffer. Integration tests rely on this so they don't burn
 * API credits.
 *
 * # Caps
 * Concatenated text from `message.parts` is bounded to `TTS_MAX_CHARS`. Longer
 * messages are silently truncated — the audio is a convenience, not a
 * faithful read of the entire message.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "../env.ts";
import type { AuthUser } from "../middleware/auth.ts";
import { requireAuth, requireScope } from "../middleware/auth.ts";
import { sql, withRetry } from "../db/client.ts";
import { getCachedTtsPath, putCachedTtsPath } from "../repo/tts-cache.ts";
import { childLogger } from "../obs/logger.ts";

const log = childLogger("routes/tts");

const TTS_MAX_CHARS = 2000;
const TTS_ROOT = resolve(process.cwd(), "tts_data");

const Body = z.object({
  message_id: z.string().uuid(),
  voice: z.string().min(1).max(64).optional(),
});

interface MessageProvenanceRow {
  id: string;
  parts: unknown;
  user_id: string;
}

async function lookupMessageForUser(
  messageId: string,
  userId: string,
): Promise<MessageProvenanceRow | null> {
  return withRetry(async () => {
    const rows = await sql<MessageProvenanceRow[]>`
      SELECT m.id, m.parts, c.user_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ${messageId}
         AND c.user_id = ${userId}
         AND m.deleted_at IS NULL
         AND c.deleted_at IS NULL
       LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

/**
 * Extract speakable text from the ordered `parts` JSONB array. We only voice
 * the user-visible content — reasoning and tool I/O are skipped.
 */
function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      chunks.push(p.text);
    }
  }
  return chunks.join(" ").trim();
}

function cachePath(messageId: string, voice: string, model: string): string {
  const sha = createHash("sha256")
    .update(`${messageId}|${voice}|${model}`)
    .digest("hex");
  return resolve(TTS_ROOT, `${sha}.mp3`);
}

// 32-byte mock mp3 placeholder (ID3 header + zeros). Bytes are deterministic
// so integration tests can byte-compare.
const MOCK_MP3 = Buffer.from([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (openaiClient) return openaiClient;
  openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return openaiClient;
}

async function synthesize(text: string, voice: string, model: string): Promise<Buffer> {
  if (env.MOCK_TTS) return MOCK_MP3;
  const speech = await getOpenAI().audio.speech.create({
    model,
    voice,
    input: text,
    response_format: "mp3",
  });
  const arrayBuf = await speech.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export function buildTtsRouter(): Hono {
  const router = new Hono();
  router.use("*", requireAuth(), requireScope("tts:write"));

  router.post("/", async (c) => {
    const user = c.get("user") as AuthUser;
    const json = await c.req.json().catch(() => ({}));
    const parsed = Body.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { code: "validation_failed", message: "invalid tts payload", details: parsed.error.issues },
        400,
      );
    }
    const voice = parsed.data.voice ?? env.OPENAI_TTS_VOICE;
    const model = env.OPENAI_TTS_MODEL;

    const msg = await lookupMessageForUser(parsed.data.message_id, user.id);
    if (!msg) {
      // 404 deliberately — no enumeration.
      return c.json({ code: "not_found", message: "message not found" }, 404);
    }

    const text = extractText(msg.parts).slice(0, TTS_MAX_CHARS);
    if (text.length === 0) {
      return c.json({ code: "tts_empty", message: "message has no speakable text" }, 422);
    }

    // Cache hit?
    const hit = await getCachedTtsPath(msg.id, voice, model);
    if (hit) {
      try {
        const file = Bun.file(hit.path);
        if (await file.exists()) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          return new Response(bytes, {
            status: 200,
            headers: {
              "Content-Type": "audio/mpeg",
              "Cache-Control": "private, max-age=86400",
              "X-TTS-Cache": "hit",
            },
          });
        }
      } catch (err) {
        // Disk miss with row present — fall through to regenerate.
        log.warn({ err, messageId: msg.id }, "tts cache row points at missing file");
      }
    }

    // Cache miss — synthesize.
    let buf: Buffer;
    try {
      buf = await synthesize(text, voice, model);
    } catch (err) {
      log.error({ err, messageId: msg.id }, "tts synthesis failed");
      const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
      return c.json({ code: "tts_failed", message: "synthesis failed", requestId }, 502);
    }

    const path = cachePath(msg.id, voice, model);
    try {
      await mkdir(TTS_ROOT, { recursive: true });
      await Bun.write(path, buf);
      await putCachedTtsPath(msg.id, voice, model, path, buf.byteLength);
    } catch (err) {
      // Persistence is best-effort — we still serve the bytes we just made.
      log.warn({ err, messageId: msg.id }, "tts cache write failed");
    }

    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "private, max-age=86400",
        "X-TTS-Cache": "miss",
      },
    });
  });

  return router;
}

export const ttsRouter = buildTtsRouter();
