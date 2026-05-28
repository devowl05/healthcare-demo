/**
 * Scripted `LLMClient` for unit tests.
 *
 * Constructed with one event sequence per planned `streamTurn` invocation.
 * `mockLLM([ [ev1, ev2, ...], [ev1, ...] ])` yields the first array on the
 * first call, the second on the second, and so on. If `streamTurn` is called
 * more times than there are scripts, the extra calls throw — that's almost
 * always a bug in the test (model called more times than expected).
 *
 * A script entry can be either a `StreamTurnEvent` or a function returning
 * such an event (handy for tests that need to read the call args before
 * deciding what to emit). Pass `() => { throw … }` to simulate provider
 * errors and the entire `streamTurn` call rejects.
 */

import type { LLMClient, StreamTurnEvent } from "../../src/agent/types.ts";

export type ScriptEntry = StreamTurnEvent | ((args: StreamArgs) => StreamTurnEvent | never);
export type Script = ScriptEntry[];

export interface StreamArgs {
  model: string;
  system: string;
  messages: unknown[];
  tools: unknown[];
}

export interface MockLLM extends LLMClient {
  calls: StreamArgs[];
  remaining: number;
}

export function mockLLM(scripts: Script[], opts?: { throwOnCall?: number }): MockLLM {
  let i = 0;
  const calls: StreamArgs[] = [];

  return {
    calls,
    get remaining() {
      return Math.max(0, scripts.length - i);
    },
    streamTurn(args: {
      model: string;
      system: string;
      messages: any[];
      tools: any[];
      signal: AbortSignal;
    }): AsyncIterable<StreamTurnEvent> {
      const callIndex = i++;
      const snapshot: StreamArgs = {
        model: args.model,
        system: args.system,
        messages: args.messages,
        tools: args.tools,
      };
      calls.push(snapshot);

      if (opts?.throwOnCall === callIndex) {
        return (async function* () {
          throw new Error("mock provider failure");
        })();
      }

      const script = scripts[callIndex];
      if (!script) {
        return (async function* () {
          throw new Error(`mockLLM: streamTurn called ${callIndex + 1} times but only ${scripts.length} scripts were provided`);
        })();
      }

      return (async function* () {
        for (const entry of script) {
          if (args.signal.aborted) {
            throw new DOMException("aborted", "AbortError");
          }
          const ev = typeof entry === "function" ? entry(snapshot) : entry;
          // Yield on a microtask boundary so abort signals get a chance to fire
          // between events — important for the mid-stream abort test.
          await Promise.resolve();
          yield ev;
        }
      })();
    },
  };
}
