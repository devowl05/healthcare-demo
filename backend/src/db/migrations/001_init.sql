-- 001_init.sql
-- Foundation tables: schema_migrations bookkeeping, conversations, messages
-- (with the ordered `parts` JSONB array), and usage_records.
--
-- Forward-only: never edit this file once applied. Subsequent schema changes
-- ship as new numbered files (002_*, 003_*, ...).

-- gen_random_uuid() lives in pgcrypto.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- schema_migrations — applied versions ledger. Inserted by the migrate runner.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- conversations
--   user_id is added in 002_users_auth.sql once the users table exists. We
--   intentionally do not create it here so the FK constraint is colocated with
--   its referent.
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cheap_mode BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- messages
--   `parts` is an ORDERED JSONB array of {type, ...} objects:
--     - {"type":"text", "text": "..."}
--     - {"type":"reasoning", "text": "..."}
--     - {"type":"tool_call", "id":"...", "name":"...", "input":..., "state":"complete|failed", "output":"..."}
--   Array order IS render order — never split across columns or tables.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  parts           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT messages_parts_is_array CHECK (jsonb_typeof(parts) = 'array')
);

CREATE INDEX idx_messages_conv_created_basic
  ON messages (conversation_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- usage_records
--   One row per assistant turn. cached_input_tokens tracked separately so we
--   can price it at the discounted rate. request_id ties back to logs and
--   Langfuse trace externalId.
-- ---------------------------------------------------------------------------
CREATE TABLE usage_records (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id           UUID REFERENCES messages(id) ON DELETE SET NULL,
  model                TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  cost_usd             NUMERIC(12, 6) NOT NULL DEFAULT 0,
  latency_ms           INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  request_id           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_records_conv_created
  ON usage_records (conversation_id, created_at DESC);

CREATE INDEX idx_usage_records_created_model
  ON usage_records (created_at DESC, model);

CREATE INDEX idx_usage_records_request_id
  ON usage_records (request_id) WHERE request_id IS NOT NULL;
