/**
 * Request-scoped context propagated via Node's AsyncLocalStorage.
 *
 * The HTTP middleware and job runners call `runWithCtx(ctx, fn)` once at the
 * top of every request/job and every nested async call inherits the same
 * `{ requestId, userId?, conversationId? }`. The pino logger reads this store
 * in its `mixin` so every log line carries `requestId` without callers having
 * to thread it through manually.
 *
 * No fallback: code that needs the request id must run inside `runWithCtx` or
 * call `getCtx()` and tolerate `undefined`. We do NOT silently invent ids.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ObsContext {
  requestId: string;
  userId?: string;
  conversationId?: string;
}

const storage = new AsyncLocalStorage<ObsContext>();

export function getCtx(): ObsContext | undefined {
  return storage.getStore();
}

export function runWithCtx<T>(ctx: ObsContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Update fields on the current context (e.g. set `userId` once auth resolves).
 * No-op when called outside `runWithCtx`.
 */
export function patchCtx(patch: Partial<ObsContext>): void {
  const cur = storage.getStore();
  if (!cur) return;
  Object.assign(cur, patch);
}
