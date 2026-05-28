-- 007_export_jobs.sql
-- GDPR data-export job queue. Status FSM:
--   queued -> running -> {completed, failed}
-- file_path is populated on completed; expires_at scopes the signed URL TTL.

CREATE TABLE export_jobs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  file_path  TEXT,
  error      TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_export_jobs_user_created
  ON export_jobs (user_id, created_at DESC);

CREATE INDEX idx_export_jobs_status
  ON export_jobs (status) WHERE status IN ('queued', 'running');
