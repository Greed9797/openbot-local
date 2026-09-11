/**
 * The loop: observe, decide, act, observe again — durably.
 *
 * Every iteration writes a step before the model is asked anything and settles it after, so a run
 * that dies has a trail of what it knew and what it did up to that point. The loop never executes
 * a browser action itself: it asks the tool catalog, and the catalog goes through the gateway,
 * which is where policy and audit live. That is the whole reason this file can be tested with two
 * fakes and still describe the production path.
 */
import { createHash } from "node:crypto";
import type { ActionActor } from "../computer/gateway";
import type { RunExecutionRequest, RunError, RunStatus, RunUsage } from "../agent-runs/types";
import type { AgentRunRepository, AgentRunRow } from "../agent-runs/repository";
import { recordAuditEvent, type AuditStore } from "../audit";
import type {
  AgentObservation,
  AgentRunInput,
  AgentRunResult,
  AgentStepSummary,
  RunExecutorOptions,
  ToolCall,
  ToolOutcome,
} from "./contracts";

/** How many earlier steps a provider is told about. Recent ones are the ones that matter. */
const HISTORY_STEPS = 20;

const TERMINAL: Partial<Record<RunStatus, true>> = {
  succeeded: true,
  failed: true,
  cancelled: true,
};

const ACTIVE: Partial<Record<RunStatus, true>> = {
  running: true,
  waiting_model: true,
  executing: true,
};

type BudgetView = { maxSteps: number; maxMs: number; maxCorrections: number };

function usageOf(row: AgentRunRow): RunUsage {
  const usage = row.usage as Partial<RunUsage> | null;
  return {
    steps: usage?.steps ?? 0,
    activeMs: usage?.activeMs ?? 0,
    modelCalls: usage?.modelCalls ?? 0,
    toolCalls: usage?.toolCalls ?? 0,
    ...(usage?.startedAt ? { startedAt: usage.startedAt } : {}),
  };
}

function budgetOf(row: AgentRunRow): BudgetView {
  const budget = row.budget as Partial<BudgetView> | null;
  return {
    maxSteps: budget?.maxSteps ?? 40,
    maxMs: budget?.maxMs ?? 900_000,
    maxCorrections: budget?.maxCorrections ?? 2,
  };
}

/**
 * What a provider is told about earlier steps.
 *
 * A summary, never the full text: the observation is already in the step, and replaying every page
 * the run ever read would spend the whole context on pages it has already acted on.
 */
function historyOf(
  steps: {
    seq: number;
    kind: string;
    status: string;
    proposedAction: unknown;
    executionResult: unknown;
  }[],
): AgentStepSummary[] {
  return steps.slice(-HISTORY_STEPS).map((step) => {
    const action = step.proposedAction as { name?: string } | null;
    const result = step.executionResult as {
      ok?: boolean;
      summary?: string;
      error?: { message?: string };
    } | null;
    const outcome = result?.summary
      ? result.summary
      : result?.ok === false
        ? `failed: ${result.error?.message ?? "unknown"}`
        : step.status;
    return {
      seq: step.seq,
      kind: step.kind,
      summary: action?.name
        ? `${action.name} → ${outcome}`
        : `${step.kind} → ${outcome}`,
    };
  });
}

/** The image metadata that is safe to persist. Never the bytes. */
function imageRecords(observation: AgentObservation) {
  return observation.images.map((image) => ({
    artifactId: image.artifactId,
    mime: image.mime,
    width: image.width,
    height: image.height,
    capturedAt: image.capturedAt,
    protected: image.protected,
  }));
}

