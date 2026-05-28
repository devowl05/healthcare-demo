# Healthcare Agent

A streaming, agentic chat product for healthcare *information* — built with Bun + Hono + OpenAI + Postgres on the backend and React + Vite on the frontend.

> **Informational use only — not a substitute for professional medical advice. Call emergency services for emergencies.**

---

## Screen recording

📹 [Screen recording](TODO_RECORDING_LINK) *(placeholder — to be filled in before submission)*

---

## Quick start (one command)

```bash
cp .env.example .env
# edit .env and set OPENAI_API_KEY
docker compose up --build
```

Then visit <http://localhost:8080>.

The `migrate` Compose service runs automatically before the backend boots, so the database schema is always up to date by the time the API starts accepting traffic.

---

## What this is

A production-grade streaming agentic healthcare chat assistant.

- **SSE token streaming** for chat completions (text + reasoning + tool events on the same stream).
- **Multi-step tool use** with a 4-state lifecycle (`pending` → `running` → `complete`/`failed`) rendered inline in the message.
- **Voice in** via the Web Speech API and **voice out** via OpenAI TTS (`gpt-4o-mini-tts`), with on-disk audio cache.
- **Observability** via Langfuse (per-turn traces, per-step generations, per-tool spans) with PHI redaction at the trace boundary.
- **Audit log** — append-only with SHA-256 row-hash chaining, verified nightly.
- **GDPR delete / export** — soft-delete with 30-day grace, ZIP export with a 24-hour signed URL.
- **Cost controls** — per-request token caps, per-conversation rolling cap, global daily USD budget, prompt-caching aware, optional cheap-tier model routing.
- **Security defaults** — JWT auth with rotating refresh cookies, Redis-backed sliding-window rate limits, CSRF (double-submit), strict CORS, full security headers (CSP/HSTS/etc.), SSRF-locked tool fetches, markdown rendered with `rehype-sanitize`.

The assistant **never** presents itself as medical advice — the disclaimer is hard-coded into the system prompt and visible in the UI.

---

## Architecture

The repository is a monorepo with two deployables (`backend/`, `frontend/`) wired together by a single `docker-compose.yml`. The backend is a Hono app on Bun; the frontend is a Vite/React SPA served by nginx in production. Dependencies flow strictly from `routes/` down to `repo/` and `agent/`; the `agent/` layer is provider-neutral and only `openai-client.ts` knows OpenAI shapes.

```
HealthCare Demo/
├── docker-compose.yml
├── docker-compose.test.yml          # postgres only, used by integration tests
├── .env.example
├── README.md
├── docs/privacy.md                  # PHI handling, known limitations
├── docs/backups.md                  # backup/restore + GDPR-replay policy
├── .github/workflows/ci.yml
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.ts                 # Hono app, mounts middleware + routes
│       ├── env.ts                   # zod-validated env; fail-fast
│       ├── config.ts                # derived limits
│       ├── db/
│       │   ├── client.ts            # postgres pool
│       │   ├── migrate.ts           # forward-only migration runner
│       │   └── migrations/*.sql
│       ├── agent/                   # provider-neutral agent loop
│       │   ├── agent.ts             # runAgent() generator
│       │   ├── openai-client.ts     # OpenAI adapter
│       │   ├── tools.ts             # lookup_drug, check_symptoms
│       │   ├── thinking-splitter.ts
│       │   ├── prompt.ts
│       │   ├── pricing.ts
│       │   ├── budget.ts
│       │   └── model-router.ts
│       ├── repo/                    # DB access layer
│       ├── routes/                  # HTTP endpoints
│       ├── middleware/              # auth, cors, csrf, rate-limit, ...
│       ├── obs/                     # logger, langfuse, redact, metrics
│       ├── lib/                     # cursor, retry, crypto
│       └── jobs/                    # retention, audit verify, gdpr export
└── frontend/
    ├── Dockerfile
    ├── nginx.conf                   # SPA + /api proxy (proxy_buffering off)
    ├── vite.config.ts
    └── src/
        ├── App.tsx
        ├── api.ts                   # streamChat, fetchHistory, fetchTTS
        ├── protocol/frames.ts       # SSE zod schemas — lockstep with backend
        ├── hooks/                   # useChat, useSpeechInput, usePagination
        └── components/              # MessageView, ToolCard, ReasoningPanel, ...
```

