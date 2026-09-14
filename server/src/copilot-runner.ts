import type { BaseEvent, Message } from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { desc, eq } from "drizzle-orm";
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

function storedMessages(value: unknown): Message[] {
  if (typeof value !== "object" || value === null || !("messages" in value)) {
    return [];
  }
  const messages: unknown = value.messages;
  if (!Array.isArray(messages)) return [];
  // Rows are written by the runner below as Message arrays; read back as such.
  const typed: Message[] = messages as Message[];
  return typed;
}

/**
 * The stored envelope, validated enough to hand to the client.
 *
 * Only the envelope: per-message validation lives in the browser's
 * `normalizeThreadMessages`, which fails the load closed rather than reading
 * an empty conversation. A row that is not an envelope at all throws here so
 * a corrupt row answers 503 instead of truncating somebody's history.
 */
function validatedStoredMessages(value: unknown): Message[] {
  if (typeof value !== "object" || value === null || !("messages" in value)) {
    throw new Error("Local thread history row is invalid.");
  }
  const messages: unknown = value.messages;
  if (!Array.isArray(messages)) {
    throw new Error("Local thread history row is invalid.");
  }
  // Envelope checked above; per-message shape is the client's boundary to judge.
  const typed: Message[] = messages as Message[];
  return typed;
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
  /**
   * One chain of writes per thread, newest last.
   *
   * Chained per thread rather than fired globally so a slow write for an old
   * turn can never land after a fast write for the turn that replaced it. The
   * stored promise rejects when its write fails: `flush` observes that, and an
   * early `catch` keeps it from surfacing as an unhandled rejection first.
   */
  private readonly pendingWrites = new Map<string, Promise<void>>();

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

  /**
   * A thread's durable messages, on demand rather than only the preloaded 500.
   *
   * Waits out that thread's pending write first so a turn that just finished
   * reads back what it wrote. Live memory wins, then cache, then the table. A
   * missing row answers empty; an unreachable database rejects. Misses are
   * never cached, so an error can never settle into a phantom empty thread.
   */
  async hydrate(threadId: string): Promise<Message[]> {
    const pending = this.pendingWrites.get(threadId);
    if (pending) await pending.catch(() => {});

    const live = super.getThreadMessages(threadId);
    if (live.length > 0) return structuredClone(live);
    return structuredClone(await this.durableMessages(threadId));
  }

  /**
   * What the cache or the table holds for a thread, without waiting on its
   * pending writes.
   *
   * Separate from `hydrate` because a write already queued on this thread
   * reads through here from inside that queue, where waiting for the pending
   * write would be waiting for itself. Anything outside the queue wants
   * `hydrate`. Misses are never cached, so a failed read cannot settle into a
   * phantom empty thread.
   */
  private async durableMessages(threadId: string): Promise<Message[]> {
    const cached = this.cache.get(threadId);
    if (cached) return cached;
    let rows: { messages: unknown }[];
    try {
      rows = await this.database
        .select({ messages: localThreadHistory.messages })
        .from(localThreadHistory)
        .where(eq(localThreadHistory.threadId, threadId))
        .limit(1);
    } catch (error) {
      console.error(
        `Thread ${threadId} could not be read from local history.`,
        error,
      );
      throw error;
    }
    const row = rows[0];
    if (!row) return [];
    const messages = validatedStoredMessages(row.messages);
    this.cache.set(threadId, structuredClone(messages));
    return messages;
  }

  /**
   * Wait out every pending write. Call on graceful shutdown.
   *
   * Rejects when a write failed rather than reporting success: the caller
   * decides what a lost turn is worth on the way out. Says nothing about
   * SIGKILL, which keeps no promises.
   */
  async flush(): Promise<void> {
    await Promise.all([...this.pendingWrites.values()]);
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const stream = super.run(request);
    const { threadId } = request;
    // Recorded so an operator reading the table can tell which Bot a thread belongs to. Optional on
    // the agent, so a Bot that does not carry one is stored as the empty string rather than refused.
    const agentId = request.agent.agentId ?? "";
    /*
     * The messages the request arrived with, held for the run that dies before
     * the agent emits anything: the parent has recorded nothing by then, so the
     * snapshot is empty and the person's message would go down with the
     * failure — present in the sidebar, absent from the conversation after a
     * reload. Cloned because the caller's array keeps moving.
     */
    const rescue = structuredClone(
      request.persistedInputMessages ?? request.input.messages,
    );

    /*
     * ONE subscription to the run, owned by durability rather than by the
     * socket. It forwards events to whoever is watching and persists when the
     * run itself finishes — which can be after the watcher is gone. Closing
     * the browser tab ends the forwarding and nothing else: explicitly no
     * persist-on-unsubscribe, which would write a stale mid-run snapshot over
     * the finished turn that lands a moment later.
     *
     * The consumer never subscribes to `stream` itself, so this cannot start
     * a second execution: one subscription, one run.
     */
    return new Observable<BaseEvent>((subscriber) => {
      let open = true;
      const persistence = stream.subscribe({
        next: (event) => {
          if (open) subscriber.next(event);
        },
        /*
         * Persisted on error as well as on completion. A run that fails part-way still produced the
         * person's message and whatever the Bot said before it broke, and losing that on restart
         * would make a failure look like the turn never happened.
         */
        error: (error: unknown) => {
          this.schedulePersist(threadId, agentId, rescue);
          if (!open) return;
          open = false;
          subscriber.error(error);
        },
        complete: () => {
          this.schedulePersist(threadId, agentId, rescue);
          if (!open) return;
          open = false;
          subscriber.complete();
        },
      });

      return () => {
        // Stop forwarding. The persistence subscription above stays alive
        // until the run finalizes; unsubscribing it here is what used to drop
        // turns closed by disconnecting.
        open = false;
        void persistence;
      };
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
   * Queue this thread's current snapshot behind its earlier writes.
   *
   * The snapshot is cloned at finalize time: the live array keeps moving and
   * the write happens later, so holding the reference would store whatever it
   * happens to hold when the write runs rather than what the run produced.
   *
   * An empty snapshot means the parent recorded nothing, which is the run that
   * broke before its first event. There is no turn to store, but somebody did
   * type something: `rescue` carries the request's own messages, and those are
   * merged into the stored history rather than dropped with the failure.
   */
  private schedulePersist(
    threadId: string,
    agentId: string,
    rescue: Message[] = [],
  ): void {
    const snapshot = structuredClone(super.getThreadMessages(threadId));
    if (snapshot.length === 0) {
      if (rescue.length > 0) {
        this.queueWrite(threadId, () =>
          this.writeRescued(threadId, agentId, rescue),
        );
      }
      return;
    }

    this.cache.set(threadId, structuredClone(snapshot));
    this.queueWrite(threadId, () => this.writeRow(threadId, agentId, snapshot));
  }

  /**
   * Store what a failed request carried, on top of what is already there.
   *
   * Reads the durable history instead of writing the request by itself: the row
   * holds the whole thread, and a failure must not shorten it. Only messages
   * the history lacks are appended, so retrying the same broken turn does not
   * stack copies and a request that adds nothing writes nothing.
   */
  private async writeRescued(
    threadId: string,
    agentId: string,
    rescue: Message[],
  ): Promise<void> {
    const durable = await this.durableMessages(threadId);
    const known = new Set(durable.map((message) => message.id));
    const added = rescue.filter((message) => !known.has(message.id));
    if (added.length === 0) return;

    const merged = [...durable, ...added];
    this.cache.set(threadId, structuredClone(merged));
    await this.writeRow(threadId, agentId, merged);
  }

  /**
   * Chain one write behind this thread's earlier ones.
   *
   * Per-thread ordering is the point: a turn that finalizes later must not land
   * underneath an older snapshot. A rejected write breaks this thread's chain,
   * which is what `flush` reports on the way out.
   */
  private queueWrite(threadId: string, write: () => Promise<void>): void {
    const previous = this.pendingWrites.get(threadId) ?? Promise.resolve();
    const next = previous.then(write);
    this.pendingWrites.set(threadId, next);
    // Observed by `flush`; kept from surfacing as an unhandled rejection first.
    next.catch(() => {});
    const forget = () => {
      if (this.pendingWrites.get(threadId) === next) {
        this.pendingWrites.delete(threadId);
      }
    };
    void next.then(forget, forget);
  }

  /**
   * Write one snapshot. Failures are logged without message content and
   * rethrown so `flush` reports them instead of swallowing them into success.
   */
  private async writeRow(
    threadId: string,
    agentId: string,
    messages: Message[],
  ): Promise<void> {
    try {
      await this.database
        .insert(localThreadHistory)
        .values({ threadId, agentId, messages: { messages } })
        .onConflictDoUpdate({
          target: localThreadHistory.threadId,
          set: { messages: { messages }, updatedAt: new Date() },
        });
    } catch (error: unknown) {
      console.error(
        `Thread ${threadId} could not be written to local history; it will not survive a restart.`,
        error,
      );
      throw error;
    }
  }
}
