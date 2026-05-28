-- 006_tts_cache.sql
-- On-disk TTS cache indirection. Audio bytes live under /data/tts/<hash>.mp3;
-- this table is the (message_id, voice, model) -> path mapping with a 30-day
-- TTL enforced by the retention worker.

CREATE TABLE tts_cache (
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  voice       TEXT NOT NULL,
  model       TEXT NOT NULL,
  path        TEXT NOT NULL,
  bytes       INTEGER NOT NULL CHECK (bytes >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, voice, model)
);

CREATE INDEX idx_tts_cache_created_at
  ON tts_cache (created_at);
