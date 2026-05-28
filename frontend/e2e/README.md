# Frontend End-to-End Tests (Playwright)

Mock-driven browser tests for the chat / voice / TTS flows. The dev server is
started automatically by Playwright via `webServer` in `playwright.config.ts`;
the backend is **never** required because every `/api/*` route is intercepted
with `page.route()`.

## Setup

Run once per machine:

```sh
cd frontend
bun add -d @playwright/test                # already in package.json
bunx playwright install chromium           # downloads the headless browser
```

If Chromium installation is blocked by your sandbox or firewall, set
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and reuse a system browser; the config
defaults to chromium but Playwright can be re-pointed via `channel: "chrome"`.

## Running

```sh
# All specs in chromium (default).
cd frontend
bunx playwright test

# Single spec, headed (helpful while debugging).
bunx playwright test e2e/chat.spec.ts --headed

# Trace viewer for the last failed run.
bunx playwright show-trace test-results/.../trace.zip
```

## What's covered

- `chat.spec.ts` — typing into the composer, streamed assistant text appearing
  progressively, tool card states, soft-delete via the hover-revealed trash
  button, and that an XSS-style payload (`<img onerror=...>`) renders as text
  rather than firing an `alert()` dialog.
- `voice.spec.ts` — stubs `window.SpeechRecognition` + `navigator.mediaDevices.getUserMedia`,
  clicks the mic, pushes synthetic interim+final results, and verifies the
  silence-debounced `onAutoSubmit` fires (the resulting send completes the
  round trip and the assistant reply renders).
- `tts.spec.ts` — toggles voice on, sends a message, and verifies the
  `<audio>` element gets a non-empty `src` after `/api/tts` is fetched.

## Conventions

- **No real backend.** Every spec uses `page.route()` to fulfil `/api/*` calls
  with canned SSE frames or JSON. The shape of the canned data is documented
  by the SSE protocol contract in `backend/src/routes/chat.ts` and the
  frontend's `src/protocol/frames.ts` (kept in sync by a backend contract
  test).
- **Selectors prefer ARIA roles + accessible names**. CSS classes are a
  fallback when components don't yet expose an accessible label.
- **No parallelism.** `playwright.config.ts` pins `workers: 1` because the
  Vite dev server's HMR socket and our shared route stubs aren't safe to share
  across workers.
- **No backend boot.** Do not extend specs to depend on Postgres, OpenAI, or
  any other live service. If you need to exercise a real backend path, write
  an integration test under `backend/tests/integration` instead.

## CI integration

Wire this into your CI config as a separate `frontend-e2e` job that depends
on `frontend-build`. Suggested commands:

```yaml
- run: cd frontend && bun install
- run: cd frontend && bunx playwright install --with-deps chromium
- run: cd frontend && bunx playwright test
```

CI defaults: `retries: 2`, `forbidOnly: true`, `reporter: "github"` (already
configured via `process.env.CI` in `playwright.config.ts`).
