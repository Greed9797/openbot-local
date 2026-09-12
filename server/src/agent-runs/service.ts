/**
 * The state machine over a durable task, and the only place that moves it.
 *
 * A transition that is not allowed here is not allowed anywhere: the routes call these functions,
 * and so does the worker. What the service refuses to do is as important as what it does — it will
 * not resume a finished run, will not cancel one twice, and will not claim that a run whose worker
 * vanished is still being worked on.
 */
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type {
  AgentRunEventRow,
  AgentRunRepository,
  AgentRunRow,
  AgentRunStepRow,
  RunApprovalRow,
  RunMessageRow,
} from "./repository";
import type {
  CreateRunInput,
  RunApprovalView,
  RunBudget,
  RunError,
  RunEventView,
  RunMessageView,
  RunStatus,
  RunStepView,
  RunUsage,
  RunView,
} from "./types";

/** A request that cannot be carried out, with the reason a caller may show. */
export class AgentRunError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "INVALID_STATE"
      | "CONFLICT"
      | "INVALID_ACTION",
    message: string,
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}

export type RunActor = {
  /** The signed-in person, or the local actor when authentication is not configured. */
  id: string;
};

export type AgentRunDefaults = {
  provider: string;
  model: string;
  budget: RunBudget;
  /** How long a run's lease lasts without a heartbeat. */
  leaseTtlMs: number;
};

export type CreateRunResult = {
  run: AgentRunRow;
  /** False when the idempotency key already owned this work. */
  created: boolean;
};

/** Statuses a person may pause. Terminal runs are past it; a run already paused is not paused again. */
const PAUSABLE: RunStatus[] = [
  "queued",
  "running",
  "waiting_model",
  "executing",
  "waiting_approval",
  "waiting_human",
];

/** Statuses a person may resume. `needs_reconciliation` is here on purpose: only a person decides. */
const RESUMABLE: RunStatus[] = [
  "paused",
  "waiting_human",
  "needs_reconciliation",
];

const CANCELLABLE: RunStatus[] = [
  "queued",
  "running",
  "waiting_model",
  "executing",
  "waiting_approval",
  "waiting_human",
  "paused",
  "needs_reconciliation",
];