/** What the step keeps about what the run saw. No page text, no base64. */
function observationRecord(observation: AgentObservation) {
  return {
    observationId: observation.observationId,
    url: observation.url,
    title: observation.title,
    truncated: observation.truncated,
    snapshotId: observation.snapshotId,
    elements: observation.elements.length,
    viewport: observation.viewport,
    capturedAt: observation.capturedAt,
    control: observation.control,
    images: imageRecords(observation),
    textOnly: observation.textOnly,
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
  return promise;
}

/**
 * The digest of an action, for an approval that must not authorize a different one.
 *
 * Keys are sorted recursively so the same action hashes the same way no matter what order the model
 * happened to emit its arguments in. The hash covers the tool and its whole argument object,
 * because an approval for "send this form" that also authorizes a changed field is not an approval.
 */
export function actionHashOf(call: ToolCall): string {
  return createHash("sha256")
    .update(`${call.name}:${stableStringify(call.arguments)}`)
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function createAgentRunExecutor(
  options: RunExecutorOptions & {
    repository: AgentRunRepository;
    auditStore: AuditStore;
    now?: () => number;
  },
) {
  const now = options.now ?? (() => Date.now());
  const { repository, auditStore } = options;

  /**
   * Settle the run, but only while this worker still owns it.
   *
   * A refused write is not an error here: it means the lease moved on, and whoever holds it now is
   * the one allowed to say how the run ended.
   */
  async function settle(
    request: RunExecutionRequest,
    status: RunStatus,
    patch: {
      error?: RunError;
      checkpoint?: Record<string, unknown>;
      usage?: RunUsage;
      message?: string;
    },
  ): Promise<boolean> {
    const before = await repository.get(request.runId);
    if (!before) return false;
    const finished = TERMINAL[status] === true;
    const row = await repository.updateOwned(
      request.runId,
      request.owner,
      request.generation,
      {
        status,
        ...(patch.error ? { error: patch.error } : {}),
        ...(patch.checkpoint ? { checkpoint: patch.checkpoint } : {}),
        ...(patch.usage ? { usage: patch.usage } : {}),
        ...(finished ? { finishedAt: new Date() } : {}),
      },
    );
    if (!row) return false;
    await repository.appendEvent(request.runId, "run.status_changed", {
      from: before.status,
      to: status,
      ...(patch.message ? { message: patch.message } : {}),
      ...(patch.error ? { error: patch.error } : {}),
    });
    if (
      finished ||
      status === "waiting_human" ||
      status === "waiting_approval" ||
      status === "needs_reconciliation"
    ) {
      await recordAuditEvent(auditStore, {
        eventType:
          status === "succeeded"
            ? "agent_run.completed"
            : status === "cancelled"
              ? "agent_run.cancelled"
              : "agent_run.status_changed",
        targetType: "agent_run",
        targetId: request.runId,
        ...(row.userId ? { actorUserId: row.userId } : {}),
        payload: {
          bot: row.botId,
          to: status,
          ...(patch.message ? { message: patch.message.slice(0, 500) } : {}),
          ...(patch.error ? { error: patch.error } : {}),
        },
      });
    }
    await options.notifier?.statusChanged({
      runId: request.runId,
      botId: row.botId,
      userId: row.userId,
      from: before.status,
      to: status,
      ...(patch.error ? { reason: patch.error.code } : {}),
      ...(patch.message ? { message: patch.message } : {}),
    });
    await repository.releaseLease(request.runId, request.owner, request.generation);
    return true;
  }

  return async function execute(request: RunExecutionRequest): Promise<void> {
    const loaded = await repository.get(request.runId);
    if (!loaded) return;
    if (loaded.status !== "running") return;

    const provider =
      options.providers.get(loaded.provider) ?? options.providers.default();
    if (!provider) {
      await settle(request, "failed", {
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: `No provider is registered for "${loaded.provider}".`,
        },
      });
      return;
    }

    const profileId = loaded.botId;
    const profileLease = await repository.acquireProfileLease({
      profileId,
      runId: loaded.id,
      owner: request.owner,
      ttlMs: options.leaseTtlMs,
    });
    if (!profileLease) {
      // Somebody else is driving this browser. The run goes back to the queue; a later tick tries
      // again, which is what keeps two tasks off one profile without failing either of them.
      await repository.updateOwned(
        request.runId,
        request.owner,
        request.generation,
        { status: "queued" },
      );
      await repository.appendEvent(request.runId, "run.queued_for_profile", {
        profile: profileId,
        heldBy: (await repository.profileLease(profileId))?.runId ?? null,
      });
      return;
    }

    const actor: ActionActor = { id: loaded.userId ?? `run:${loaded.id}` };
    const started = now();
    let corrections = 0;
    let refusals = 0;
    let wantImage = false;

    /**
     * Move the run's own state, but only while it is still this worker's to move.
     *
     * A person can pause or cancel while the model is answering. When that happened, the usage is
     * still recorded — it was spent — and the status is left exactly where the person put it. A
     * plain `updateOwned({status})` here would silently undo their pause, which is the bug this
     * helper exists to prevent.
     */
    async function advance(
      to: RunStatus,
      patch: Parameters<typeof repository.updateOwned>[3],
    ): Promise<AgentRunRow | undefined> {
      const current = await repository.get(request.runId);
      if (!current) return undefined;
      const workerOwnsState =
        current.status === "running" || current.status === "waiting_model";
      return repository.updateOwned(
        request.runId,
        request.owner,
        request.generation,
        workerOwnsState ? { ...patch, status: to } : patch,
      );
    }

    try {
      while (true) {
        const latest = await repository.get(request.runId);
        if (latest?.status !== "running") return;

        const budget = budgetOf(latest);
        const used = usageOf(latest);
        const elapsed = used.activeMs + (now() - started);
        if (latest.currentStep >= budget.maxSteps) {
          await settle(request, "failed", {
            usage: { ...used, activeMs: elapsed },
            error: {
              code: "BUDGET_EXCEEDED",
              message: `The run reached its step limit (${budget.maxSteps}).`,
            },
          });
          return;
        }
        if (elapsed > budget.maxMs) {
          await settle(request, "failed", {
            usage: { ...used, activeMs: elapsed },
            error: {
              code: "BUDGET_EXCEEDED",
              message: `The run reached its time limit (${budget.maxMs} ms).`,
            },
          });
          return;
        }

        if (request.signal.aborted) {
          // Shutdown or a lost lease: back to the queue so a later worker resumes from the
          // checkpoint. A person's pause is not overwritten here; only active states are requeued.
          if (ACTIVE[latest.status] === true) {
            await repository.updateOwned(
              request.runId,
              request.owner,
              request.generation,
              { status: "queued" },
            );
          }
          return;
        }

        // Renew the profile lock with the same cadence as the run lease: the profile stays held
        // while this worker is actually working.
        const held = await repository.renewProfileLease({
          profileId,
          owner: request.owner,
          generation: profileLease.generation,
          ttlMs: options.leaseTtlMs,
        });
        if (!held) return;

        const seq = await repository.allocateStep(request.runId);
        const stepStartedAt = new Date();
        let observation: AgentObservation;
        try {
          observation = await options.observations.observe({
            runId: request.runId,
            botId: loaded.botId,
            actor,
            wantImage: provider.capabilities.vision && wantImage,
            signal: request.signal,
          });
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "The page could not be observed.";
          await repository.appendStep({
            runId: request.runId,
            seq,
            kind: "observation",
            status: "failed",
            executionResult: {
              ok: false,
              error: { code: "INTERNAL", message },
            },
            startedAt: stepStartedAt,
          });
          await repository.finishStep(request.runId, seq, {});
          await settle(request, "failed", {
            usage: { ...used, steps: seq, activeMs: elapsed },
            error: { code: "INTERNAL", message },
          });
          return;
        }

        await repository.appendStep({
          runId: request.runId,
          seq,
          kind: "observation",
          status: "started",
          observation: observationRecord(observation),
          startedAt: stepStartedAt,
        });

        const earlier = await repository.steps(request.runId);
        const input: AgentRunInput = {
          runId: request.runId,
          botId: loaded.botId,
          objective: loaded.objective,
          observation,
          history: historyOf(earlier.filter((row) => row.seq < seq)),
          tools: options.tools.definitions(),
          budget,
          usage: used,
          capabilities: provider.capabilities,
        };

        const marked = await advance("waiting_model", {});
        if (marked?.status !== "waiting_model") {
          await repository.finishStep(request.runId, seq, { status: "skipped" });
          return;
        }

        // The provider is retried in place: another observation would spend a step to learn the
        // page did not change.
        let decision: AgentRunResult | undefined;
        let providerError = "";
        for (let attempt = 0; attempt <= options.maxProviderRetries; attempt += 1) {
          try {
            decision = await provider.run(input, { signal: request.signal });
            break;
          } catch (error) {
            providerError =
              error instanceof Error ? error.message : "The provider failed.";
            if (attempt < options.maxProviderRetries) {
              await wait(Math.min(4_000, 500 * 2 ** attempt), request.signal);
            }
          }
        }

        if (!decision) {
          await repository.finishStep(request.runId, seq, {
            status: "failed",
            executionResult: {
              ok: false,
              summary: `provider error: ${providerError}`,
              error: { code: "PROVIDER_UNAVAILABLE", message: providerError },
            },
          });
          await settle(request, "failed", {
            error: { code: "PROVIDER_UNAVAILABLE", message: providerError },
          });
          return;
        }

        const backToWork = await advance("running", {
          usage: {
            ...used,
            steps: seq,
            modelCalls: used.modelCalls + 1,
            activeMs: elapsed,
          },
          checkpoint: { stepSeq: seq, effect: "none" },
        });
        if (backToWork?.status !== "running") {
          // Paused or cancelled while the model was thinking: the step is closed without acting.
          await repository.finishStep(request.runId, seq, { status: "skipped" });
          return;
        }

        if (decision.kind === "invalid") {
          corrections += 1;
          await repository.finishStep(request.runId, seq, {
            status: "invalid",
            executionResult: {
              ok: false,
              summary: `invalid decision: ${decision.error}`,
            },
          });
          await repository.appendEvent(request.runId, "run.note", {
            note: "invalid_decision",
            error: decision.error,
            corrections,
          });
          if (corrections > budget.maxCorrections) {
            await settle(request, "failed", {
              error: { code: "INVALID_ACTION", message: decision.error },
            });
            return;
          }
          continue;
        }

        if (decision.kind === "help") {
          await repository.finishStep(request.runId, seq, {
            status: "waiting_human",
            executionResult: { ok: true, summary: decision.reason },
          });
          await settle(request, "waiting_human", {
            message: decision.reason,
            checkpoint: { stepSeq: seq, effect: "none" },
          });
          return;
        }

        if (decision.kind === "final" || decision.kind === "delegated") {
          await repository.finishStep(request.runId, seq, {
            status: "succeeded",
            modelDecision: { kind: decision.kind },
            executionResult: {
              ok: true,
              summary: decision.message,
              ...(decision.evidence ? { evidence: decision.evidence } : {}),
            },
          });
          await repository.appendEvent(request.runId, "run.final", {
            message: decision.message,
            ...(decision.evidence ? { evidence: decision.evidence } : {}),
          });
          await settle(request, "succeeded", {
            message: decision.message,
            checkpoint: { stepSeq: seq, effect: "done" },
          });
          return;
        }

        // A tool call. Decide whether it needs a person before anything reaches the browser.
        const call: ToolCall = decision.call;
        const review = await options.approvals?.review(call, observation);
        if (review?.decision === "requested") {
          await repository.finishStep(request.runId, seq, {
            status: "waiting_approval",
            modelDecision: { kind: "tool_call", call },
            proposedAction: { name: call.name, arguments: call.arguments },
            executionResult: {
              ok: true,
              summary: `waiting for approval (${review.approvalId})`,
            },
          });
          await settle(request, "waiting_approval", {
            message: `Aguardando aprovação para ${call.name}.`,
            checkpoint: { stepSeq: seq, effect: "none" },
          });
          return;
        }
        if (review?.decision === "approved") {
          const spent = await options.approvals?.consume(
            review.approvalId,
            actionHashOf(call),
          );
          if (!spent) {
            await repository.finishStep(request.runId, seq, {
              status: "refused",
              modelDecision: { kind: "tool_call", call },
              proposedAction: { name: call.name, arguments: call.arguments },
              executionResult: {
                ok: false,
                summary: "the approval is no longer valid",
                refused: {
                  rule: "approval",
                  reason:
                    "A aprovação expirou, já foi usada ou os dados mudaram. É preciso aprovar de novo.",
                },
              },
            });
            await settle(request, "waiting_approval", {
              message:
                "A ação mudou desde a aprovação. Peça aprovação novamente.",
              checkpoint: { stepSeq: seq, effect: "none" },
            });
            return;
          }
        }

        // Last look before the browser: a pause or a cancel that arrived while the model was
        // answering must cost nothing, and no action may run after the run stopped being active.
        const beforeActing = await repository.get(request.runId);
        if (beforeActing?.status !== "running") {
          await repository.finishStep(request.runId, seq, { status: "skipped" });
          return;
        }

        await repository.finishStep(request.runId, seq, {
          status: "executing",
          modelDecision: { kind: "tool_call", call },
          proposedAction: { name: call.name, arguments: call.arguments },
        });

        let outcome: ToolOutcome;
        try {
          outcome = await options.tools.execute(call, {
            runId: request.runId,
            stepSeq: seq,
            actor,
            signal: request.signal,
          });
        } catch (error) {
          outcome = {
            ok: false,
            error: {
              code: "INTERNAL",
              message:
                error instanceof Error ? error.message : "The tool failed.",
            },
          };
        }

        const afterTool = await repository.get(request.runId);
        const toolUsage = usageOf(afterTool ?? latest);
        await repository.updateOwned(
          request.runId,
          request.owner,
          request.generation,
          {
            usage: {
              ...toolUsage,
              toolCalls: toolUsage.toolCalls + 1,
              activeMs: elapsed,
            },
            checkpoint: outcome.uncertain
              ? { stepSeq: seq, effect: "uncertain" }
              : { stepSeq: seq, effect: "none" },
          },
        );

        await repository.finishStep(request.runId, seq, {
          status: outcome.ok
            ? "ok"
            : outcome.refused
              ? "refused"
              : outcome.uncertain
                ? "uncertain"
                : "failed",
          policyDecision: outcome.refused
            ? { allowed: false, rule: outcome.refused.rule }
            : { allowed: true },
          executionResult: {
            ok: outcome.ok,
            ...(outcome.result ? { result: outcome.result } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
            ...(outcome.refused ? { refused: outcome.refused } : {}),
            ...(outcome.uncertain ? { uncertain: true } : {}),
          },
        });

        if (outcome.help) {
          await settle(request, "waiting_human", {
            message: outcome.help.reason,
            checkpoint: { stepSeq: seq, effect: "none" },
          });
          return;
        }

        if (outcome.uncertain) {
          await settle(request, "needs_reconciliation", {
            message:
              "The action ran but its external effect is unknown. Confirm before continuing.",
            checkpoint: { stepSeq: seq, effect: "uncertain" },
          });
          return;
        }

        // A screenshot is the model asking to look; the next observation will carry an image.
        if (outcome.ok && call.name === "screenshot") wantImage = true;

        if (outcome.refused) {
          refusals += 1;
          if (refusals > options.maxRefusals) {
            await settle(request, "failed", {
              error: {
                code: "POLICY_DENIED",
                message:
                  outcome.refused.reason ??
                  "The deployment's policy refused this action.",
              },
            });
            return;
          }
          continue;
        }

        if (!outcome.ok && !outcome.stale) {
          await repository.appendEvent(request.runId, "run.note", {
            note: "tool_error",
            tool: call.name,
            error: outcome.error ?? null,
          });
        }
        refusals = 0;
      }
    } finally {
      await repository
        .releaseProfileLease({
          profileId,
          owner: request.owner,
          generation: profileLease.generation,
        })
        .catch(() => undefined);
    }
  };
}
