import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type BotConversasPage,
  botKeys,
  type ChannelSummary,
  channelKeys,
} from "./queries";

/**
 * Keep the roster live.
 *
 * The query remains the source of truth; socket events only patch its cache. Reconnects refetch the
 * list to recover events missed while disconnected.
 */

type ChannelActivityEvent = {
  channelId: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** Absent from old payloads in flight: treated as visible, the previous behavior. */
  visivelNoRoster?: boolean;
};

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

function socketUrl() {
  const url = new URL("/api/channels/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useChannelEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let retryDelay = FIRST_RETRY_MS;
    let stopped = false;

    /**
     * Patch a hidden conversation wherever it sits in the History cache.
     *
     * Infinite pages, not one list: the row may live on any page of any
     * search, so every `bots/conversas` cache entry is walked. Unknown ids
     * invalidate rather than insert — the row might belong to a page not yet
     * fetched or a search that excludes it, and guessing the position would
     * corrupt the cursor order.
     */
    const patchBotConversas = (activity: ChannelActivityEvent) => {
      const entries = queryClient.getQueriesData<BotConversasPage>({
        queryKey: botKeys.all,
      });
      let patchedAny = false;
      for (const [key, pages] of entries) {
        const data = pages as
          | { pages: BotConversasPage[] }
          | BotConversasPage
          | undefined;
        const pageList = Array.isArray((data as { pages?: unknown })?.pages)
          ? (data as { pages: BotConversasPage[] }).pages
          : data
            ? [data as BotConversasPage]
            : [];
        let touched = false;
        const nextPages = pageList.map((page) => {
          const index = page.conversas.findIndex(
            (channel) => channel.id === activity.channelId,
          );
          if (index === -1) return page;
          const previous = page.conversas[index];
          if (!previous) return page;
          /*
           * Only the three fields the activity actually reports. Spreading the whole event would
           * copy `channelId` and `visivelNoRoster` into a row that has neither, and — the part
           * that would bite later — any field the event gains whose name a summary already uses
           * would silently overwrite it.
           */
          const patched = {
            ...previous,
            lastMessage: activity.lastMessage,
            lastMessageAt: activity.lastMessageAt,
            lastMessageAgentId: activity.lastMessageAgentId,
          };
          if (
            patched.lastMessage === previous.lastMessage &&
            patched.lastMessageAt === previous.lastMessageAt &&
            patched.lastMessageAgentId === previous.lastMessageAgentId
          ) {
            return page;
          }
          touched = true;
          const conversas = page.conversas.slice();
          conversas[index] = patched;
          conversas.sort(byRecency);
          return { ...page, conversas };
        });
        if (!touched) continue;
        patchedAny = true;
        queryClient.setQueryData(key, (old: unknown) => {
          if (
            old &&
            typeof old === "object" &&
            Array.isArray((old as { pages?: unknown }).pages)
          ) {
            return { ...(old as object), pages: nextPages };
          }
          return nextPages[0];
        });
      }
      if (!patchedAny) {
        void queryClient.invalidateQueries({ queryKey: botKeys.all });
      }
    };
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl());

      socket.onopen = () => {
        retryDelay = FIRST_RETRY_MS;
        /*
         * Recover events missed while the socket was disconnected — both lists. A bot's hidden
         * conversations are never in the roster, so refetching only that one would leave the
         * History tab showing whatever it had before the drop until someone reloaded the page.
         */
        void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
        void queryClient.invalidateQueries({ queryKey: botKeys.all });
      };

      socket.onmessage = (message) => {
        let activity: ChannelActivityEvent;
        try {
          activity = JSON.parse(message.data as string);
        } catch {
          return;
        }

        // A bot's own conversations never render in the roster, so their events must not touch it:
        // patching here would either invalidate a list that excludes the row or, worse, insert it.
        // They land in the History cache instead; the roster query stays untouched.
        if (activity.visivelNoRoster === false) {
          patchBotConversas(activity);
          return;
        }

        queryClient.setQueryData(
          channelKeys.list(),
          (channels: ChannelSummary[] | undefined) => {
            if (!channels) return channels;
            // Unknown channel ids mean the roster is stale; refetch the list instead of patching.
            if (!channels.some((c) => c.id === activity.channelId)) {
              void queryClient.invalidateQueries({
                queryKey: channelKeys.list(),
              });
              return channels;
            }
            // Preserve object identity for unchanged rows so memoized rows do not re-render.
            const index = channels.findIndex(
              (channel) => channel.id === activity.channelId,
            );
            const previous = channels[index];
            if (!previous) return channels;

            // Same three fields as the History patch, and for the same reason: the event carries
            // keys a roster row does not have, and must not get to define the ones it does.
            const patched = {
              ...previous,
              lastMessage: activity.lastMessage,
              lastMessageAt: activity.lastMessageAt,
              lastMessageAgentId: activity.lastMessageAgentId,
            };
            const next = channels.slice();
            next[index] = patched;
            next.sort(byRecency);

            // An event that changes nothing visible, a duplicate, or a report the server ignored
            // as stale, returns the original array, so React re-renders nothing at all.
            return next.every((channel, at) => channel === channels[at])
              ? channels
              : next;
          },
        );
      };

      // WebSocket needs explicit reconnect handling.
      socket.onclose = () => {
        if (stopped) return;
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      // Cleared first: the close below must not schedule a reconnect for a screen that is gone.
      if (socket) socket.onclose = null;
      socket?.close();
    };
  }, [queryClient]);
}

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * Deliberately the same rule the roster query uses, `coalesce(last_message_at, created_at) desc` in
 * channels/routes.ts. If these two disagree the list reorders itself the moment an event arrives,
 * which looks like rows jumping for no reason.
 */
function byRecency(left: ChannelSummary, right: ChannelSummary) {
  const at = (channel: ChannelSummary) =>
    channel.lastMessageAt ?? channel.createdAt;
  return at(right).localeCompare(at(left));
}
