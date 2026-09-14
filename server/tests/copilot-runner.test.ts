import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { DurableAgentRunner } from "../src/copilot-runner";
import type { Database } from "../src/db/client";

/**
 * The durable runner against the real InMemoryAgentRunner contract.
 *
 * A fake AG-UI agent drives real runs: one subscription per run, one
 * execution, and the persistence subscription outliving the SSE watcher. A
 * fake database stands in for PostgreSQL with explicitly gated writes instead
 * of wall-clock delays: a test holds a write open, finishes a newer turn, and
 * then releases the old write to prove per-thread chaining keeps newest-last.
 * Cross-process restart is approximated by seeding rows the runner never wrote
 * and by rebuilding the runner over the same store.
 */

type Row = { threadId: string; agentId: string; messages: unknown };

type WriteControl = {
  failWrites: boolean;
  /** One gate per write, in order; a write with no gate proceeds at once. */
  gates: PromiseWithResolvers<void>[];
  /** Observed by the test to await a write starting, without timers. */
  started: PromiseWithResolvers<void>[];
};

function makeFakeDb(store: Map<string, Row>, control: WriteControl) {
  const db = {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        orderBy: (_order: unknown) => ({
          limit: async (_n: number) =>
            [...store.values()].map((row) => ({
              threadId: row.threadId,
              messages: row.messages,
            })),
        }),
        where: (_cond: unknown) => ({
          limit: async (_n: number) => {
            const row = store.get(selectedThread);
            return row ? [{ messages: row.messages }] : [];
          },
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (value: {
        threadId: string;
        agentId: string;
        messages: unknown;
      }) => ({
        onConflictDoUpdate: (_conflict: unknown) => {
          const started = control.started.shift();
          const gate = control.gates.shift();
          return (async () => {
            started?.resolve();
            if (gate) await gate.promise;
            if (control.failWrites) throw new Error("postgres is down");
            store.set(value.threadId, {
              threadId: value.threadId,
              agentId: value.agentId,
              messages: value.messages,
            });
          })();
        },
      }),
    }),
  };
  // The fake where() cannot evaluate drizzle conditions; each test names the
  // thread its selects are for.
  let selectedThread = "";
  const handle = db as unknown as Database & {
    forThread: (id: string) => void;
  };
  handle.forThread = (id: string) => {
    selectedThread = id;
  };
  return handle;
}

function threadId() {
  return `runner-test-${randomUUID()}`;
}

type FakeAgent = {
  agentId: string;
  messages: Message[];
  runAgentCalls: number;
  gate: PromiseWithResolvers<void> | null;
  failWith: string | null;
  runAgent: (
    input: unknown,
    callbacks: { onEvent: (event: unknown) => void },
  ) => Promise<void>;
};

function makeAgent(): FakeAgent {
  const agent: FakeAgent = {
    agentId: "test-bot",
    messages: [],
    runAgentCalls: 0,
    gate: null,
    failWith: null,
    async runAgent(_input, callbacks) {
      agent.runAgentCalls += 1;
      if (agent.gate) await agent.gate.promise;
      // Like every real agent: the run opens with an event, so an
      // interruption later still finalizes a run rather than nothing.
      callbacks.onEvent({ event: { type: "RUN_STARTED" } });
      if (agent.failWith) throw new Error(agent.failWith);
      agent.messages.push({
        id: `a-${agent.runAgentCalls}`,
        role: "assistant",
        content: "done",
      } as Message);
    },
  };
  return agent;
}

function runRequest(id: string, agent: FakeAgent, runId: string) {
  return {
    threadId: id,
    agent,
    input: { threadId: id, runId, messages: agent.messages },
  } as unknown as Parameters<DurableAgentRunner["run"]>[0];
}

function userMessage(id: string, content: string): Message {
  return { id, role: "user", content } as Message;
}

function emptyControl(): WriteControl {
  return { failWrites: false, gates: [], started: [] };
}

