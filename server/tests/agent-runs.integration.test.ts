/**
 * The durable task core, against a real database.
 *
 * These are the properties the rest of the runtime is allowed to assume: one owner per run, one
 * owner per browser profile, steps and events that are numbered without gaps, an idempotency key
 * that means one task, and a recovery that never resumes blind.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, ne } from "drizzle-orm";
import { createAgentRunRepository } from "../src/agent-runs/repository";
import { createAgentRunService } from "../src/agent-runs/service";
import { createAgentRunWorker } from "../src/agent-runs/worker";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agentRuns, browserProfileLeases } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  TEST_POOL,
);

const repository = createAgentRunRepository(database);
const service = createAgentRunService({
  repository,
  auditStore: createAuditStore(database),
  defaults: {
    provider: "test-provider",
    model: "test-model",
    budget: { maxSteps: 10, maxMs: 60_000, maxCorrections: 1 },
    leaseTtlMs: 30_000,
  },
});

const created: string[] = [];

async function newRun(
  overrides: Partial<{
    botId: string;
    objective: string;
    idempotencyKey: string;
    origin: "web" | "telegram" | "api";
  }> = {},
) {
  const { run } = await service.createRun(
    { id: "user-under-test" },
    {
      botId: overrides.botId ?? "bot-under-test",
      userId: "user-under-test",
      origin: overrides.origin ?? "web",
      objective: overrides.objective ?? "Abrir a página e relatar.",
      ...(overrides.idempotencyKey
        ? { idempotencyKey: overrides.idempotencyKey }
        : {}),
    },
    "user-under-test",
  );
  created.push(run.id);
  return run;
}

async function countRunsWithKey(key: string): Promise<number> {
  const rows = await database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.idempotencyKey, key));
  return rows.length;
}

/**
 * Leave nothing for the next test to trip over.
 *
 * The worker picks up any queued run in the table, so a test that leaves one behind would be
 * executed by the next test's worker — which is a real behaviour of the product and a foot-gun in a
 * shared database. Runs created here are parked, and leases are dropped.
 */
afterEach(async () => {
  if (!created.length) return;
  await database
    .update(agentRuns)
    .set({ status: "paused" })
    .where(and(inArray(agentRuns.id, created), eq(agentRuns.status, "queued")));
  await database
    .delete(browserProfileLeases)
    .where(inArray(browserProfileLeases.profileId, ["profile-a", "profile-b"]));
});

afterAll(async () => {
  if (created.length) {
    await database.delete(agentRuns).where(inArray(agentRuns.id, created));
  }
  await database
    .delete(browserProfileLeases)
    .where(inArray(browserProfileLeases.profileId, ["profile-a", "profile-b"]));
});

describe("durable runs", () => {
  test("creates a queued run with its budget and its first event", async () => {
    const run = await newRun();
    expect(run.status).toBe("queued");
    expect(run.provider).toBe("test-provider");
    expect(run.model).toBe("test-model");
    expect(run.budget).toEqual({
      maxSteps: 10,
      maxMs: 60_000,
      maxCorrections: 1,
    });

    const events = await service.events(run.id, 0);
    expect(events.map((event) => event.type)).toEqual(["run.created"]);
  });

  test("the same idempotency key is one task", async () => {
    const key = `key-${crypto.randomUUID()}`;
    const first = await newRun({ idempotencyKey: key });
    const second = await service.createRun(
      { id: "user-under-test" },
      {
        botId: "bot-under-test",
        userId: "user-under-test",
        origin: "telegram",
        objective: "A mesma mensagem entregue de novo.",
        idempotencyKey: key,
      },
      "user-under-test",
    );
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.id);
    expect(await countRunsWithKey(key)).toBe(1);
  });
});

describe("the state machine", () => {
  test("pause and resume move a run and record both ends", async () => {
    const run = await newRun();
    const paused = await service.pause(run.id, { id: "user-under-test" });
    expect(paused.status).toBe("paused");
    const resumed = await service.resume(run.id, { id: "user-under-test" });
    expect(resumed.status).toBe("queued");

    const events = await service.events(run.id, 0);
    const changes = events.filter(
      (event) => event.type === "run.status_changed",
    );
    expect(changes.length).toBe(2);
    expect(changes[0]?.payload).toMatchObject({
      from: "queued",
      to: "paused",
    });
    expect(changes[1]?.payload).toMatchObject({
      from: "paused",
      to: "queued",
    });
  });

  test("refuses a transition the state does not allow", async () => {
    const run = await newRun();
    await repository.updateStatus(run.id, ["queued"], "succeeded");
    await expect(
      service.resume(run.id, { id: "user-under-test" }),
    ).rejects.toThrow("cannot be resumed");
    await expect(
      service.pause(run.id, { id: "user-under-test" }),
    ).rejects.toThrow("cannot be paused");
  });

  test("cancel is final", async () => {
    const run = await newRun();
    const cancelled = await service.cancel(run.id, { id: "user-under-test" });
    expect(cancelled.status).toBe("cancelled");
    await expect(
      service.cancel(run.id, { id: "user-under-test" }),
    ).rejects.toThrow("cannot be cancelled");
  });
});