---

## Running each part locally (no Docker)

You can run any single piece on the host; the other pieces can stay in Compose.

### Postgres (and Redis)

The simplest path is to run *just* the data services via Compose:

```bash
docker compose up -d postgres redis
```

Or with raw `docker run`:

```bash
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=app postgres:16-alpine
docker run -d -p 6379:6379 redis:7-alpine
```

### Backend

```bash
cd backend
bun install
bun run migrate    # forward-only migrations
bun run dev        # http://localhost:3000
```

The backend reads `../.env` (or `.env` in `backend/`) at startup; `env.ts` validates and fails fast if anything required is missing.

### Frontend

```bash
cd frontend
bun install
bun run dev        # http://localhost:5173
```

Vite proxies `/api/*` to `http://localhost:3000`, so the running backend doesn't need CORS config for local dev.

---

## Environment variables

The full list lives in `.env.example`. Required variables have no default — the backend refuses to boot without them.

| Name | Required / Default | Secret | Description |
|---|---|---|---|
| `NODE_ENV` | default `development` | no | One of `development`, `test`, `production`. |
| `PORT` | default `3000` | no | Backend listen port. |
| `LOG_LEVEL` | default `info` | no | `trace`/`debug`/`info`/`warn`/`error`/`fatal`. |
| `DATABASE_URL` | **required** | yes | Postgres connection string (e.g. `postgres://app:app@localhost:5432/app`). |
| `REDIS_URL` | **required** | yes | Redis connection string for rate-limit state. |
| `OPENAI_API_KEY` | **required** | yes | OpenAI API key. Legacy `OPEN_AI_API_KEY` is accepted as a fallback for backwards compatibility. |
| `JWT_SIGNING_KEY_PRIVATE` | **required** | yes | Ed25519 PEM private key for issuing JWTs. |
| `JWT_SIGNING_KEY_PUBLIC` | **required** | yes | Ed25519 PEM public key for verifying JWTs. |
| `CORS_ALLOWED_ORIGINS` | **required** | no | CSV of allowed origins (e.g. `http://localhost:5173,http://localhost:8080`). |
| `OPENAI_MODEL` | default `gpt-5.2` | no | Primary chat model. |
| `OPENAI_REASONING_EFFORT` | default `medium` | no | One of `none`/`low`/`medium`/`high`/`xhigh`. |
| `OPENAI_BUDGET_MODEL` | default `gpt-5.4-mini` | no | Used when `?cheap=1` or the conversation's `cheap_mode` is set. |
| `OPENAI_TTS_MODEL` | default `gpt-4o-mini-tts` | no | TTS model id. |
| `OPENAI_TTS_VOICE` | default `alloy` | no | Default TTS voice. |
| `MAX_OUTPUT_TOKENS` | default `2048` | no | Per-turn output cap. |
| `MAX_AGENT_STEPS` | default `5` | no | Agent-loop hard cap. |
| `MAX_TURN_TOKENS` | default `16000` | no | Budget check before calling the model. |
| `MAX_TOOL_CALLS_PER_TURN` | default `6` | no | Tool-call cap per turn. |
| `LLM_TIMEOUT_MS` | default `60000` | no | AbortController deadline for an LLM stream. |
| `DAILY_BUDGET_USD` | default `5.00` | no | Global daily USD budget; trips a refuse-to-spend guard. |
| `RETENTION_DAYS_CONVERSATIONS` | default `90` | no | Days before conversation soft-delete (since `updated_at`). |
| `RETENTION_DAYS_USAGE` | default `365` | no | Usage record retention. |
| `RETENTION_DAYS_AUDIT` | default `2555` | no | Audit-log retention (~7 years). |
| `RETENTION_DAYS_TTS_CACHE` | default `30` | no | On-disk TTS cache TTL. |
| `RETENTION_GRACE_DAYS` | default `30` | no | Soft-delete grace before hard-delete. |
| `LANGFUSE_SAMPLE_RATE` | default `1.0` | no | 0..1 sampling probability; errors are always sampled. |
| `LANGFUSE_PUBLIC_KEY` | optional | yes | If set together with the secret, traces are exported. |
| `LANGFUSE_SECRET_KEY` | optional | yes | Langfuse secret key. |
| `LANGFUSE_HOST` | optional | no | Override (default Langfuse Cloud). |
| `METRICS_ENABLED` | default `false` | no | Expose `/metrics`. |
| `METRICS_BEARER` | optional | yes | If set, `/metrics` requires this bearer token. |
| `ALLOW_REGISTRATION` | default `true` | no | Whether `POST /api/auth/register` is enabled. |
| `MOCK_TTS` | default `false` | no | Returns a deterministic mp3 fixture instead of calling OpenAI. |
| `MOCK_LLM` | default `false` | no | Swaps the OpenAI client for a deterministic stream (tests + CI). |
| `ALERT_WEBHOOK_URL` | optional | yes | Slack webhook for audit-chain alerts. |
| `EXPORT_BUCKET` | optional | no | Where GDPR export ZIPs are written (S3 URL or local path). |

