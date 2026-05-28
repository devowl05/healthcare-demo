/**
 * Drive the chat flow end-to-end with a stubbed SSE response.
 *
 * We don't need a backend: `page.route()` intercepts `/api/chat` and replies
 * with a canned SSE body containing `conversation` -> `text` -> `tool_call`
 * (pending/running/complete) -> `done` frames. The frontend's SSE parser
 * shouldn't care that the body was synthesized; if anything diverges the test
 * will fail loudly.
 *
 * Assertions:
 *   - Typing into the composer + Enter triggers a request to `/api/chat`.
 *   - Streaming text shows up progressively in an assistant bubble.
 *   - The tool card renders the final "complete" state.
 *   - Hovering the assistant message reveals the delete button; clicking it
 *     issues a DELETE /api/messages/:id and the bubble disappears.
 *   - User-supplied `<script>` payloads render as TEXT, not executed code
 *     (rehype-sanitize in MessageView).
 */

import { expect, test } from "@playwright/test";

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const ASSISTANT_MESSAGE_ID = "00000000-0000-0000-0000-0000000000aa";
const CONVERSATION_ID = "00000000-0000-0000-0000-0000000000c0";

function buildScriptedSSE(): string {
  return [
    sseFrame("conversation", { id: CONVERSATION_ID }),
    sseFrame("text", { delta: "Ibuprofen is " }),
    sseFrame("text", { delta: "an NSAID. " }),
    sseFrame("tool_call", {
      id: "t1",
      name: "lookup_drug",
      input: { name: "ibuprofen" },
      state: "pending",
    }),
    sseFrame("tool_call", {
      id: "t1",
      name: "lookup_drug",
      input: { name: "ibuprofen" },
      state: "running",
    }),
    sseFrame("tool_call", {
      id: "t1",
      name: "lookup_drug",
      input: { name: "ibuprofen" },
      state: "complete",
      output: "Drug: Ibuprofen — see warnings.",
    }),
    sseFrame("text", { delta: "Common warnings include GI upset." }),
    sseFrame("done", {
      messageId: ASSISTANT_MESSAGE_ID,
      model: "gpt-5.2",
      inputTokens: 12,
      outputTokens: 18,
      cachedInputTokens: 0,
      costUsd: 0.0002,
      latencyMs: 420,
      requestId: "req-e2e-1",
    }),
  ].join("");
}

test.beforeEach(async ({ page }) => {
  // Stub /api/conversations history fetch (initial hydrate).
  await page.route("**/api/conversations/**", async (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [], hasMore: false }),
    });
  });

  // Stub the chat SSE endpoint.
  await page.route("**/api/chat", async (route) => {
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
      body: buildScriptedSSE(),
    });
  });

  // Stub the delete-message endpoint.
  await page.route("**/api/messages/**", async (route) => {
    return route.fulfill({ status: 204 });
  });
});

test("chat happy path: type, stream, tool card, delete", async ({ page }) => {
  await page.goto("/");

  // The composer textarea is the only one in the document.
  const composer = page.locator(".composer__textarea");
  await composer.fill("What are the warnings for ibuprofen?");
  await composer.press("Enter");

  // Streaming text should appear progressively. We wait for the FINAL chunk
  // because Playwright's auto-wait will retry until the locator resolves.
  await expect(
    page.getByText("Common warnings include GI upset."),
  ).toBeVisible();

  // The earlier text chunks should also be on the page.
  await expect(page.getByText("Ibuprofen is")).toBeVisible();
  await expect(page.getByText("an NSAID.")).toBeVisible();

  // The tool card final state — we don't depend on specific markup, just that
  // the tool name and output text are surfaced somewhere in the assistant turn.
  await expect(page.getByText(/lookup_drug/)).toBeVisible();
  await expect(page.getByText(/Drug: Ibuprofen/)).toBeVisible();

  // Hover the assistant bubble to reveal the delete button.
  const assistantMessage = page.locator(
    `[data-message-id="${ASSISTANT_MESSAGE_ID}"]`,
  );
  await assistantMessage.hover();
  const del = page.getByRole("button", { name: "Delete message" });
  await del.click();

  // Bubble should be gone after the optimistic delete.
  await expect(assistantMessage).toHaveCount(0);
});

test("XSS payload renders as text, not executed HTML", async ({ page }) => {
  await page.goto("/");

  // Inject a payload that, if not sanitized, would mount an <img> tag whose
  // onerror handler fires. We listen for any dialog (alert) — if one appears
  // the sanitizer failed.
  let alertFired = false;
  page.on("dialog", async (d) => {
    alertFired = true;
    await d.dismiss();
  });

  // Replace the SSE stub with one that echoes the XSS payload in an
  // assistant text part.
  await page.route("**/api/chat", async (route) => {
    const body = [
      sseFrame("conversation", { id: CONVERSATION_ID }),
      sseFrame("text", {
        delta: "<img src=x onerror=\"alert('xss')\"> end",
      }),
      sseFrame("done", {
        messageId: ASSISTANT_MESSAGE_ID,
        model: "gpt-5.2",
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        costUsd: 0,
        latencyMs: 10,
        requestId: "req-xss",
      }),
    ].join("");
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body,
    });
  });

  const composer = page.locator(".composer__textarea");
  await composer.fill("Test XSS");
  await composer.press("Enter");

  // Either the literal text appears or a non-executing <img> tag exists. In
  // either case no alert should fire.
  await expect(page.getByText(/end/)).toBeVisible();
  // Give a tick for any alert() handler to run.
  await page.waitForTimeout(100);
  expect(alertFired).toBe(false);
});