describe("leases", () => {
  test("a run has one owner at a time, and the loss of a lease is visible", async () => {
    const run = await newRun();
    const first = await repository.claim(run.id, "worker-a", 30_000);
    expect(first?.status).toBe("running");
    expect(first?.leaseGeneration).toBe(1);

    // A second worker does not get the same run while the first holds it.
    expect(await repository.claim(run.id, "worker-b", 30_000)).toBeUndefined();

    // The old owner's generation no longer writes: the run was taken over by nobody, so generation
    // one still holds — but a stale generation must be refused all the same.
    expect(
      await repository.updateOwned(run.id, "worker-a", 0, { status: "failed" }),
    ).toBeUndefined();
    expect(await repository.renewLease(run.id, "worker-b", 1, 30_000)).toBe(
      false,
    );

    await repository.releaseLease(run.id, "worker-a", 1);
    // Back to queued, as a resume or a recovery would leave it; then the next worker claims it and
    // the generation moves on, which is what stops the old owner writing afterwards.
    await repository.updateStatus(run.id, ["running"], "queued");
    const second = await repository.claim(run.id, "worker-b", 30_000);
    expect(second?.leaseGeneration).toBe(2);
  });

  test("an expired lease is recovered and claimed again", async () => {
    const run = await newRun();
    await repository.claim(run.id, "worker-a", 30_000);
    await database
      .update(agentRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(agentRuns.id, run.id));
    // The run says it is running, so the normal claim refuses it; recovery is what moves it first.
    expect(await repository.claim(run.id, "worker-b", 30_000)).toBeUndefined();
    expect(await service.recoverExpired()).toBeGreaterThan(0);
    // No recorded external effect, so it goes back to the queue rather than to a person.
    const row = await repository.get(run.id);
    expect(row?.status).toBe("queued");
    const reclaimed = await repository.claim(run.id, "worker-b", 30_000);
    expect(reclaimed?.leaseGeneration).toBe(2);
  });

  test("a recovered run with an uncertain effect waits for a person", async () => {
    const run = await newRun();
    await repository.claim(run.id, "worker-a", 30_000);
    await database
      .update(agentRuns)
      .set({
        leaseExpiresAt: new Date(Date.now() - 1_000),
        checkpoint: { effect: "uncertain", stepSeq: 3 },
      })
      .where(eq(agentRuns.id, run.id));
    await service.recoverExpired();
    const row = await repository.get(run.id);
    expect(row?.status).toBe("needs_reconciliation");
    // And the worker does not pick it up on its own.
    expect(await repository.claim(run.id, "worker-b", 30_000)).toBeUndefined();
  });

  test("a profile has one owner at a time", async () => {
    const run = await newRun();
    const first = await repository.acquireProfileLease({
      profileId: "profile-a",
      runId: run.id,
      owner: "worker-a",
      ttlMs: 30_000,
    });
    expect(first?.generation).toBe(1);
    expect(
      await repository.acquireProfileLease({
        profileId: "profile-a",
        runId: crypto.randomUUID(),
        owner: "worker-b",
        ttlMs: 30_000,
      }),
    ).toBeUndefined();
    await repository.releaseProfileLease({
      profileId: "profile-a",
      owner: "worker-a",
      generation: 1,
    });
    const second = await repository.acquireProfileLease({
      profileId: "profile-a",
      runId: run.id,
      owner: "worker-b",
      ttlMs: 30_000,
    });
    expect(second?.generation).toBe(2);
    await repository.releaseProfileLease({
      profileId: "profile-a",
      owner: "worker-b",
      generation: 2,
    });
  });
});

describe("steps and events", () => {
  test("number without gaps and are readable from a cursor", async () => {
    const run = await newRun();
    const first = await repository.allocateStep(run.id);
    const second = await repository.allocateStep(run.id);
    expect([first, second]).toEqual([1, 2]);
    await repository.appendStep({
      runId: run.id,
      seq: first,
      kind: "observation",
      status: "ok",
      startedAt: new Date(),
    });
    await repository.appendStep({
      runId: run.id,
      seq: second,
      kind: "decision",
      status: "ok",
      startedAt: new Date(),
    });
    const steps = await service.steps(run.id);
    expect(steps.map((step) => step.seq)).toEqual([1, 2]);

    await repository.appendEvent(run.id, "note", { text: "um" });
    await repository.appendEvent(run.id, "note", { text: "dois" });
    const events = await service.events(run.id, 1);
    expect(events.map((event) => event.payload.text)).toEqual(["um", "dois"]);
  });
});

