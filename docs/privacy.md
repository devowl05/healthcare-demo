# Privacy and PHI/PII handling

## Scope note

This product surfaces *general health information only*. It is **NOT** a HIPAA Covered Entity service and we do **NOT** claim HIPAA compliance — no BAA is in place with OpenAI, Langfuse, or any TTS provider. What follows is a set of **HIPAA-adjacent safeguards**: defense-in-depth controls that make the product safe by default and let us flip into HIPAA scope (sub-processor BAAs, encrypted-at-rest PHI columns, audit log already running) without re-architecting. Every control below is implemented even though we do not advertise compliance.

If you intend to deploy this product in a setting that handles real Protected Health Information, you must:

1. Sign BAAs with every sub-processor listed below (or replace them).
2. Upgrade the storage encryption posture from disk-level to column-level (see [Storage encryption](#storage-encryption)).
3. Repeat a privacy-and-security review against your jurisdiction's requirements.

---

## Data we collect

The product persists or transiently processes the following user-derived data:

- **Chat messages.** Stored in `messages.parts` (JSONB ordered array) under the user's conversation, indexed by `conversation_id`. Retained per the retention policy.
- **Conversation metadata.** Title (derived), `cheap_mode` flag, timestamps.
- **Audio transcripts.** Voice input is transcribed in the browser via the Web Speech API. Transcripts are sent to the backend as ordinary text and stored exactly like typed messages. The raw audio never leaves the user's device.
- **Audio outputs.** TTS responses are cached on disk (under `/data/tts/<sha256>.mp3`) with a `tts_cache` indirection table; cache TTL is `RETENTION_DAYS_TTS_CACHE` (default 30 days).
- **Usage metadata.** Per-message rows in `usage_records`: model, token counts (input, output, cached), cost USD, latency, request id.
- **Audit log.** Access events (login, conversation read/create/delete, GDPR actions, admin actions, rate-limit trips, safety prepends). **Never message bodies.**

---

## Sub-processors

| Provider | Purpose | Data sent |
|---|---|---|
| **OpenAI** | Chat completions (`gpt-5.2` primary, `gpt-5.4-mini` budget) and TTS (`gpt-4o-mini-tts`). | Raw chat content for completions; message text re-read from DB for TTS. Layer C redaction strips obvious credentials only. |
| **Langfuse** | Observability — traces, generations, tool spans. Optional; disabled if `LANGFUSE_PUBLIC_KEY` is unset. | Redacted message content (Layer B); `user_id`, `conversation_id`, model, tokens, cost, latency. |
| **Redis** | Rate-limit counters and idempotency state. | Hashed identifiers + counters. No message content. |
| **Postgres** | Primary storage. | All of the above. |

Self-hosting Langfuse or running with telemetry off is an env-var change and requires no code modification.

---

## PII / PHI redaction layers

PHI redaction is **three layers with different aggressiveness per layer**. The model needs raw context to be clinically useful; logs and traces never do.

### Layer A — before app logs (aggressive)

Implemented in `backend/src/obs/redact.ts#redactForLogs(s)`. Wired in via the Pino serializer so every log line is filtered. Matches are replaced with `[REDACTED:KIND]` (e.g. `[REDACTED:SSN]`, `[REDACTED:EMAIL]`).

Redact paths on the Pino serializer:

- `req.headers.authorization`, `req.headers.cookie`
- `*.OPENAI_API_KEY`, `*.LANGFUSE_SECRET_KEY`
- `user.email`, `body.message`

The chat body whitelist for logs is `{ conversation_id, model, cheap }` only — message text is never logged.

### Layer B — before Langfuse (aggressive)

Same regex set as Layer A, invoked from `backend/src/obs/langfuse.ts#beforeSend`. Stable correlatable IDs are produced via HMAC so the same redacted value yields the same opaque token across spans without leaking the underlying string.

### Layer C — before OpenAI (minimal)

We deliberately do **not** redact message bodies before sending them to OpenAI — that would break the utility of the assistant. We only strip obvious credentials from outbound payloads: literal `sk-...` API-key shapes, `Bearer <token>` headers, and AWS access keys. This trade-off is documented here intentionally.

---

## Regex catalog

The patterns in `backend/src/obs/redact-patterns.ts` cover six families:

| Kind | Example | Notes |
|---|---|---|
| SSN | `123-45-6789` | US format only. |
| US phone | `(415) 555-0100`, `+1 415-555-0100` | E.164 and common US shapes. |
| Email | `user@example.com` | RFC-5322-lite — covers practical cases, not full grammar. |
| DOB | `04/12/1985`, `1985-04-12` | US shorthand + ISO. |
| MRN-shaped | `MRN: 123456`, `MRN 1234567890` | Explicit `MRN` prefix; bare adjacency-based digit runs flagged where neighbor tokens look medical. |
| Credit card | Luhn-checked | Random 16-digit strings that pass Luhn are flagged. |

### Limitations called out

- **No NER.** Names, addresses, and indirect identifiers are not detected. A user typing *"my name is Jane Doe and I live at 123 Main St"* will have those fields persisted and forwarded to OpenAI/Langfuse without redaction.
- **No phonetic or fuzzy match.** Misspelled identifiers and OCR-style variants are not caught.
- **No language model post-filter.** We do not run a secondary model to scrub PHI from outputs before persistence.

These limitations are the primary reason this product does not claim HIPAA compliance.

---

## Storage encryption

**Disk-level only.** Postgres runs on an encrypted volume in production (the runbook for setting this up is in `docs/backups.md`). We deliberately did not implement column-level `pgcrypto` because:

1. It breaks index/search on the encrypted columns.
2. Keys-in-env without a KMS is weak crypto theater — it only delays an attacker who has filesystem access.

**Upgrade path** (executed when a BAA is signed):

1. Provision a KMS (AWS KMS, GCP KMS, or HashiCorp Vault Transit).
2. Add per-column envelope encryption to `messages.parts` and `messages.parts_text_search` — a Data Encryption Key wrapped by a Key Encryption Key in KMS.
3. Migrate existing rows with a zero-downtime backfill job (read → encrypt → write to a shadow column → swap).
4. Add a quarterly DEK rotation procedure.

The schema is already shaped for this — `messages.parts` is a JSONB column, not a multi-column shred.

---

## Retention

Retention is enforced by `backend/src/jobs/retention.ts`, scheduled in the `retention-worker` Compose service. Two-phase: mark `deleted_at` after the retention window, hard-delete after the grace window.

| Data | Window | Source of truth |
|---|---|---|
| Conversations | 90 days since `updated_at` | `RETENTION_DAYS_CONVERSATIONS` |
| Usage records | 365 days | `RETENTION_DAYS_USAGE` |
| Audit log | 7 years (2555 days) | `RETENTION_DAYS_AUDIT` |
| TTS cache | 30 days | `RETENTION_DAYS_TTS_CACHE` |
| Soft-delete grace | 30 days | `RETENTION_GRACE_DAYS` |

Audit log cleanup **never truncates mid-chain** — only prefix-deletes up to a verified checkpoint, archiving the checkpoint hash to `AUDIT_ARCHIVE_BUCKET` so chain continuity is recoverable.

All reads (`repo/*` helpers) filter `WHERE deleted_at IS NULL`, so soft-deleted rows are invisible to the API immediately on delete.

---

## GDPR / right-to-be-forgotten

### Export — `POST /api/users/me/export`

Enqueues an `export_jobs` row. The worker (`backend/src/jobs/gdpr-export.ts`) writes a ZIP containing:

- `conversations.json`
- `messages.json`
- `usage.json`
- `audit_log.json` (rows where the user is the actor)

The ZIP is uploaded to `EXPORT_BUCKET` (S3 or a local path). `GET /api/users/me/export/:jobId` returns status and, when ready, a **24-hour signed URL** to download it. Both `gdpr.export_requested` and `gdpr.export_completed` are written to the audit log.

### Delete — `DELETE /api/users/me`

Sets `users.deleted_at`, cascades soft-delete to conversations and messages, calls `langfuse.deleteUser(userId)` to remove traces from the observability tier, and removes `tts_cache` rows for that user. Hard delete happens after the grace window via the retention worker. Audit entries are written as `gdpr.delete_requested` (actor = user) followed by `gdpr.delete_completed` (system actor).

### Conversation delete — `DELETE /api/conversations/:id`

Immediate soft-delete + immediate access revocation. Hard delete on retention.

### Restore-from-backup replay

Backups are taken without the deletion log. After any restore, the operator must run `bun run src/jobs/replay-deletions.ts` to re-apply pending GDPR deletes recorded since the snapshot. The job is a stub in this implementation — see `docs/backups.md`.

---

## Known gaps

- **No NER** — names and addresses are not redacted. Documented above; primary reason for the no-HIPAA-claim posture.
- **No streaming TTS** — full audio clip is generated before playback. Mild UX impact, no privacy impact.
- **No BAAs by default** — sub-processors are commercial accounts without a Business Associate Agreement.
- **No per-column encryption** — disk-level only. Upgrade path documented above.
- **Audit chain verifier alerts to Slack only** — there's no automated re-mediation or read-only failover when a chain mismatch is detected.

---

## Reporting concerns

If you discover a vulnerability or privacy issue, please email **security@example-health.com** (placeholder). We will acknowledge within two business days.
