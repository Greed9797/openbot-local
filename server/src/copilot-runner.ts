import type { BaseEvent, Message } from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { desc } from "drizzle-orm";
import { Observable } from "rxjs";
import type { Database } from "./db/client";
import { localThreadHistory } from "./db/schema/core";

/**
 * How many threads are read back at boot.
 *
 * ponytail: a warm cache of the most recently touched threads, not the whole table. The runtime asks
 * for a thread's messages synchronously (`getThreadMessages` returns `Message[]`, not a promise), so
 * a read cannot go to PostgreSQL at request time and whatever answers it has to already be in
 * memory. Bounding that at the newest N threads keeps the resident set predictable on a small VPS.
 * A thread older than the cut still exists in the table and is never lost; it just answers empty
 * until it is written to again. Raise this, or move to a per-request async read behind the thread
 * endpoints, if somebody needs to scroll back through more than this many conversations.
 */
const PRELOAD_THREADS = 500;

type StoredHistory = { messages: Message[] };

function storedMessages(value: unknown): Message[] {
  const messages = (value as StoredHistory | null)?.messages;
  return Array.isArray(messages) ? messages : [];
}

/**
 * The in-memory runner, plus a copy in this deployment's own database.
 *
 * The SSE runtime keeps thread history in process memory, which is the right default for a laptop
 * and the wrong one for a deployment that is meant to stay up: a restart would take every
 * conversation with it. This subclass changes nothing about how a run executes. It watches each run
 * to its end, writes the message snapshot the parent already computed, and answers a read from its
 * own cache when the parent has nothing — which is exactly the state a fresh process is in.
 *
 * Only messages are persisted. AG-UI events stay in memory and are lost on restart, so the
 * inspector's event replay is empty for a thread that predates the current process while the
 * conversation itself is intact. Events are large, they are a debugging surface rather than a
 * product one, and nothing in the chat depends on them.
 */
export class DurableAgentRunner extends InMemoryAgentRunner {
  private readonly cache = new Map<string, Message[]>();

  constructor(private readonly database: Database) {
    /*
     * A follow-up turn on a thread that still has a run in flight replaces it rather than being
     * refused. The default ("throw") answers a fast second message with "Thread already running",
     * which on a shared deployment is a person clicking send twice, not a bug to surface.
     */
    super({ onConcurrentRun: "supersede" });
  }

  /** Read the recent threads back into memory. Call once, before the runtime is mounted. */
  async preload(): Promise<number> {
    const rows = await this.database
      .select({
        threadId: localThreadHistory.threadId,
        messages: localThreadHistory.messages,
      })
      .from(localThreadHistory)
      .orderBy(desc(localThreadHistory.updatedAt))
      .limit(PRELOAD_THREADS);

    for (const row of rows) {
      this.cache.set(row.threadId, storedMessages(row.messages));
    }

    return this.cache.size;
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const stream = super.run(request);
    const { threadId } = request;
    // Recorded so an operator reading the table can tell which Bot a thread belongs to. Optional on
    // the agent, so a Bot that does not carry one is stored as the empty string rather than refused.
    const agentId = request.agent.agentId ?? "";

    return new Observable<BaseEvent>((subscriber) => {
      const subscription = stream.subscribe({
        next: (event) => subscriber.next(event),
        /*
         * Persisted on error as well as on completion. A run that fails part-way still produced the
         * person's message and whatever the Bot said before it broke, and losing that on restart
         * would make a failure look like the turn never happened.
         */
        error: (error) => {
          this.persist(threadId, agentId);
          subscriber.error(error);
        },
        complete: () => {
          this.persist(threadId, agentId);
          subscriber.complete();
        },
      });

      return () => subscription.unsubscribe();
    });
  }

  override getThreadMessages(threadId: string): Message[] {
    const live = super.getThreadMessages(threadId);
    if (live.length > 0) {
      return live;
    }
    return this.cache.get(threadId) ?? [];
  }

  override clearThreads(): void {
    super.clearThreads();
    this.cache.clear();
    /*
     * Deliberately not deleting the rows. `POST /threads/clear` is a client-side reset button, and a
     * button in a chat window is not an instrument for erasing a deployment's record of what was
     * said. The rows are removed by whoever administers the database.
     */
  }

  /**
   * Write the thread's current snapshot.
   *
   * Fire-and-forget on purpose: this runs inside a stream teardown, where a rejected promise would
   * surface as an unhandled rejection and a slow write would hold the response open. A failed write
   * costs this thread's durability across the next restart and nothing else, so it is logged and the
   * run is left alone.
   */
  private persist(threadId: string, agentId: string): void {
    const messages = super.getThreadMessages(threadId);
    if (messages.length === 0) {
      return;
    }

    this.cache.set(threadId, messages);

    void this.database
      .insert(localThreadHistory)
      .values({ threadId, agentId, messages: { messages } })
      .onConflictDoUpdate({
        target: localThreadHistory.threadId,
        set: { messages: { messages }, updatedAt: new Date() },
      })
      .catch((error: unknown) => {
        console.error(
          `Thread ${threadId} could not be written to local history; it will not survive a restart.`,
          error,
        );
      });
  }
}