---

## API behavior

All routes are JSON unless noted; mutating routes require `X-CSRF-Token`. Auth is JWT bearer (cookie-based refresh).

| Method | Path | Description |
|---|---|---|
| POST | `/api/chat` | SSE streaming chat. Body: `{ message, conversation_id?, cheap? }`. Honors `Idempotency-Key`. |
| GET | `/api/conversations` | Cursor-paginated list (most recent first). |
| GET | `/api/conversations/:id/messages` | Reverse cursor pagination (oldest scrolls in). |
| DELETE | `/api/conversations/:id` | Soft delete; cascades to messages. |
| DELETE | `/api/messages/:id` | Soft delete a single message; writes audit row. |
| POST | `/api/tts` | `{ message_id, voice }`. Backend re-reads message text from DB — never trusts the client. Returns cached mp3 or generates one. |
| POST | `/api/users/me/export` | Enqueues a GDPR export job. Returns `{ jobId }`. |
| GET | `/api/users/me/export/:jobId` | Status + 24h signed URL when ready. |
| DELETE | `/api/users/me` | Soft delete user + cascade; hard delete after grace via the retention worker. |
| POST | `/api/auth/register` | Email + password (argon2id). Gated by `ALLOW_REGISTRATION`. |
| POST | `/api/auth/login` | Issues JWT + refresh cookie. |
| POST | `/api/auth/refresh` | Rotates refresh cookie; issues a new JWT. |
| POST | `/api/auth/logout` | Revokes the refresh cookie. |
| GET | `/api/admin/audit` | Admin-only paginated audit log. |
| GET | `/health` | Liveness. Always 200 unless the process is dying. |
| GET | `/ready` | Readiness — `SELECT 1` + 30s-cached OpenAI `models.list` ping. |
| GET | `/metrics` | Prometheus exposition; gated by `METRICS_ENABLED` and (optionally) `METRICS_BEARER`. |

Errors are returned as `{ code, message, requestId, retryAfter? }`.

---

## Streaming behavior

`POST /api/chat` returns a `text/event-stream` response. Both backend (`backend/src/routes/chat.ts`) and frontend (`frontend/src/api.ts`, `frontend/src/hooks/useChat.ts`, `frontend/src/protocol/frames.ts`) are kept in lockstep; a contract test (`backend/tests/contract/`) diffs the zod schemas to fail on drift.

