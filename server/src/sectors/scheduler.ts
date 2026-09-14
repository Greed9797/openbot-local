import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { AgentRunRow } from "../agent-runs/repository";
import type { RunActor } from "../agent-runs/service";
import type { CreateRunInput } from "../agent-runs/types";
import type { Database } from "../db/client";
import { sectorRoutines } from "../db/schema";

export type RoutineRow = typeof sectorRoutines.$inferSelect;

export type RoutineSchedulerDeps = {
  database: Database;
  createRun: (
    actor: RunActor,
    input: CreateRunInput,
    actorUserId: string | null,
  ) => Promise<{ run: AgentRunRow; created: boolean }>;
  /** Clock, so a test can hold time still. */
  now?: () => Date;
};

/**
 * Enqueue one run per due sector routine.
 *
 * Built for the worker's housekeeping tick: once a minute, in-process, no new service. Each routine
 * carries its own interval, and the idempotency key names the routine and its slot, so two
 * schedulers — or one tick running long — enqueue the same slot exactly once. A routine whose Bot is
 * gone is skipped, not failed: deleting a Bot must not break every other sector's morning.
 */
export function createRoutineScheduler(deps: RoutineSchedulerDeps) {
  const { database, createRun } = deps;
  const clock = deps.now ?? (() => new Date());

  return async function runDueRoutines(): Promise<number> {
    const now = clock();
    const due = await database
      .select()
      .from(sectorRoutines)
      .where(
        and(
          eq(sectorRoutines.enabled, true),
          or(
            isNull(sectorRoutines.lastEnqueuedAt),
            lte(
              sectorRoutines.lastEnqueuedAt,
              sql`(${now.toISOString()}::timestamptz - make_interval(mins => ${sectorRoutines.intervalMinutes}))`,
            ),
          ),
        ),
      );
    let enqueued = 0;
    for (const routine of due) {
      try {
        const slotMs = routine.intervalMinutes * 60_000;
        const slotStart = new Date(
          Math.floor(now.getTime() / slotMs) * slotMs,
        ).toISOString();
        const { created } = await createRun(
          { id: "routine-scheduler" },
          {
            botId: routine.botId,
            userId: null,
            origin: "schedule",
            objective: routine.objective,
            idempotencyKey: `routine:${routine.id}:${slotStart}`,
            metadata: { routineId: routine.id, sectorId: routine.sectorId },
          },
          null,
        );
        if (created) enqueued += 1;
        await database
          .update(sectorRoutines)
          .set({ lastEnqueuedAt: now, updatedAt: now })
          .where(eq(sectorRoutines.id, routine.id));
      } catch (error) {
        // One bad routine — a deleted Bot, an unknown provider — must not cancel the others.
        console.error(
          `Sector routine ${routine.id} was not enqueued.`,
          error,
        );
      }
    }
    return enqueued;
  };
}
