/**
 * The loop that turns queued rows into work.
 *
 * Nothing here calls a model or a browser: the executor is injected, which is what lets the same
 * loop run inside the server process and in a standalone worker, and lets a test drive the whole
 * state machine with a two-line fake. What this file owns is the part that must not be reimplemented
 * per executor: claiming, heartbeating, losing the lease, and the difference between a run that
 * finished and a run whose driver vanished.
 */
import type { AgentRunRepository, AgentRunRow } from "./repository";
import type { AgentRunService } from "./service";
import type { RunError, RunExecutionRequest, RunStatus } from "./types";

export type RunExecutor = (request: RunExecutionRequest) => Promise<void>;

export type AgentRunWorkerOptions = {
  repository: AgentRunRepository;
  service: AgentRunService;
  execute: RunExecutor;
  /** Identifies this process as the owner of whatever it claims. */
  owner: string;
  pollMs: number;
  leaseTtlMs: number;
  /** How many runs this worker drives at once. One on a small VPS. */
  concurrency?: number;
  /** Trabalho periódico que não pertence a nenhuma tarefa — hoje, apagar artefatos vencidos. */
  housekeeping?: () => Promise<void>;
  /** De quanto em quanto tempo chamá-lo. Um minuto por padrão. */
  housekeepingEveryMs?: number;
};

export interface AgentRunWorker {
  /** Begin polling. Returns immediately; the first tick runs now. */
  start(): void;
  /** Stop polling and wait for the in-flight run to notice. */
  stop(): Promise<void>;
  /** One pass: recover dead workers, then claim and drive whatever is queued. */
  tick(): Promise<number>;
  /** Runs this process is currently driving. */
  active(): number;
}

/** Statuses that mean the worker is still driving the run. */
const ACTIVE: Partial<Record<RunStatus, true>> = {
  running: true,
  waiting_model: true,
  executing: true,
};

export function createAgentRunWorker(
  options: AgentRunWorkerOptions,
): AgentRunWorker {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("Agent worker concurrency must be between 1 and 4");
  }
  const inflight = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let stopped = false;
  let lastHousekeeping = 0;

  async function settleFailure(
    runId: string,
    owner: string,
    generation: number,
    error: RunError,
  ): Promise<void> {
    const current = await options.repository.get(runId);
    if (!current) return;
    // The executor may have parked the run for a person or finished it and then thrown while
    // writing its last event. Either way its state is the truth, and this is not the place to
    // overrule it.
    if (
      current.status !== "running" &&
      current.status !== "waiting_model" &&
      current.status !== "executing"
    ) {
      return;
    }
    const settled = await options.repository.updateOwned(
      runId,
      owner,
      generation,
      {
        status: "failed",
        error,
        finishedAt: new Date(),
      },
    );
    if (!settled) return;
    await options.repository.appendEvent(runId, "run.status_changed", {
      from: current.status,
      to: "failed",
      error,
    });
  }

  async function drive(row: AgentRunRow): Promise<void> {
    const runId = row.id;
    const generation = Number(row.leaseGeneration);
    const abort = new AbortController();
    controllers.add(abort);
    /*
     * The heartbeat does two jobs: it keeps the lease, and it is how a pause or a cancel reaches a
     * worker that is inside a model call. Two seconds is short enough that "pause" means pause
     * rather than "pause after the next answer", and cheap enough at one row read.
     */
    const heartbeatMs = Math.max(
      1_000,
      Math.min(2_000, options.leaseTtlMs / 3),
    );
    const heartbeat = setInterval(() => {
      void options.repository
        .renewLease(runId, options.owner, generation, options.leaseTtlMs)
        .then(async (held) => {
          if (!held) {
            abort.abort(new Error("This worker lost the lease on the run."));
            return;
          }
          const current = await options.repository.get(runId);
          if (current && !ACTIVE[current.status]) {
            abort.abort(
              new Error(
                "The run was paused or cancelled while it was working.",
              ),
            );
          }
        })
        .catch(() => undefined);
    }, heartbeatMs);
    heartbeat.unref?.();

    try {
      await options.execute({
        runId,
        owner: options.owner,
        generation,
        signal: abort.signal,
      });
      const after = await options.repository.get(runId);
      if (after && ACTIVE[after.status]) {
        await settleFailure(runId, options.owner, generation, {
          code: "INTERNAL",
          message: "The executor stopped without settling the run.",
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The run failed.";
      await settleFailure(runId, options.owner, generation, {
        code: abort.signal.aborted ? "CANCELLED" : "INTERNAL",
        message,
      });
    } finally {
      clearInterval(heartbeat);
      controllers.delete(abort);
      await options.repository
        .releaseLease(runId, options.owner, generation)
        .catch(() => undefined);
    }
  }

  async function tick(): Promise<number> {
    if (stopped) return 0;
    await options.service.recoverExpired();
    await housekeepingIfDue();
    const waiting = await options.repository.queued(concurrency);
    let started = 0;
    for (const candidate of waiting) {
      if (inflight.size >= concurrency) break;
      const claimed = await options.repository.claim(
        candidate.id,
        options.owner,
        options.leaseTtlMs,
      );
      if (!claimed) continue;
      started += 1;
      const task = drive(claimed).finally(() => {
        inflight.delete(task);
      });
      inflight.add(task);
    }
    return started;
  }

  /**
   * O trabalho que não é de nenhuma tarefa: apagar o que passou do prazo.
   *
   * Não a cada tick, porque uma varredura por segundo para achar zero linhas é custo sem resposta, e
   * não em um processo separado, porque o worker já é o processo que está de pé. Uma vez por minuto,
   * e uma falha aqui não derruba o tick: um artefato que ficou um minuto a mais não é motivo para
   * parar de executar tarefas.
   */
  async function housekeepingIfDue(): Promise<void> {
    if (!options.housekeeping) return;
    const interval = options.housekeepingEveryMs ?? 60_000;
    const now = Date.now();
    if (now - lastHousekeeping < interval) return;
    lastHousekeeping = now;
    try {
      await options.housekeeping();
    } catch (error) {
      console.error("Agent run housekeeping failed.", error);
    }
  }

  return {
    start(): void {
      if (timer || stopped) return;
      const pump = () => {
        if (ticking || stopped) return;
        ticking = true;
        void tick()
          .catch((error) => {
            console.error("Agent run worker tick failed.", error);
          })
          .finally(() => {
            ticking = false;
          });
      };
      pump();
      timer = setInterval(pump, Math.max(250, options.pollMs));
      timer.unref?.();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      for (const controller of controllers) {
        controller.abort(new Error("The worker is shutting down."));
      }
      await Promise.allSettled([...inflight]);
    },

    tick,

    active(): number {
      return inflight.size;
    },
  };
}