### SSE frame catalog

| Event | Payload |
|---|---|
| `conversation` | `{ id }` — sent once when the conversation id is known. |
| `text` | `{ delta }` — incremental assistant text. |
| `reasoning` | `{ delta }` — incremental `<thinking>` content, routed to the reasoning channel. |
| `tool_call` | `{ id, name, input, state, output? }` — `state` is one of `pending`, `running`, `complete`, `failed`. |
| `done` | `{ messageId, model, inputTokens, outputTokens, cachedInputTokens, costUsd, latencyMs, traceId, requestId }`. |
| `error` | `{ code, message, requestId, retryAfter? }` — terminal; the stream is closed cleanly after this frame. |
| `replay` | `{ requestId }` — emitted by the idempotency middleware on a duplicate `Idempotency-Key`. |

Notes:
- The stream is never silently closed — errors are always announced via an `error` frame.
- `messages.parts` is an ordered JSONB array; the array order *is* the render order on the frontend.
- nginx must have `proxy_buffering off` for `/api/chat` (set in `frontend/nginx.conf`).

---

## Database migrations

Forward-only. Migrations are plain `.sql` files in `backend/src/db/migrations/`, applied in lexicographic order via `bun run src/db/migrate.ts` (or the `migrate` Compose service, which runs the same script).

- **Never edit an applied migration.** Add a new one.
- Each file runs in its own transaction; success is recorded in `schema_migrations(version, applied_at)`.
- The runner is shared by integration tests (`docker-compose.test.yml`) and the Compose stack.

```bash
cd backend
bun run migrate
```

---

## Testing

The test pyramid is runnable via Bun's built-in test runner plus a Postgres-only Compose file for integration.

```bash
# Unit + contract (no DB)
cd backend && bun test

# Integration (real Postgres on :55432 via docker-compose.test.yml)
docker compose -f docker-compose.test.yml up -d
INTEGRATION=1 bun test tests/integration

# Frontend typecheck + build
cd frontend && bun run build

# E2E (Playwright; needs the full stack up)
docker compose up -d
cd frontend && bun run e2e

# Load (k6 + MOCK_LLM=1)
k6 run backend/tests/load/chat.k6.js
```

Coverage gates: `lines >= 80`, `branches >= 70` on `agent/`, `repo/`, `routes/`.

---

## Library choices and tradeoffs

- **Bun** over Node — built-in TS, built-in test runner, fast cold start, single binary in the Docker image.
- **Hono** over Express/Fastify — first-class SSE response support and end-to-end types from request schemas to handlers.
- **OpenAI GPT-5.2** primary (`reasoning_effort=medium`) + **GPT-5.4-mini** budget tier — the best cost/quality balance for this workload, and both are prompt-caching friendly so the system prompt + tool schemas amortize across turns.
- **Raw SQL migrations + the `postgres` driver** over Prisma/Drizzle — transparent, easy to review under HIPAA-adjacent constraints, no migration-tool magic.
- **Langfuse Cloud** for tracing — self-hosting requires ClickHouse + MinIO + Redis + Postgres, which is too heavy for one Compose file. Self-host swap is an env-var change.
- **Redis** for rate-limit — correctness with multi-replica deploys; in-memory limiters silently double quotas under load.
- **Web Speech API** for voice in — zero dependencies. Chrome/Edge only; this is documented as a known limitation.
- **`gpt-4o-mini-tts`** for voice out — currently the cheapest TTS model we have access to. Swappable via `OPENAI_TTS_MODEL`.
- **`react-markdown` + `rehype-sanitize`** — XSS-safe markdown rendering; strips `<script>`, event handlers, and dangerous URI schemes by default.

---

## Known limitations

