import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * A channel as the browser sees it.
 *
 * `threadId` is what makes two channels with the same coworker independent conversations, and
 * `active` is false once a linked coworker has been deleted: the transcript stays readable, but
 * nothing more can be said in it.
 */
export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
};

/** A channel plus the last thing said in it, which is what the roster renders. */
export type ChannelSummary = AgentChannel & {
  lastMessage: string | null;
  /** ISO-8601, or null for a channel nobody has used yet. */
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** ISO-8601. Ordering falls back to this, so a channel just created sorts to the top. */
  createdAt: string;
};

export const channelKeys = {
  all: ["channels"] as const,
  list: () => ["channels", "list"] as const,
  detail: (channelId: string) => ["channels", "detail", channelId] as const,
};

/** History of one bot's hidden conversations. Search is part of the key. */
export const botKeys = {
  all: ["bots"] as const,
  conversas: (botId: string, query?: { q?: string }) =>
    ["bots", "conversas", botId, query?.q?.trim() ?? ""] as const,
};

export type BotConversasPage = {
  conversas: ChannelSummary[];
  nextCursor?: string;
};

export function channelListQueryOptions() {
  return queryOptions({
    queryKey: channelKeys.list(),
    queryFn: async (): Promise<ChannelSummary[]> => {
      return client("/api/channels", "channels", {
        fallback: "Não foi possível carregar os canais",
      });
    },
  });
}

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async (): Promise<AgentChannel> => {
      return client(`/api/channels/${channelId}`, "channel", {
        fallback: "Não foi possível carregar este canal",
      });
    },
  });
}

/**
 * One bot's hidden conversations, newest activity first.
 *
 * Infinite because History grows without bound and the roster already proved
 * a flat list does not scale; the cursor is opaque to the screen, which only
 * passes back what the server returned. Search re-keys rather than filters
 * locally, so typing queries the server instead of the fetched pages.
 */
export function botConversasQueryOptions(botId: string, q: string) {
  return infiniteQueryOptions({
    queryKey: botKeys.conversas(botId, { q }),
    queryFn: async ({
      pageParam,
    }: {
      pageParam?: string;
    }): Promise<BotConversasPage> => {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (pageParam) params.set("cursor", pageParam);
      params.set("limit", "20");
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const response = await client(
        `/api/bots/${encodeURIComponent(botId)}/conversas${query}`,
        {
          fallback: "Não foi possível carregar o histórico",
        },
      );
      return (await response.json()) as BotConversasPage;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
