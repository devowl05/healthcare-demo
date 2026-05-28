-- 004_soft_delete.sql
-- Add soft-delete columns to conversations + messages (users got theirs in 002)
-- and create the partial indexes that drive every list query. Filtering on
-- `WHERE deleted_at IS NULL` in the index means soft-deleted rows pay zero
-- cost on the hot read path.

ALTER TABLE conversations ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE messages      ADD COLUMN deleted_at TIMESTAMPTZ;

-- Drop the unfiltered counterparts from 001/002 so the optimizer favors the
-- partial indexes. The unfiltered indexes were only useful pre-soft-delete.
DROP INDEX IF EXISTS idx_messages_conv_created_basic;
DROP INDEX IF EXISTS idx_conversations_user_updated_basic;

CREATE INDEX idx_conversations_user_updated
  ON conversations (user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_messages_conv_created
  ON messages (conversation_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Retention worker needs to find soft-deleted rows past the grace window;
-- separate index so it doesn't fight with the hot-path partials.
CREATE INDEX idx_conversations_deleted_at
  ON conversations (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_messages_deleted_at
  ON messages (deleted_at) WHERE deleted_at IS NOT NULL;
