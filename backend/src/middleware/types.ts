/**
 * Hono module augmentation — registers every variable we read/write via
 * `c.set` / `c.get` so the TypeScript compiler can check both call sites
 * and middleware producers.
 *
 * Add new variables here as middleware introduces them; the per-middleware
 * file is then free of `as unknown as X` casts.
 */

import type { AuthUser } from "./auth.ts";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    user: AuthUser;
    /** null when this request is NOT a replay; original requestId when it is. */
    idempotencyReplay: string | null;
  }
}

// Type-only file; exporting an empty object lets bundlers treat it as a
// module and ensures `declare module` is picked up.
export {};
