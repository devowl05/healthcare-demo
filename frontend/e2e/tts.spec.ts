/**
 * Text-to-speech playback flow.
 *
 * Flow under test:
 *   1. Toggle the Voice switch on (header button).
 *   2. Send a message — the chat SSE stub returns a one-line assistant reply.
 *   3. AudioControls auto-fetches `/api/tts` for the latest assistant message;
 *      we stub it to return a 1-byte MP3 blob.
 *   4. Assert an `<audio>` element exists with a `src` set (blob URL or otherwise).
 *
 * We don't assert actual playback (the headless browser may block autoplay).
 * The success signal is purely that the audio element receives a src, which
 * proves the fetch + URL.createObjectURL pipeline ran end-to-end.
 */

import { expect, test } from "@playwright/test";

const ASSISTANT_MESSAGE_ID = "00000000-0000-0000-0000-0000000000dd";
const CONVERSATION_ID = "00000000-0000-0000-0000-0000000000c2";

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const REPLY = [
  sseFrame("conversation", { id: CONVERSATION_ID }),
  sseFrame("text", { delta: "Here is a brief answer." }),
  sseFrame("done", {
    messageId: ASSISTANT_MESSAGE_ID,
    model: "gpt-5.2",
    inputTokens: 5,
    outputTokens: 4,
    cachedInputTokens: 0,
    costUsd: 0.0001,
    latencyMs: 100,
    requestId: "req-tts-1",
  }),
].join("");

test.beforeEach(async ({ page }) => {
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

  await page.route("**/api/chat", async (route) => {
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: REPLY,
    });
  });

  // A minimal MP3 magic-byte payload. The browser won't decode it but
  // URL.createObjectURL is happy with any Blob.
  await page.route("**/api/tts", async (route) => {
    // A minimal MP3-frame-shaped payload. Playwright's `body` accepts a string
    // or Buffer; the binary string here round-trips bytes 0xFF 0xFB 0x00 0x00.
    return route.fulfill({
      status: 200,
      headers: { "content-type": "audio/mpeg" },
      body: "\xff\xfb\x00\x00",
    });
  });
});

test("voice toggle on -> sending a message creates an <audio> with a src", async ({
  page,
}) => {
  await page.goto("/");

  // Toggle voice on.
  const voiceSwitch = page.getByRole("button", { name: "Toggle voice" });
  await voiceSwitch.click();
  await expect(voiceSwitch).toHaveAttribute("aria-pressed", "true");

  // Send a message.
  const composer = page.locator(".composer__textarea");
  await composer.fill("Tell me about acetaminophen");
  await composer.press("Enter");

  // Wait for the assistant reply to render.
  await expect(page.getByText("Here is a brief answer.")).toBeVisible();

  // The AudioControls component renders the <audio> element with src bound to
  // the fetched blob URL. Wait for it.
  const audio = page.locator("audio").first();
  await expect(audio).toBeAttached();
  // The src attribute should be set to a non-empty value (blob: URL).
  await expect.poll(
    async () => {
      const src = await audio.getAttribute("src");
      return src ?? "";
    },
    { timeout: 5_000 },
  ).not.toEqual("");
});
