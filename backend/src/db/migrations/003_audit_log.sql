-- 003_audit_log.sql
-- Append-only audit log with per-row SHA-256 hash chaining and a checkpoint
-- table so the nightly verifier can resume incrementally. Indexes back the
-- two common query shapes: per-user history and per-resource lookups.

CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_ip        INET,
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id      UUID,
  prev_hash       BYTEA NOT NULL,
  row_hash        BYTEA NOT NULL
);

-- Common query patterns:
--   GET /api/admin/audit?user=...   -> idx_audit_user_ts
--   "show me everything that happened to conversation X" -> idx_audit_resource
CREATE INDEX idx_audit_user_ts
  ON audit_log (actor_user_id, ts DESC);

CREATE INDEX idx_audit_resource
  ON audit_log (resource_type, resource_id);

CREATE INDEX idx_audit_ts_id
  ON audit_log (ts DESC, id DESC);

-- ---------------------------------------------------------------------------
-- audit_chain_checkpoints
--   Verifier walks the chain in batches; on success it writes a checkpoint so
--   tomorrow's run starts from `last_id + 1` instead of replaying years of rows.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_chain_checkpoints (
  id           BIGSERIAL PRIMARY KEY,
  last_id      BIGINT NOT NULL,
  last_hash    BYTEA NOT NULL,
  verified_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_chain_checkpoints_verified
  ON audit_chain_checkpoints (verified_at DESC);
