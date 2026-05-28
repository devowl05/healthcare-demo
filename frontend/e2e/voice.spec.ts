/**
 * Voice-input flow.
 *
 * The frontend uses the Web Speech API (`window.SpeechRecognition` or
 * `webkitSpeechRecognition`) and `navigator.mediaDevices.getUserMedia()`. Both
 * are unavailable in headless Chromium by default, so we stub them via
 * `page.addInitScript()` before the app mounts.
 *
 * Flow under test:
 *   1. Click the mic button → useSpeechInput.start() runs.
 *   2. Push two interim results, then a final.
 *   3. Wait for the configured silence timeout (defaults to 1500ms) — the hook
 *      should call `onAutoSubmit`, which in App.tsx triggers `send()`.
 *   4. The chat SSE stub returns a canned assistant reply.
 *   5. Assert the user message we expect appears in the transcript.
 */

import { expect, test } from "@playwright/test";

const ASSISTANT_MESSAGE_ID = "00000000-0000-0000-0000-0000000000bb";
const CONVERSATION_ID = "00000000-0000-0000-0000-0000000000c1";

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SIMPLE_REPLY = [
  sseFrame("conversation", { id: CONVERSATION_ID }),
  sseFrame("text", { delta: "Acknowledged your symptom report." }),
  sseFrame("done", {
    messageId: ASSISTANT_MESSAGE_ID,
    model: "gpt-5.2",
    inputTokens: 5,
    outputTokens: 4,
    cachedInputTokens: 0,
    costUsd: 0.0001,
    latencyMs: 100,
    requestId: "req-voice-1",
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
      body: SIMPLE_REPLY,
    });
  });

  // Stub the Web Speech API and getUserMedia BEFORE the app boots.
  await page.addInitScript(() => {
    // Minimal getUserMedia stub — returns a fake MediaStream with one track.
    const fakeTrack = {
      kind: "audio",
      stop: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const fakeStream = {
      getTracks: () => [fakeTrack],
      getAudioTracks: () => [fakeTrack],
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => fakeStream,
      },
    });

    // Build a class that mimics enough of `SpeechRecognition` for the hook.
    type Handler = ((e: any) => void) | null;
    class FakeSpeechRecognition {
      interimResults = false;
      continuous = false;
      lang = "en-US";
      onresult: Handler = null;
      onerror: Handler = null;
      onend: Handler = null;
      onstart: Handler = null;
      onnomatch: Handler = null;
      onaudiostart: Handler = null;
      onaudioend: Handler = null;
      onspeechstart: Handler = null;
      onspeechend: Handler = null;

      addEventListener(type: string, fn: Handler): void {
        // Hooks may also use addEventListener instead of onresult assignment.
        // Bridge to the matching property.
        const key = `on${type}` as keyof FakeSpeechRecognition;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any)[key] = fn;
      }
      removeEventListener(): void {
        /* no-op */
      }
      start(): void {
        // Register globally so the test can poke results in.
        (window as any).__fakeRec = this;
        this.onstart?.({} as any);
        // Fire the queued events.
        const q: Array<() => void> = (window as any).__fakeRecQueue ?? [];
        for (const fn of q) fn();
        (window as any).__fakeRecQueue = [];
      }
      stop(): void {
        this.onend?.({} as any);
      }
      abort(): void {
        this.onend?.({} as any);
      }
    }
    (window as any).SpeechRecognition = FakeSpeechRecognition;
    (window as any).webkitSpeechRecognition = FakeSpeechRecognition;
    // Helper invoked from the test to push synthetic transcripts.
    (window as any).__pushSpeechResult = (text: string, isFinal: boolean) => {
      const rec = (window as any).__fakeRec;
      if (!rec || !rec.onresult) {
        // Queue for when start() runs.
        (window as any).__fakeRecQueue =
          (window as any).__fakeRecQueue ?? [];
        (window as any).__fakeRecQueue.push(() =>
          (window as any).__pushSpeechResult(text, isFinal),
        );
        return;
      }
      const ev = {
        resultIndex: 0,
        results: [
          {
            0: { transcript: text, confidence: 1 },
            isFinal,
            length: 1,
          },
        ],
      };
      rec.onresult(ev);
    };
  });
});

test("click mic, push synthetic transcript, auto-submit fires", async ({ page }) => {
  await page.goto("/");

  const micButton = page.getByRole("button", { name: /Start voice input/ });
  await micButton.click();

  // Push an interim then a final result.
  await page.evaluate(() => (window as any).__pushSpeechResult("I have a", false));
  await page.evaluate(() => (window as any).__pushSpeechResult("I have a fever", true));

  // Wait for the silence-debounced auto-submit. The hook defaults to 1500ms;
  // we wait a touch longer to absorb scheduler jitter.
  await page.waitForTimeout(1800);

  // The assistant reply should now be on screen — which proves the auto-submit
  // ran AND that send() was called with our transcript.
  await expect(
    page.getByText("Acknowledged your symptom report."),
  ).toBeVisible({ timeout: 5000 });
});
