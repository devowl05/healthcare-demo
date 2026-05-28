/**
 * Playwright configuration for the Healthcare Agent frontend E2E suite.
 *
 * Design notes:
 *   - We mock `/api/*` via `page.route()` in every spec so the dev server can
 *     run alone — no backend required.
 *   - The dev server is launched by Playwright via `webServer.command`. We use
 *     `bun run dev` (Vite) and target the canonical 5173 port. If the port is
 *     busy `reuseExistingServer` lets you run specs against a server you
 *     already started in another terminal.
 *   - We disable Playwright's worker parallelism because Vite's HMR socket gets
 *     confused when multiple workers connect simultaneously, and because our
 *     specs mock the same global API routes (race conditions on `page.route()`
 *     scope aside, we keep behavior predictable).
 *   - `trace: "on-first-retry"` gives us a Playwright trace when CI flakes,
 *     without inflating disk usage for green runs.
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5173);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Run specs serially so the dev server isn't pummeled.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "bun run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
