import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRunRow } from "../src/agent-runs/repository";
import type { CreateRunInput } from "../src/agent-runs/types";
import { createDatabase } from "../src/db/client";
import { agents, sectorRoutines, sectors } from "../src/db/schema";
import { createRoutineScheduler } from "../src/sectors/scheduler";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  TEST_POOL,
);

const createdKeys = new Set<string>();
const calls: CreateRunInput[] = [];

const scheduler = createRoutineScheduler({
  database,
  createRun: async (_actor, input) => {
    calls.push(input);
    const key = input.idempotencyKey ?? "";
    const created = !createdKeys.has(key);
    createdKeys.add(key);
    return { run: { id: `run-${key}` } as AgentRunRow, created };
  },
  now: () => new Date("2026-09-13T09:00:00Z"),
});

afterEach(async () => {
  calls.length = 0;
  createdKeys.clear();
  await database.delete(sectorRoutines);
});

async function seedRoutine(overrides: Partial<typeof sectorRoutines.$inferInsert> = {}) {
  await database
    .insert(sectors)
    .values({ id: "livelab", name: "LiveLab" })
    .onConflictDoNothing({ target: sectors.id });
  await database
    .insert(agents)
    .values({
      id: "bot-livelab",
      name: "LiveLab",
      type: "built_in",
      configuration: {},
    })
    .onConflictDoNothing({ target: agents.id });
  await database.insert(sectorRoutines).values({
    id: overrides.id ?? "routine-morning",
    sectorId: "livelab",
    botId: "bot-livelab",
    name: "Morning check",
    objective: "Check yesterday's sales and report.",
    intervalMinutes: 24 * 60,
    ...overrides,
  });
}

describe("sector routines", () => {
  test("a due routine enqueues one scheduled run", async () => {
    await seedRoutine();
    expect(await scheduler()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.origin).toBe("schedule");
    expect(calls[0]?.botId).toBe("bot-livelab");
    expect(calls[0]?.idempotencyKey).toMatch(/^routine:routine-morning:/);
    expect(calls[0]?.metadata).toMatchObject({
      routineId: "routine-morning",
      sectorId: "livelab",
    });
  });

  test("the same slot is not enqueued twice", async () => {
    await seedRoutine();
    expect(await scheduler()).toBe(1);
    // lastEnqueuedAt moved, so the second pass finds nothing due.
    expect(await scheduler()).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("a routine enqueued recently waits its interval", async () => {
    await seedRoutine({
      lastEnqueuedAt: new Date("2026-09-13T08:00:00Z"),
    });
    expect(await scheduler()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a disabled routine never runs", async () => {
    await seedRoutine({ id: "routine-off", enabled: false });
    expect(await scheduler()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
