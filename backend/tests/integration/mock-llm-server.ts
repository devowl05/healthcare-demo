/**
 * Scripted `LLMClient` for the chat integration tests.
 *
 * Mirrors `tests/unit/mock-llm.ts` but with conveniences tuned for whole-
 * request scenarios:
 *   - `tools` aware: emits `tool_use_complete` events on demand.
 *   - Per-test instantiation: each test makes its own mock so script state
 *     doesn't bleed between cases.
 *
 * The chat route reaches us via `createOpenAIClient()` after the test
 * registers the mock with `setLLMClientForTesting(mockLLM(scripts))`.
 */

import type {
  LLMClient,
  StreamTurnEvent,
} from "../../src/agent/types.ts";

export type ScriptedEvent = StreamTurnEvent;
export type Script = ScriptedEvent[];

export interface MockLLMOptions {
  /** When set, the streamTurn promise rejects with this error before yielding. */
  throwOnCall?: number;
  /** Per-event delay; useful for the timeout test. */
  perEventDelayMs?: number;
}

export interface MockLLM extends LLMClient {
  calls: number;
}

export function mockLLM(scripts: Script[], opts: MockLLMOptions = {}): MockLLM {
  let i = 0;
  const obj: MockLLM = {
    calls: 0,
    streamTurn(args: {
      model: string;
      system: string;
      messages: unknown[];
      tools: unknown[];
      signal: AbortSignal;
    }): AsyncIterable<StreamTurnEvent> {
      const callIndex = i++;
      obj.calls = i;

      if (opts.throwOnCall === callIndex) {
        return (async function* () {
          throw new Error("mock provider failure");
        })();
      }

      const script = scripts[callIndex] ?? scripts[scripts.length - 1];
      if (!script) {
        return (async function* () {
          throw new Error(`mockLLM: no script for call ${callIndex}`);
        })();
      }

      return (async function* () {
        for (const ev of script) {
          if (opts.perEventDelayMs) {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, opts.perEventDelayMs);
              args.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  reject(new DOMException("aborted", "AbortError"));
                },
                { once: true },
              );
            });
          } else {
            await Promise.resolve();
          }
          if (args.signal.aborted) {
            throw new DOMException("aborted", "AbortError");
          }
          yield ev;
        }
      })();
    },
  };
  return obj;
}
