import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun runs test files in one process: a second unconditional register throws.
if (typeof document === "undefined") {
  GlobalRegistrator.register();
}

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as ActualCopilot from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import type { Message } from "@ag-ui/core";

// Bound after the DOM above exists: `screen` queries `document.body` at import.
const { fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);
type FakeStore = { messages: Message[] };

const agentStores = new Map<string, FakeStore>();
const bumps = new Map<string, () => void>();
const runCalls: { threadId: string; snapshot: Message[] }[] = [];

function storeFor(threadId: string): FakeStore {
  let store = agentStores.get(threadId);
  if (!store) {
    store = { messages: [] };
    agentStores.set(threadId, store);
  }
  return store;
}

mock.module("@copilotkit/react-core/v2", () => ({
  ...ActualCopilot,
  UseAgentUpdate: { OnMessagesChanged: "messages", OnRunStatusChanged: "runs" },
  useAgent: (opts: { threadId: string }) => {
    const key = opts.threadId;
    const [, setVersion] = useState(0);
    storeFor(key);
    bumps.set(key, () => setVersion((v) => v + 1));
    const agent = {
      get messages(): Message[] {
        return storeFor(key).messages;
      },
      isRunning: false,
      addMessage(message: Message) {
        storeFor(key).messages.push(message);
        bumps.get(key)?.();
      },
      setMessages(messages: Message[]) {
        storeFor(key).messages = [...messages];
        bumps.get(key)?.();
      },
      subscribe() {
        return { unsubscribe() {} };
      },
    };
    return { agent, isReady: true };
  },
  useCopilotKit: () => ({
    copilotkit: {
      connectAgent: async () => {},
      runAgent: async ({ agent }: { agent: { messages: Message[] } }) => {
        const entry = agentStores
          .entries()
          .find(([, s]) => s.messages === agent.messages);
        const threadId = entry?.[0] ?? "unknown";
        runCalls.push({ threadId, snapshot: [...agent.messages] });
        storeFor(threadId).messages.push({
          id: `reply-${runCalls.length}`,
          role: "assistant",
          content: "reply",
        });
        bumps.get(threadId)?.();
      },
      stopAgent: () => {},
    },
  }),
  useRenderToolCall: () => () => null,
  useFrontendTool: () => {},
  useHumanInTheLoop: () => {},
}));

/*
 * No `mock.module` for react-query: Bun applies every file's module mocks before running any test,
 * so a `useQuery` stub here would answer `undefined` to unrelated files and fail them for a reason
 * nothing in them explains. A real client over the stubbed `fetch` below gives the same empty data
 * without reaching outside this file.
 */