describe("persisting a run past its watcher", () => {
  test("a turn that finishes after disconnect is still written", async () => {
    const store = new Map<string, Row>();
    const control = emptyControl();
    const wrote = Promise.withResolvers<void>();
    control.started.push(wrote);
    const runner = new DurableAgentRunner(makeFakeDb(store, control));
    const id = threadId();
    const agent = makeAgent();
    agent.messages.push(userMessage("u1", "hi"));
    agent.gate = Promise.withResolvers<void>();

    // Disconnect before the turn finishes: forwarding ends, durability must not.
    const subscription = runner
      .run(runRequest(id, agent, `run-${id}`))
      .subscribe({});
    subscription.unsubscribe();
    agent.gate.resolve();
    await wrote.promise;
    await runner.flush();

    const row = store.get(id);
    expect(agent.runAgentCalls).toBe(1);
    expect(row).toBeDefined();
    expect(JSON.stringify(row?.messages)).toContain("hi");
    expect(JSON.stringify(row?.messages)).toContain("done");
  });

  test("a failed turn keeps what it said before breaking", async () => {
    const store = new Map<string, Row>();
    const control = emptyControl();
    const wrote = Promise.withResolvers<void>();
    control.started.push(wrote);
    const runner = new DurableAgentRunner(makeFakeDb(store, control));
    const id = threadId();
    const agent = makeAgent();
    agent.messages.push(userMessage("u1", "hi"));
    agent.failWith = "Codex exited with code 1";

    // The runtime finalizes an interrupted run as a completion carrying the
    // interruption, not as an observable error: persistence rides completion.
    const errors: unknown[] = [];
    let completed = false;
    runner.run(runRequest(id, agent, `run-${id}`)).subscribe({
      error: (error: unknown) => errors.push(error),
      complete: () => {
        completed = true;
      },
    });
    await wrote.promise;
    await runner.flush();

    expect(errors).toHaveLength(0);
    expect(completed).toBe(true);
    expect(store.get(id)).toBeDefined();
  });

  test("a held write cannot overtake the newer turn behind it", async () => {
    const store = new Map<string, Row>();
    const firstWrite = Promise.withResolvers<void>();
    const control = emptyControl();
    control.gates.push(firstWrite);
    const runner = new DurableAgentRunner(makeFakeDb(store, control));
    const id = threadId();
    const first = makeAgent();
    first.messages.push(userMessage("u1", "one"));
    const firstDone = Promise.withResolvers<void>();
    runner.run(runRequest(id, first, `run-1-${id}`)).subscribe({
      complete: () => firstDone.resolve(),
    });
    await firstDone.promise;

    // The first write is held open while a newer turn finishes behind it.
    const second = makeAgent();
    second.messages.push(userMessage("u1", "one"));
    second.messages.push(userMessage("u2", "two"));
    const secondDone = Promise.withResolvers<void>();
    runner.run(runRequest(id, second, `run-2-${id}`)).subscribe({
      complete: () => secondDone.resolve(),
    });
    await secondDone.promise;
    firstWrite.resolve();
    await runner.flush();

    // Per-thread chaining: the released old write lands before the newer one
    // queued behind it, so a rebuilt runner reads the newest turn.
    expect(JSON.stringify(store.get(id)?.messages)).toContain("two");
  });

  test("flush rejects a failed write instead of reporting success", async () => {
    const store = new Map<string, Row>();
    const control = emptyControl();
    control.failWrites = true;
    const runner = new DurableAgentRunner(makeFakeDb(store, control));
    const id = threadId();
    const agent = makeAgent();
    agent.messages.push(userMessage("u1", "hi"));
    const done = Promise.withResolvers<void>();
    runner.run(runRequest(id, agent, `run-${id}`)).subscribe({
      complete: () => done.resolve(),
    });
    await done.promise;
    await expect(runner.flush()).rejects.toThrow("postgres is down");
    expect(store.get(id)).toBeUndefined();
  });

  test("hydrate reads a thread the cache never preloaded", async () => {
    const store = new Map<string, Row>();
    const id = threadId();
    store.set(id, {
      threadId: id,
      agentId: "test-bot",
      messages: {
        messages: [{ id: "old", role: "user", content: "before the restart" }],
      },
    });
    const db = makeFakeDb(store, emptyControl());
    db.forThread(id);
    const runner = new DurableAgentRunner(db);
    await expect(runner.hydrate(id)).resolves.toEqual([
      { id: "old", role: "user", content: "before the restart" },
    ]);
  });

  test("hydrate rejects when the database is down", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw new Error("connection refused");
            },
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => Promise.resolve(),
        }),
      }),
    } as unknown as Database;
    const runner = new DurableAgentRunner(db);
    await expect(runner.hydrate(threadId())).rejects.toThrow();
  });
});