- **Voice input is Chrome/Edge only** — Web Speech API is not yet supported in Firefox or Safari. The mic button hides itself when the API is missing.
- **No NER in PII/PHI redaction** — names, addresses, and other free-form identifiers slip through the regex-based redactor. Documented in `docs/privacy.md`.
- **No HIPAA compliance claim** — the product implements HIPAA-adjacent safeguards (audit log, retention, access control, redaction) but no BAAs are in place with OpenAI, Langfuse, or any TTS provider. See `docs/privacy.md`.
- **Audio autoplay may be blocked** — browsers block audio playback before the first user gesture. Clicking the voice toggle unblocks it.
- **Streaming TTS is not implemented** — the full audio clip is generated then played. There is an audible delay before playback starts on long messages.

---

## Security and compliance

See `docs/privacy.md` for PHI/PII handling and `docs/backups.md` for backup and GDPR-replay policy.

What's implemented today:

- **AuthN/AuthZ** — Ed25519-signed JWTs (15 min) + rotating refresh cookies (30 day, `httpOnly; Secure; SameSite=Strict`); conversation-scoped queries; CSRF double-submit.
- **Audit log with hash chain** — append-only `audit_log` with per-row SHA-256 chaining, advisory-lock-serialized writes, nightly verifier with Slack alert on mismatch.
- **Retention + GDPR delete/export** — soft-delete with 30-day grace, hard-delete by a dedicated `retention-worker`; 24h signed-URL ZIP exports.
- **PHI redaction** — 3-layer (logs aggressive, Langfuse aggressive, OpenAI minimal credentials-only); 6 regex patterns covering SSN/phone/email/DOB/MRN/Luhn-checked CCs.
- **Rate limits** — Redis sliding-window, per-IP **and** per-user; mid-stream trip emits a clean `error` frame.
- **Network hardening** — strict CORS allowlist, full security headers (HSTS/CSP/XFO/Referrer-Policy/Permissions-Policy), SSRF-locked outbound (hardcoded host, no redirects, capped response).

---

## CI

GitHub Actions runs five jobs on every push (`.github/workflows/ci.yml`):

1. **backend-test** — `bun install --frozen-lockfile`, `bun test` (unit + contract), coverage gate.
2. **backend-integration** — Postgres service container, `INTEGRATION=1 bun test tests/integration`.
3. **frontend-build** — `bun run build`, Playwright against the built bundle with mocked API.
4. **docker-stack** — `docker compose build && up -d`, polls `/ready` until 200 (90s timeout), smoke-curls the API, tears the stack down.
5. **security** — `bun audit` + `trivy image` scan on the built backend image; fails on `HIGH+`.

`renovate.json` runs weekly with grouped PRs and auto-merge for devDeps patch/minor.

---

## Submission checklist

- [x] Backend in TypeScript on Bun.
- [x] Frontend in React.
- [x] `docker compose up --build` boots the entire stack with one command.
- [x] All three parts (backend, frontend, database) work together end-to-end.
- [x] `.env.example` present with placeholders for every required variable.
- [ ] Screen recording linked at the top of this README (placeholder until filled in).

---

## Acceptance checklist

Walk-through of every assignment requirement against the code that satisfies it. Legend: ✓ done · ⚠ partial / documented limitation · ✗ missing.