function Providers({ children }: { children: ReactNode }) {
  // Held in state so a `rerender` keeps the same cache instead of remounting every query.
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// `useActiveBot` is a no-op without its provider, and the real `useSkillCommands` answers [] because
// the stubbed `fetch` 404s anything that is not a thread read, so both run unmocked.
const { ChannelChat } = await import("../src/components/channels/channel-chat");
const { mergeHistoryMessages } = await import(
  "../src/lib/copilot/history-merge"
);
const { stashFirstMessage } = await import(
  "../src/components/channels/transcript-messages"
);
const fetchHandlers = new Map<string, () => Promise<Response>>();

function threadOf(url: string): string | null {
  const match = url.match(/\/threads\/([^/]+)\/messages/);
  return match ? decodeURIComponent(match[1] as string) : null;
}

function jsonMessages(messages: unknown): Response {
  return new Response(JSON.stringify({ messages }), { status: 200 });
}

function channel(id: string, threadId: string) {
  return {
    id,
    name: id,
    agentIds: ["bot-1"],
    threadId,
    active: true,
  };
}

beforeEach(() => {
  agentStores.clear();
  bumps.clear();
  runCalls.length = 0;
  fetchHandlers.clear();
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const threadId = threadOf(url);
    const handler = threadId ? fetchHandlers.get(threadId) : undefined;
    if (!handler) return new Response("not found", { status: 404 });
    return handler();
  }) as typeof fetch;
});
describe("restoring channel history before any send", () => {
  test("a seed waits for the restore and runs once with the full history", async () => {
    const gate = Promise.withResolvers<Response>();
    fetchHandlers.set("threadA", () => gate.promise);
    stashFirstMessage("chanA", "hello seed");
    render(
      <ChannelChat
        channel={channel("chanA", "threadA")}
        runtimeAgentId="bot-1"
      />,
      { wrapper: Providers },
    );

    expect(await screen.findByText("Carregando histórico…")).toBeDefined();
    // No run while the restore is in flight.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runCalls).toHaveLength(0);

    gate.resolve(jsonMessages([{ id: "h1", role: "user", content: "old hi" }]));
    await waitFor(() => expect(runCalls).toHaveLength(1));
    expect(runCalls[0]?.snapshot.map((m) => m.id)).toContain("h1");
    expect(
      runCalls[0]?.snapshot.some(
        (m) => m.role === "user" && m.content === "hello seed",
      ),
    ).toBe(true);
    expect(await screen.findByText("old hi")).toBeDefined();
  });

  test("a failed restore keeps the seed and retry delivers it", async () => {
    fetchHandlers.set("threadB", () =>
      Promise.resolve(new Response("down", { status: 503 })),
    );
    stashFirstMessage("chanB", "hello seed");

    const { unmount } = render(
      <ChannelChat
        channel={channel("chanB", "threadB")}
        runtimeAgentId="bot-1"
      />,
      { wrapper: Providers },
    );

    expect(
      await screen.findByText("Não foi possível carregar o histórico."),
    ).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runCalls).toHaveLength(0);

    fetchHandlers.set("threadB", () =>
      Promise.resolve(
        jsonMessages([{ id: "h2", role: "user", content: "saved words" }]),
      ),
    );
    fireEvent.click(screen.getByText("Tentar novamente"));

    await waitFor(() => expect(runCalls).toHaveLength(1));
    expect(
      runCalls[0]?.snapshot.some(
        (m) => m.role === "user" && m.content === "hello seed",
      ),
    ).toBe(true);
    unmount();
  });

  test("a late answer for the previous thread never touches the current one", async () => {
    const gateA = Promise.withResolvers<Response>();
    fetchHandlers.set("threadA", () => gateA.promise);
    fetchHandlers.set("threadB", () =>
      Promise.resolve(
        jsonMessages([{ id: "hb", role: "user", content: "history B" }]),
      ),
    );

    const view = render(
      <ChannelChat
        channel={channel("chanA", "threadA")}
        runtimeAgentId="bot-1"
      />,
      { wrapper: Providers },
    );
    view.rerender(
      <ChannelChat
        channel={channel("chanB", "threadB")}
        runtimeAgentId="bot-1"
      />,
    );

    await waitFor(() => expect(runCalls).toHaveLength(0));
    expect(await screen.findByText("history B")).toBeDefined();

    // The stale answer lands after the switch: it must not contaminate B.
    gateA.resolve(
      jsonMessages([{ id: "ha", role: "user", content: "history A" }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("history A")).toBeNull();
    expect(storeFor("threadB").messages.map((m) => m.id)).toContain("hb");
    view.unmount();
  });
});

describe("merging saved history with local turns", () => {
  test("saved first, local update of the same id wins, new local at the end", () => {
    const stored = [
      { id: "h1", role: "user", content: "old" },
      { id: "h2", role: "user", content: "saved" },
    ] as Message[];
    const local = [
      { id: "h2", role: "user", content: "edited locally" },
      { id: "n1", role: "user", content: "typed while loading" },
    ] as Message[];
    expect(mergeHistoryMessages(stored, local)).toEqual([
      { id: "h1", role: "user", content: "old" },
      { id: "h2", role: "user", content: "edited locally" },
      { id: "n1", role: "user", content: "typed while loading" },
    ]);
  });
});
