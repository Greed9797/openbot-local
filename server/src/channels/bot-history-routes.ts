import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import { BotHistoryCursorError, type ChannelStore } from "./routes";

function channelSummaryDto(channel: {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  lastMessageAgentId: string | null;
  createdAt: Date;
}) {
  return {
    id: channel.id,
    name: channel.name,
    agentIds: channel.agentIds,
    threadId: channel.threadId,
    active: channel.active,
    lastMessage: channel.lastMessage,
    // Serialised as ISO-8601 so the browser gets a string it can sort and format.
    lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
    lastMessageAgentId: channel.lastMessageAgentId,
    createdAt: channel.createdAt.toISOString(),
  };
}

/**
 * One bot's hidden conversations.
 *
 * Mounted under `/api/bots` rather than `/api/channels/:id`, because the id
 * here is a bot, not a channel: reading `/:channelId` first would swallow
 * "conversas" as a channel id. Auth mirrors the roster: a member reads, a
 * stranger gets the same 404 as an unknown bot, so existence never leaks.
 */
export function createBotHistoryRoutes(
  store: ChannelStore,
  profileStore: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:botId/conversas", requireUser, async (context) => {
    const botId = context.req.param("botId");
    const profile = await profileStore.get(context.var.actor, botId);
    // Not found, deleted, or simply not visible to this actor: one answer for
    // all three, same shape as the channel 404, so probing learns nothing.
    if (!profile) return context.json({ error: "Channel not found." }, 404);

    const url = new URL(context.req.url);
    const requestedLimit = Number.parseInt(
      url.searchParams.get("limit") ?? "50",
      10,
    );
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 50;

    try {
      const page = await store.listBotConversations(context.var.actor, botId, {
        q: url.searchParams.get("q") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit,
      });
      return context.json({
        conversas: page.items.map(channelSummaryDto),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    } catch (error: unknown) {
      if (error instanceof BotHistoryCursorError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  return routes;
}
