/**
 * Message CRUD routes — currently just soft-delete. The chat write path lives
 * in the streaming chat route; this file exists so the SPA can hide / scrub a
 * single message without having to reach into the conversation aggregate.
 */

import { Hono } from "hono";
import type { AuthUser } from "../middleware/auth.ts";
import { requireAuth } from "../middleware/auth.ts";
import { softDeleteMessage } from "../repo/messages.ts";
import { append as auditAppend } from "../repo/audit-log.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildMessagesRouter(): Hono {
  const router = new Hono();
  router.use("*", requireAuth());

  router.delete("/:id", async (c) => {
    const user = c.get("user") as AuthUser;
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      return c.json({ code: "not_found", message: "message not found" }, 404);
    }
    const ok = await softDeleteMessage(id, user.id);
    if (!ok) {
      return c.json({ code: "not_found", message: "message not found" }, 404);
    }
    await auditAppend({
      ctx: { userId: user.id },
      action: "message.delete",
      resourceType: "message",
      resourceId: id,
    });
    return c.body(null, 204);
  });

  return router;
}

export const messagesRouter = buildMessagesRouter();
