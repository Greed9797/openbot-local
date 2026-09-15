import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun runs test files in one process: a second unconditional register throws.
if (typeof document === "undefined") {
  GlobalRegistrator.register();
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Types are erased, so this one costs no evaluation and may stay static.
import type { ChannelSummary } from "../src/lib/channels/queries";

/*
 * Deliberately dynamic: a static import is hoisted above the `register` call, and these modules
 * read the DOM while they evaluate — `render` binds `document.body`, and the hook module reads
 * nothing at import but its socket test needs `window.WebSocket` stubbed first.
 */
const { act, render } = await import("@testing-library/react");
const { useChannelEvents } = await import(
  "../src/lib/channels/use-channel-events"
);
const { botKeys, channelKeys } = await import("../src/lib/channels/queries");

function summary(overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: "channel-1",
    name: "Visible chat",
    agentIds: ["bot-1"],
    threadId: "thread-1",
    active: true,
    lastMessage: "Old preview",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    lastMessageAgentId: "bot-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type SentSocket = {
  sent: unknown[];
  close: () => void;
  receive: (payload: unknown) => void;
  fireOpen: () => void;
};

const sockets: SentSocket[] = [];
let realWebSocket: typeof WebSocket | undefined;

function Mount() {
  useChannelEvents();
  return null;
}

function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <Mount />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sockets.splice(0);
  // The hook builds its socket URL from the page URL; happy-dom has none until stubbed.
  Object.defineProperty(globalThis.window, "location", {
    value: new URL("http://openbot.test/"),
    configurable: true,
  });
  realWebSocket = globalThis.WebSocket;
  (globalThis as Record<string, unknown>).WebSocket = class {
    onopen: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    sent: unknown[] = [];
    close = () => {
      this.onclose = null;
    };
    receive = (payload: unknown) => {
      this.onmessage?.({ data: JSON.stringify(payload) });
    };
    fireOpen = () => {
      this.onopen?.();
    };
    constructor() {
      sockets.push(this as unknown as SentSocket);
    }
  };
});

afterEach(() => {
  globalThis.WebSocket = realWebSocket as typeof WebSocket;
});

function seedRoster(client: QueryClient, rows: ChannelSummary[] = [summary()]) {
  client.setQueryData(channelKeys.list(), rows);
}

function seedHistory(
  client: QueryClient,
  botId: string,
  rows: ChannelSummary[],
  q = "",
) {
  client.setQueryData(botKeys.conversas(botId, { q }), {
    pages: [{ conversas: rows }],
    pageParams: [undefined],
  });
}

function historyRows(
  client: QueryClient,
  botId: string,
  q = "",
): ChannelSummary[] {
  const data = client.getQueryData<{
    pages: { conversas: ChannelSummary[] }[];
  }>(botKeys.conversas(botId, { q }));
  return data?.pages.flatMap((page) => page.conversas) ?? [];
}

describe("hidden activity routing", () => {
  test("hidden events patch History and leave the roster object untouched", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rosterBefore = [summary()];
    seedRoster(client, rosterBefore);
    const hidden = summary({
      id: "channel-hidden",
      name: "Hidden chat",
      lastMessage: "Old hidden preview",
    });
    seedHistory(client, "bot-1", [hidden]);
    const view = mount(client);
    try {
      const socket = sockets.at(-1);
      expect(socket).toBeDefined();

      await act(async () => {
        socket?.receive({
          channelId: "channel-hidden",
          lastMessage: "New hidden reply",
          lastMessageAt: "2026-02-01T00:00:00.000Z",
          lastMessageAgentId: "bot-1",
          visivelNoRoster: false,
        });
      });

      expect(client.getQueryData(channelKeys.list())).toBe(rosterBefore);
      expect(historyRows(client, "bot-1")).toMatchObject([
        { id: "channel-hidden", lastMessage: "New hidden reply" },
      ]);
    } finally {
      view.unmount();
    }
  });

  test("hidden events for unknown ids invalidate History, not the roster", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidated: unknown[][] = [];
    const original = client.invalidateQueries.bind(client);
    client.invalidateQueries = (async (filters?: { queryKey?: unknown }) => {
      invalidated.push((filters?.queryKey ?? []) as unknown[]);
      return original(filters);
    }) as typeof client.invalidateQueries;
    seedRoster(client);
    seedHistory(client, "bot-1", [summary({ id: "channel-known" })]);
    const view = mount(client);
    try {
      const socket = sockets.at(-1);

      await act(async () => {
        socket?.receive({
          channelId: "channel-never-fetched",
          lastMessage: "Somewhere else",
          lastMessageAt: "2026-02-01T00:00:00.000Z",
          lastMessageAgentId: "bot-1",
          visivelNoRoster: false,
        });
      });

      expect(invalidated.some((key) => key[0] === "bots")).toBe(true);
      expect(invalidated.some((key) => key[0] === "channels")).toBe(false);
    } finally {
      view.unmount();
      client.invalidateQueries = original;
    }
  });

  test("visible events keep patching the roster as before", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    seedRoster(client);
    seedHistory(client, "bot-1", [
      summary({ id: "channel-hidden", lastMessage: "Stays" }),
    ]);
    const view = mount(client);
    try {
      const socket = sockets.at(-1);

      await act(async () => {
        socket?.receive({
          channelId: "channel-1",
          lastMessage: "New visible reply",
          lastMessageAt: "2026-02-01T00:00:00.000Z",
          lastMessageAgentId: "bot-1",
        });
      });

      expect(
        client.getQueryData<ChannelSummary[]>(channelKeys.list()),
      ).toMatchObject([{ id: "channel-1", lastMessage: "New visible reply" }]);
      expect(historyRows(client, "bot-1")).toMatchObject([
        { id: "channel-hidden", lastMessage: "Stays" },
      ]);
    } finally {
      view.unmount();
    }
  });

  test("botKeys scope History per bot and search", () => {
    expect(botKeys.conversas("bot-1", { q: "fatura" })).toEqual([
      "bots",
      "conversas",
      "bot-1",
      "fatura",
    ]);
    expect(botKeys.conversas("bot-2", { q: "fatura" })).not.toEqual(
      botKeys.conversas("bot-1", { q: "fatura" }),
    );
  });
});