| Requirement | Status | Where |
|---|---|---|
| Backend in TypeScript on Bun | ✓ | `backend/package.json`, `backend/src/index.ts` (Hono on Bun.serve) |
| Frontend in React | ✓ | `frontend/package.json`, `frontend/src/App.tsx`, `frontend/src/main.tsx` |
| Backend starts standalone | ✓ | `cd backend && bun run dev` — `backend/src/index.ts` |
| Frontend starts standalone | ✓ | `cd frontend && bun run dev` — `frontend/vite.config.ts` |
| `docker compose up` brings up full stack (one command) | ✓ | `docker-compose.yml` (postgres → migrate → backend → frontend) |
| Chat messages send | ✓ | `frontend/src/hooks/useChat.ts`, `frontend/src/api.ts#streamChat`, `backend/src/routes/chat.ts` |
| Streaming responses (token-by-token SSE) | ✓ | `backend/src/routes/chat.ts` (SSE writer), `frontend/src/hooks/useChat.ts` (reader) |
| Tool calls visible inline | ✓ | `frontend/src/components/ToolCard.tsx` (4 states: pending/running/complete/failed) |
| Agent continues after tool results | ✓ | `backend/src/agent/agent.ts#runAgent` generator loop, capped by `MAX_AGENT_STEPS` |
| Conversation persistence | ✓ | `backend/src/db/migrations/*.sql`, `backend/src/repo/conversations.ts`, `backend/src/repo/messages.ts` |
| Usage metadata (tokens, cost, latency) | ✓ | `backend/src/repo/usage.ts`, `backend/src/agent/pricing.ts`, surfaced via `done` SSE frame & `MessageMeta.tsx` |
| Markdown rendering | ✓ | `frontend/src/components/MessageView.tsx` (`react-markdown` + `remark-gfm` + `rehype-sanitize` + `rehype-highlight`) |
| Reasoning panel (collapsible, live) | ✓ | `frontend/src/components/ReasoningPanel.tsx`, `backend/src/agent/thinking-splitter.ts` |
| Per-message delete works | ✓ | `frontend/src/components/MessageView.tsx` trash button → `DELETE /api/messages/:id` (`backend/src/routes/messages.ts`) |
| Loading indicator before first token | ✓ | `frontend/src/components/MessageView.tsx` `typing-dots` while `parts.length === 0` |
| Load conversation history on page load | ✓ | `frontend/src/hooks/useChat.ts#reload`, `GET /api/conversations/:id/messages` |
| Microphone input | ✓ | `frontend/src/hooks/useSpeechInput.ts` (Web Speech API) + `ChatInput.tsx` mic button |
| Voice auto-submit on silence | ✓ | `frontend/src/hooks/useSpeechInput.ts` silence-timer → `onAutoSubmit` in `App.tsx` |
| TTS playback toggle | ✓ | `App.tsx` voice switch + `AudioControls.tsx`, `POST /api/tts` (`backend/src/routes/tts.ts`) |
| Auto-play latest assistant audio | ✓ | `AudioControls.tsx` effect (per-id `autoPlayedRef` guard) |
| Older messages → manual play/pause/seek/volume | ✓ | `AudioControls.tsx` full control row for non-latest messages |
| TTS failure handled silently | ✓ | `AudioControls.tsx` swallows errors with `console.warn`; chat keeps working |
| Mic permission error UX | ✓ | `ChatInput.tsx#micErrorMessage` renders inline status under composer |
| Graceful AI failure / timeout | ✓ | `backend/src/agent/agent.ts` AbortController + `LLM_TIMEOUT_MS`; clean `error` SSE frame |
| Structured error responses | ✓ | `backend/src/middleware/errors.ts` returns `{code, message, requestId, retryAfter?}` |
| Input validation | ✓ | `backend/src/routes/chat.ts` zod request schema; rejects on parse failure |
| Migrations before backend accepts traffic | ✓ | `docker-compose.yml` `migrate` service + `backend` `depends_on: migrate (service_completed_successfully)` |
| Minimal production Dockerfile, non-root | ✓ | `backend/Dockerfile` (multi-stage, runs as `bun` user) |
| `.env.example` documents every variable | ✓ | `.env.example` (parity-checked against `backend/src/env.ts`) |
| README explains setup + tradeoffs | ✓ | This file: "Quick start", "Running each part locally", "Library choices and tradeoffs" |
| Screen recording link | ⚠ | Placeholder at top of README — to be filled in pre-submission |
| CI workflow (bonus) | ✓ | `.github/workflows/ci.yml` (backend-test, integration, frontend-build, docker-stack, security) |

**Summary:** 31 ✓ · 1 ⚠ · 0 ✗
