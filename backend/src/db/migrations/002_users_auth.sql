-- 002_users_auth.sql
-- Users + refresh-token store. Adds the FK from conversations -> users.
-- users.deleted_at is added here (rather than in 004_soft_delete) because the
-- soft-delete contract is fundamental to the users table from day one.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'patient'
                CHECK (role IN ('patient', 'clinician', 'admin')),
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email_active
  ON users (email) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- refresh_tokens
--   Opaque refresh-token store; access tokens stay stateless JWTs. revoked_at
--   nullable so we can revoke without delete (audit replay safe).
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  jti        UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user_active
  ON refresh_tokens (user_id, expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- conversations.user_id — nullable for now; auth wiring lands later but the
-- column needs to exist so repo queries can scope from day one.
-- ---------------------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX idx_conversations_user_updated_basic
  ON conversations (user_id, updated_at DESC, id DESC);
