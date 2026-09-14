import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuthenticatedActor, AppVariables } from "../auth/guards";
import type { DurableAgentRunner } from "../copilot-runner";
import type { Database } from "../db/client";
import {
  intelligenceChannelMappings,
  localThreadHistory,
} from "../db/schema/core";
import type { ChannelStore } from "./routes";

export type RequireUser = MiddlewareHandler<{ Variables: AppVariables }>;

/**
 * Who may read a thread's durable history.
 *
 * A channel-bound thread belongs to whoever the channel mapping names, and
 * only while the channel itself still answers for them: membership plus bot
 * access, which is exactly what `ChannelStore.get` already enforces. A thread
 * with no channel is readable only when its history row names its owner. The
 * `agentId` query parameter never grants ownership.
 *
 * Legacy rows with no provable owner stay stored and unreadable here: a 404,
 * never a guess and never a deletion. Administrative recovery of those chats
 * is its own authorized context, not an automatic assignment.
 */
export async function isThreadReadableBy(
  database: Database,
  channelStore: ChannelStore | undefined,
  actor: Pick<AuthenticatedActor, "id" | "role">,
  threadId: string,
): Promise<boolean> {
  const mappings = await database
    .select({ channelId: intelligenceChannelMappings.channelId })
    .from(intelligenceChannelMappings)
    .where(
      and(
        eq(intelligenceChannelMappings.threadId, threadId),
        eq(intelligenceChannelMappings.userId, actor.id),
      ),
    )
    .limit(1);
  const mapping = mappings[0];
  if (mapping) {
    if (!channelStore) return false;
    return (
      (await channelStore.get(
        { id: actor.id, role: actor.role },
        mapping.channelId,
      )) !== null
    );
  }

  const rows = await database
    .select({ userId: localThreadHistory.userId })
    .from(localThreadHistory)
    .where(eq(localThreadHistory.threadId, threadId))
    .limit(1);
  const row = rows[0];
  return row !== undefined && row.userId !== null && row.userId === actor.id;
}

export function createThreadHistoryRoutes(
  runner: DurableAgentRunner,
  database: Database,
  channelStore: ChannelStore | undefined,
  requireUser: RequireUser,
): Hono {
  const routes = new Hono();
  routes.get(
    "/api/copilotkit/threads/:threadId/messages",
    requireUser,
    async (context) => {
      const threadId = context.req.param("threadId");
      const actor = context.var.actor;
      let readable: boolean;
      try {
        readable = await isThreadReadableBy(
          database,
          channelStore,
          actor,
          threadId,
        );
      } catch {
        return context.json({ error: "History is unavailable." }, 503);
      }
      if (!readable) return context.json({ error: "Not found." }, 404);
      try {
        // Canonical AG-UI, as the runner holds it. Intelligence mode keeps the
        // SDK's own route; this one only exists beside a local runner.
        return context.json({ messages: await runner.hydrate(threadId) });
      } catch {
        return context.json({ error: "History is unavailable." }, 503);
      }
    },
  );
  return routes;
}
