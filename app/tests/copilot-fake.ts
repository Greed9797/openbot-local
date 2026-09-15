import type { Message } from "@ag-ui/core";
import * as ActualCopilot from "@copilotkit/react-core/v2";
import { useState } from "react";

/**
 * The one fake CopilotKit runtime for the whole app test process.
 *
 * `mock.module` is process-wide and the last registration wins for every file, so two test files
 * that each write their own fake do not get one each: one silently replaces the other, and the file
 * that loses fails for a reason nothing in it explains. Everything that needs a fake runtime
 * registers this same factory instead, so whichever registration wins is the same runtime.
 *
 * It keeps messages per thread, because the thing most worth catching in a conversation surface is
 * one conversation showing another's messages.
 */

type FakeStore = { messages: Message[] };

/** Messages per thread id, readable by tests that need to plant or inspect a conversation. */
export const agentStores = new Map<string, FakeStore>();
/** Re-render triggers per thread id, so a fake mutation reaches the screen. */
export const bumps = new Map<string, () => void>();
/** Every run the surface asked for, with the history it sent. */
export const runCalls: { threadId: string; snapshot: Message[] }[] = [];

export function storeFor(threadId: string): FakeStore {
  let store = agentStores.get(threadId);
  if (!store) {
    store = { messages: [] };
    agentStores.set(threadId, store);
  }
  return store;
}

/** Forget every thread and run between tests. */
export function resetCopilotFake(): void {
  agentStores.clear();
  bumps.clear();
  runCalls.length = 0;
}

/**
 * The module factory. Pass it straight to `mock.module("@copilotkit/react-core/v2", ...)`.
 *
 * Real exports are spread through: only the hooks that would reach a live runtime are replaced.
 */
export function copilotFake() {
  return {
    ...ActualCopilot,
    UseAgentUpdate: {
      OnMessagesChanged: "messages",
      OnRunStatusChanged: "runs",
    },
    useAgent: (opts: { threadId?: string }) => {
      // A caller with no thread of its own still gets an agent; it just shares the unnamed one.
      const key = opts.threadId ?? "sem-thread";
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
  };
}