describe("a fair queue", () => {
  test("a bot that floods the queue takes every Nth slot, not the head", async () => {
    const flood: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      flood.push((await newRun({ botId: "bot-flood" })).id);
    }
    const lone = await newRun({ botId: "bot-lone" });
    const order = (await repository.queued(4)).map((row) => row.id);
    // Round-robin by per-Bot position: flood#1, lone#1, flood#2, flood#3.
    expect(order).toEqual([flood[0], lone.id, flood[1], flood[2]]);
  });

  test("a lone bot's runs still come out oldest-first", async () => {
    const first = await newRun({ botId: "bot-solo" });
    const second = await newRun({ botId: "bot-solo" });
    const order = (await repository.queued(50))
      .filter((row) => row.botId === "bot-solo")
      .map((row) => row.id);
    expect(order.slice(0, 2)).toEqual([first.id, second.id]);
  });
});

describe("the worker", () => {
  /**
   * The worker takes any queued run in the table, which is what it is for. A test that leaves one
   * behind would have it executed by the next test's worker, so the queue is emptied of everything
   * but the run under test before each tick here.
   */
  async function onlyQueued(runId: string): Promise<void> {
    await database
      .update(agentRuns)
      .set({ status: "paused" })
      .where(and(eq(agentRuns.status, "queued"), ne(agentRuns.id, runId)));
  }

  test("claims a queued run and lets its executor settle it", async () => {
    const run = await newRun();
    await onlyQueued(run.id);
    const seen: string[] = [];
    const worker = createAgentRunWorker({
      repository,
      service,
      owner: "test-worker",
      pollMs: 60_000,
      leaseTtlMs: 30_000,
      execute: async (request) => {
        seen.push(request.runId);
        const row = await repository.get(request.runId);
        await repository.updateOwned(
          request.runId,
          request.owner,
          request.generation,
          {
            status: "succeeded",
            finishedAt: new Date(),
            usage: {
              steps: 1,
              activeMs: 10,
              modelCalls: 1,
              toolCalls: 0,
            },
          },
        );
        expect(row?.status).toBe("running");
      },
    });
    await worker.tick();
    await worker.stop();
    expect(seen).toEqual([run.id]);
    const row = await repository.get(run.id);
    expect(row?.status).toBe("succeeded");
    expect(row?.leaseOwner).toBeNull();
  });

  test("fails a run whose executor returned without settling it", async () => {
    const run = await newRun();
    await onlyQueued(run.id);
    const worker = createAgentRunWorker({
      repository,
      service,
      owner: "test-worker",
      pollMs: 60_000,
      leaseTtlMs: 30_000,
      execute: async () => undefined,
    });
    await worker.tick();
    await worker.stop();
    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    expect((row?.error as { code?: string } | null)?.code).toBe("INTERNAL");
  });

  test("does not touch a run that is waiting on a person", async () => {
    const run = await newRun();
    await repository.updateStatus(run.id, ["queued"], "waiting_human");
    await onlyQueued(run.id);
    const worker = createAgentRunWorker({
      repository,
      service,
      owner: "test-worker",
      pollMs: 60_000,
      leaseTtlMs: 30_000,
      execute: async () => {
        throw new Error("A run waiting on a person was executed.");
      },
    });
    expect(await worker.tick()).toBe(0);
    await worker.stop();
    expect((await repository.get(run.id))?.status).toBe("waiting_human");
  });

  test("limits active runs and leaves excess work queued", async () => {
    const first = await newRun({ botId: "concurrent-a" });
    await onlyQueued(first.id);
    const second = await newRun({ botId: "concurrent-b" });
    const third = await newRun({ botId: "concurrent-c" });
    const gate = Promise.withResolvers<void>();
    const worker = createAgentRunWorker({
      repository,
      service,
      owner: "concurrency-worker",
      pollMs: 60_000,
      leaseTtlMs: 30_000,
      concurrency: 2,
      execute: async (request) => {
        await gate.promise;
        await repository.updateOwned(
          request.runId,
          request.owner,
          request.generation,
          {
            status: "succeeded",
            finishedAt: new Date(),
          },
        );
      },
    });
    try {
      await worker.tick();
      expect((await repository.get(first.id))?.status).toBe("running");
      expect((await repository.get(second.id))?.status).toBe("running");
      expect((await repository.get(third.id))?.status).toBe("queued");
      expect(await worker.tick()).toBe(0);
      expect((await repository.get(third.id))?.status).toBe("queued");
    } finally {
      gate.resolve();
      await worker.stop();
    }
    expect((await repository.get(first.id))?.status).toBe("succeeded");
    expect((await repository.get(second.id))?.status).toBe("succeeded");
  });
});