export interface AgentRunService {
  createRun(
    actor: RunActor,
    input: CreateRunInput,
    actorUserId: string | null,
  ): Promise<CreateRunResult>;
  getRun(id: string): Promise<AgentRunRow | undefined>;
  listRuns(filters: {
    botId?: string;
    userId?: string;
    status?: RunStatus[];
    limit?: number;
  }): Promise<AgentRunRow[]>;
  steps(runId: string): Promise<AgentRunStepRow[]>;
  events(runId: string, afterSeq: number): Promise<AgentRunEventRow[]>;
  messages(runId: string, afterSeq?: number): Promise<RunMessageView[]>;
  /**
   * O que uma pessoa disse à tarefa.
   *
   * Uma tarefa que parou pedindo gente volta para a fila com esta mensagem: é a resposta que a
   * pessoa deu, e é ela que o modelo lê no próximo passo. `waiting_approval` NÃO volta sozinho — a
   * aprovação é uma decisão explícita, e uma frase no meio dela não é um sim.
   */
  appendMessage(
    runId: string,
    actor: RunActor,
    input: { text: string; source: string; kind?: string },
  ): Promise<{ run: AgentRunRow; message: RunMessageRow }>;
  approvals(runId: string): Promise<RunApprovalView[]>;
  /** A decisão de uma pessoa sobre uma ação que esperava por ela. */
  decideApproval(
    runId: string,
    approvalId: string,
    actor: RunActor,
    decision: "approved" | "denied",
    note?: string,
  ): Promise<{ run: AgentRunRow; approval: RunApprovalView }>;
  pause(id: string, actor: RunActor): Promise<AgentRunRow>;
  resume(id: string, actor: RunActor): Promise<AgentRunRow>;
  cancel(id: string, actor: RunActor): Promise<AgentRunRow>;
  /** Move runs whose worker disappeared into a state that needs a decision. */
  recoverExpired(now?: Date): Promise<number>;
  recordEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

function requireRun(run: AgentRunRow | undefined, id: string): AgentRunRow {
  if (!run) throw new AgentRunError("NOT_FOUND", `No run ${id}.`);
  return run;
}

function runError(value: unknown): RunError | null {
  const error = value as RunError | null;
  return error && typeof error.code === "string" ? error : null;
}

function usageOf(value: unknown): RunUsage {
  const usage = value as Partial<RunUsage> | null;
  return {
    steps: usage?.steps ?? 0,
    activeMs: usage?.activeMs ?? 0,
    modelCalls: usage?.modelCalls ?? 0,
    toolCalls: usage?.toolCalls ?? 0,
    ...(usage?.startedAt ? { startedAt: usage.startedAt } : {}),
  };
}

function budgetOf(value: unknown): RunBudget {
  const budget = value as Partial<RunBudget> | null;
  return {
    maxSteps: budget?.maxSteps ?? 40,
    maxMs: budget?.maxMs ?? 900_000,
    maxCorrections: budget?.maxCorrections ?? 2,
  };
}

/** The row as a surface reads it. No lease fields: who owns a run is not the UI's business. */
export function runView(row: AgentRunRow): RunView {
  return {
    id: row.id,
    botId: row.botId,
    userId: row.userId,
    threadId: row.threadId,
    origin: row.origin,
    provider: row.provider,
    model: row.model,
    objective: row.objective,
    status: row.status,
    currentStep: row.currentStep,
    budget: budgetOf(row.budget),
    usage: usageOf(row.usage),
    checkpoint: (row.checkpoint as Record<string, unknown> | null) ?? null,
    error: runError(row.error),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

export function stepView(row: AgentRunStepRow): RunStepView {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    status: row.status,
    observation: (row.observation as Record<string, unknown> | null) ?? null,
    modelDecision:
      (row.modelDecision as Record<string, unknown> | null) ?? null,
    proposedAction:
      (row.proposedAction as Record<string, unknown> | null) ?? null,
    policyDecision:
      (row.policyDecision as Record<string, unknown> | null) ?? null,
    executionResult:
      (row.executionResult as Record<string, unknown> | null) ?? null,
    artifactId: row.artifactId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function eventView(row: AgentRunEventRow): RunEventView {
  return {
    seq: row.seq,
    type: row.type,
    payload: (row.payload as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

export function messageView(row: RunMessageRow): RunMessageView {
  return {
    seq: row.seq,
    author: row.author,
    kind: row.kind,
    text: row.text,
    source: row.source,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    stepSeq: row.stepSeq,
    createdAt: row.createdAt.toISOString(),
  };
}

export function approvalView(row: RunApprovalRow): RunApprovalView {
  const action = (row.action as Record<string, unknown> | null) ?? {};
  const name = typeof action.name === "string" ? action.name : null;
  return {
    id: row.id,
    status: row.status,
    actionName: name,
    action,
    destination: row.destination,
    expectedEffect: row.expectedEffect,
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A message a person sends is bounded: an instruction, not a document. */
const MESSAGE_LIMIT = 4_000;

export function createAgentRunService(options: {
  repository: AgentRunRepository;
  auditStore: AuditStore;
  defaults: AgentRunDefaults;
  /**
   * A escolha de modelo do Bot, quando ele tem uma.
   *
   * Injetada porque este serviço não conhece perfis de Bot e não deve conhecer: quem sabe ler o
   * jsonb de configuração é o store de perfis, e quem sabe o que existe é o catálogo. Aqui só se
   * aplica a precedência — tarefa, depois Bot, depois deployment.
   */
  botModel?: (
    botId: string,
  ) => Promise<{ provider: string | null; model: string | null } | null>;
  /**
   * Se este provedor oferece este modelo, segundo o catálogo.
   *
   * Sem isto, um provedor que não existe é aceito na criação e trocado pelo padrão na execução —
   * que era o comportamento até agora, e a pior resposta possível: a tarefa roda, com outro modelo,
   * e nada diz isso.
   */
  knownModel?: (provider: string, model: string) => boolean;
}): AgentRunService {
  const { repository, auditStore, defaults, botModel, knownModel } = options;

  async function created(
    run: AgentRunRow,
    actor: RunActor,
    actorUserId: string | null,
  ): Promise<CreateRunResult> {
    await auditStore.insert({
      eventType: "agent_run.created",
      targetType: "agent_run",
      targetId: run.id,
      ...(actorUserId ? { actorUserId } : {}),
      payload: {
        bot: run.botId,
        origin: run.origin,
        provider: run.provider,
        model: run.model,
        objective: run.objective.slice(0, 500),
        requestedBy: actor.id,
      },
    });
    await repository.appendEvent(run.id, "run.created", {
      status: run.status,
      objective: run.objective,
      provider: run.provider,
      model: run.model,
    });
    return { run, created: true };
  }

  return {
    async createRun(
      actor: RunActor,
      input: CreateRunInput,
      actorUserId: string | null,
    ): Promise<CreateRunResult> {
      if (!input.objective.trim()) {
        throw new AgentRunError("INVALID_STATE", "A run needs an objective.");
      }
      if (!input.botId.trim()) {
        throw new AgentRunError("INVALID_STATE", "A run needs a Bot.");
      }
      /*
       * A precedência: a tarefa, depois o Bot, depois o deployment.
       *
       * Vazio é ausência, e a normalização mora aqui de propósito: `""` chega do formulário que
       * limpou o campo e do cliente que mandou a chave sem valor, e as duas coisas significam "não
       * escolhi". Tratadas como escolha, `provider: ""` ia para a linha e a tarefa só falhava na
       * execução, dizendo que aquele provedor não existe.
       *
       * A validação só olha para o que alguém escolheu. Sem escolha nenhuma, o valor é o padrão do
       * deployment — e um deployment sem provedor configurado precisa continuar criando a tarefa
       * para que ela falhe dizendo `PROVIDER_UNAVAILABLE`, que é o diagnóstico útil. Recusar na
       * porta esconderia o motivo verdadeiro atrás de um erro de formulário.
       */
      const escolhaDoBot = await botModel?.(input.botId);
      const escolhidoProvider =
        input.provider?.trim() || escolhaDoBot?.provider || null;
      const escolhidoModel = input.model?.trim() || escolhaDoBot?.model || null;
      if (escolhidoProvider && knownModel) {
        if (!knownModel(escolhidoProvider, escolhidoModel ?? "")) {
          throw new AgentRunError(
            "INVALID_ACTION",
            knownModel(escolhidoProvider, "")
              ? `The provider "${escolhidoProvider}" does not offer "${escolhidoModel ?? ""}" here.`
              : `No model is configured for provider "${escolhidoProvider}" in this deployment.`,
          );
        }
      }
      const budget: RunBudget = { ...defaults.budget, ...input.budget };
      const { run, created: inserted } = await repository.create({
        botId: input.botId,
        userId: input.userId,
        threadId: input.threadId ?? null,
        origin: input.origin,
        sourceMessageId: input.sourceMessageId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        /*
         * O que a tarefa pediu, senão o que o Bot escolheu, senão o padrão do deployment.
         *
         * A linha gravada é a decisão final: o painel mostra `provider/model` do run, e quem lê
         * depois precisa ver o que de fato conduziu a tarefa, não o que alguém deixou em branco.
         */
        provider: escolhidoProvider ?? defaults.provider,
        model: escolhidoModel ?? defaults.model,
        objective: input.objective,
        budget: { ...budget },
        usage: {
          steps: 0,
          activeMs: 0,
          modelCalls: 0,
          toolCalls: 0,
        } satisfies RunUsage,
        metadata: input.metadata ?? {},
      });
      // The key already owned a run: hand that one back without a second trail row.
      if (!inserted) return { run, created: false };
      return created(run, actor, actorUserId);
    },

    getRun(id: string) {
      return repository.get(id);
    },

    listRuns(filters) {
      return repository.list({
        ...(filters.botId ? { botId: filters.botId } : {}),
        ...(filters.userId ? { userId: filters.userId } : {}),
        ...(filters.status?.length ? { status: filters.status } : {}),
        limit: Math.min(filters.limit ?? 50, 200),
      });
    },

    steps(runId: string) {
      return repository.steps(runId);
    },

    events(runId: string, afterSeq: number) {
      return repository.events(runId, afterSeq);
    },

    async messages(runId: string, afterSeq = 0) {
      requireRun(await repository.get(runId), runId);
      const rows = await repository.messages(runId, afterSeq);
      return rows.map(messageView);
    },

    async appendMessage(runId, actor, input) {
      const run = requireRun(await repository.get(runId), runId);
      const text = input.text.trim();
      if (!text) {
        throw new AgentRunError("INVALID_STATE", "A message needs text.");
      }
      const message = await repository.appendMessage({
        runId,
        author: "person",
        kind: input.kind ?? "instruction",
        text: text.slice(0, MESSAGE_LIMIT),
        source: input.source,
        actorUserId: actor.id,
      });
      await repository.appendEvent(runId, "run.message", {
        seq: message.seq,
        from: input.source,
        by: actor.id,
        preview: message.text.slice(0, 200),
      });
      /*
       * Uma tarefa que parou pedindo uma pessoa volta a andar com a resposta dela. As demais ficam
       * onde estão: uma mensagem para uma tarefa em `waiting_approval` é uma observação, não o sim,
       * e uma tarefa pausada foi pausada de propósito.
       */
      let current = run;
      if (run.status === "waiting_human") {
        const moved = await repository.updateStatus(
          runId,
          ["waiting_human"],
          "queued",
        );
        if (moved) {
          current = moved;
          await repository.appendEvent(runId, "run.status_changed", {
            from: run.status,
            to: moved.status,
            by: actor.id,
            reason: "answered",
          });
        }
      }
      return { run: current, message };
    },

    async approvals(runId) {
      requireRun(await repository.get(runId), runId);
      const rows = await repository.approvals(runId);
      return rows.map(approvalView);
    },

    async decideApproval(runId, approvalId, actor, decision, note) {
      const run = requireRun(await repository.get(runId), runId);
      const approval = await repository.approval(approvalId);
      if (!approval || approval.runId !== runId) {
        throw new AgentRunError("NOT_FOUND", `No approval ${approvalId}.`);
      }
      const decided = await repository.decideApproval({
        id: approvalId,
        decision,
        decidedBy: actor.id,
      });
      if (!decided) {
        throw new AgentRunError(
          "INVALID_STATE",
          "Esta aprovação já foi decidida, expirou ou não existe mais.",
        );
      }
      const verb = decision === "approved" ? "aprovada" : "negada";
      const actionName =
        typeof (decided.action as { name?: unknown } | null)?.name === "string"
          ? String((decided.action as { name: string }).name)
          : "a ação";
      await repository.appendMessage({
        runId,
        author: "system",
        kind: decision === "approved" ? "approval_granted" : "approval_denied",
        text: note?.trim()
          ? `A pessoa ${verb} "${actionName}": ${note.trim()}`
          : `A pessoa ${verb} "${actionName}".`,
        source: "runner",
        actorUserId: actor.id,
      });
      await repository.appendEvent(runId, "run.approval_decided", {
        approval: approvalId,
        decision,
        by: actor.id,
        ...(note ? { note: note.slice(0, 500) } : {}),
      });
      await recordAuditEvent(auditStore, {
        eventType: `agent_run.approval_${decision}`,
        targetType: "agent_run",
        targetId: runId,
        actorUserId: actor.id,
        payload: {
          approval: approvalId,
          action: (decided.action as { name?: string } | null)?.name ?? null,
          ...(note ? { note: note.slice(0, 500) } : {}),
        },
      });
      /*
       * A tarefa volta a andar nos dois casos. Um "não" não é o fim da tarefa: o modelo precisa ler
       * a recusa e decidir outra coisa — parar aqui deixaria a decisão da pessoa sem consequência, e
       * a tarefa presa num estado que ninguém pediu.
       */
      let current = run;
      if (run.status === "waiting_approval") {
        const moved = await repository.updateStatus(
          runId,
          ["waiting_approval"],
          "queued",
        );
        if (moved) {
          current = moved;
          await repository.appendEvent(runId, "run.status_changed", {
            from: run.status,
            to: moved.status,
            by: actor.id,
            reason: `approval_${decision}`,
          });
        }
      }
      return { run: current, approval: approvalView(decided) };
    },

    async pause(id: string, actor: RunActor) {
      const before = requireRun(await repository.get(id), id);
      const run = await repository.updateStatus(id, PAUSABLE, "paused");
      if (!run) {
        throw new AgentRunError(
          "INVALID_STATE",
          `A run that is ${before.status} cannot be paused.`,
        );
      }
      await repository.appendEvent(run.id, "run.status_changed", {
        from: before.status,
        to: run.status,
        by: actor.id,
      });
      await recordAuditEvent(auditStore, {
        eventType: "agent_run.status_changed",
        targetType: "agent_run",
        targetId: run.id,
        payload: { from: before.status, to: run.status, by: actor.id },
      });
      return run;
    },

    async resume(id: string, actor: RunActor) {
      const before = requireRun(await repository.get(id), id);
      const run = await repository.updateStatus(id, RESUMABLE, "queued");
      if (!run) {
        throw new AgentRunError(
          "INVALID_STATE",
          `A run that is ${before.status} cannot be resumed.`,
        );
      }
      await repository.appendEvent(run.id, "run.status_changed", {
        from: before.status,
        to: run.status,
        by: actor.id,
        reason:
          before.status === "needs_reconciliation" ? "reconciled" : "resumed",
      });
      await recordAuditEvent(auditStore, {
        eventType: "agent_run.status_changed",
        targetType: "agent_run",
        targetId: run.id,
        payload: {
          from: before.status,
          to: run.status,
          by: actor.id,
          reason: "resumed",
        },
      });
      return run;
    },

    async cancel(id: string, actor: RunActor) {
      const before = requireRun(await repository.get(id), id);
      const run = await repository.updateStatus(id, CANCELLABLE, "cancelled", {
        finishedAt: new Date(),
      });
      if (!run) {
        throw new AgentRunError(
          "INVALID_STATE",
          `A run that is ${before.status} cannot be cancelled.`,
        );
      }
      await repository.appendEvent(run.id, "run.status_changed", {
        from: before.status,
        to: run.status,
        by: actor.id,
      });
      await recordAuditEvent(auditStore, {
        eventType: "agent_run.cancelled",
        targetType: "agent_run",
        targetId: run.id,
        payload: { from: before.status, by: actor.id },
      });
      return run;
    },

    /**
     * What to do about a run whose worker stopped heartbeating.
     *
     * Never "carry on": the process that was driving is gone, and the honest question is whether the
     * last thing it did had an external effect. The executor records that in the checkpoint.
     *
     *   - No recorded external effect: the run goes back to the queue and the next worker resumes it
     *     from its checkpoint. A restart is not supposed to need a person.
     *   - Effect uncertain: `needs_reconciliation`. Nobody may try it again until somebody looks.
     */
    async recoverExpired(now = new Date()) {
      const expired = await repository.expiredLeases(now);
      for (const run of expired) {
        const checkpoint = run.checkpoint as Record<string, unknown> | null;
        const uncertain = checkpoint?.effect === "uncertain";
        const next: RunStatus = uncertain ? "needs_reconciliation" : "queued";
        const moved = await repository.updateStatus(
          run.id,
          ["running", "waiting_model", "executing"],
          next,
        );
        if (!moved) continue;
        const reason = uncertain
          ? "worker_lost_effect_uncertain"
          : "worker_lost_resumed";
        await repository.appendEvent(run.id, "run.status_changed", {
          from: run.status,
          to: next,
          reason,
        });
        await recordAuditEvent(auditStore, {
          eventType: "agent_run.recovered",
          targetType: "agent_run",
          targetId: run.id,
          payload: { from: run.status, to: next, reason },
        });
      }
      return expired.length;
    },

    async recordEvent(runId, type, payload) {
      await repository.appendEvent(runId, type, payload);
    },
  };
}
