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
import type {
  AgentRunRepository,
  AgentRunRow,
  AgentRunStepRow,
} from "../agent-runs/repository";
import type {
  RunError,
  RunExecutionRequest,
  RunStatus,
  RunUsage,
} from "../agent-runs/types";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { ActionActor } from "../computer/gateway";
import type {
  AgentObservation,
  AgentRunInput,
  AgentRunResult,
  AgentStepSummary,
  CompletionCondition,
  ModelAttemptUsage,
  RunExecutorOptions,
  ToolCall,
  ToolOutcome,
} from "./contracts";
import { completionOf, sanitizeAttempt, sanitizeAttempts } from "./contracts";
import {
  HUMAN_CONTEXT_CHARS,
  TOOL_RESULT_CHARS,
  toolData,
  truncateForContext,
} from "./prompt";

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

function usageOf(
  row: AgentRunRow,
): RunUsage & { attempts: ModelAttemptUsage[] } {
  const usage = row.usage as
    | (Partial<RunUsage> & { attempts?: unknown })
    | null;
  return {
    steps: usage?.steps ?? 0,
    activeMs: usage?.activeMs ?? 0,
    modelCalls: usage?.modelCalls ?? 0,
    toolCalls: usage?.toolCalls ?? 0,
    ...(usage?.startedAt ? { startedAt: usage.startedAt } : {}),
    // Tentativas anteriores viajam no JSON existente: sem coluna nova, e higienizadas na leitura
    // para que só identidade e contadores sobrevivam — nunca texto de prompt.
    attempts: sanitizeAttempts(usage?.attempts),
  };
}

/**
 * Ferramentas que, sozinhas, nunca submetem nada para fora: ler, mapear, rolar, olhar e
 * preencher sem enviar (fill_form nunca submete por contrato). Navegar abre um endereço, mas
 * abrir não é enviar — a submissão mora no clique, no Enter e no submit explícito.
 */
const NON_SUBMITTING_TOOLS: Record<string, true> = {
  navigate: true,
  fetch_page: true,
  read_page: true,
  snapshot_page: true,
  scroll: true,
  screenshot: true,
  wait_for: true,
  read_form: true,
  plan_form: true,
  fill_form: true,
  select_option: true,
  request_help: true,
};

/**
 * Se esta chamada pode ter provocado efeito externo. `type_text` só envia com `submit: true`;
 * clique e tecla podem apertar um enviar; nome desconhecido é efeito possível por conservadorismo.
 */
function toolMaySubmit(name: string, args: Record<string, unknown>): boolean {
  if (NON_SUBMITTING_TOOLS[name]) return false;
  if (name === "type_text") return args.submit === true;
  return true;
}

/**
 * Se o histórico mostra ação com possível efeito externo. Lê os passos reais: só conta o que
 * foi executado (ok/falha/incerto) — recusa, salto e espera nunca agiram. Delegado com
 * toolCalls é efeito possível por conservadorismo: o CLI andou sozinho e o host não viu cada
 * passo.
 */
function historyMayHaveExternalEffect(
  steps: AgentRunStepRow[],
  decision: AgentRunResult,
): boolean {
  if (decision.kind === "delegated" && decision.toolCalls > 0) return true;
  return steps.some((step) => {
    if (
      step.status !== "ok" &&
      step.status !== "failed" &&
      step.status !== "uncertain"
    ) {
      return false;
    }
    const action = step.proposedAction as {
      name?: unknown;
      arguments?: unknown;
    } | null;
    if (!action || typeof action.name !== "string") return false;
    const args =
      action.arguments && typeof action.arguments === "object"
        ? (action.arguments as Record<string, unknown>)
        : {};
    return toolMaySubmit(action.name, args);
  });
}

function urlsEqual(left: string, right: string): boolean {
  const clean = (url: string): string =>
    url.trim().replace(/\/+$/, "").toLowerCase();
  return clean(left) === clean(right);
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
      refused?: { reason?: string };
      result?: unknown;
    } | null;
    const outcome = result?.summary
      ? result.summary
      : result?.refused
        ? `recusado: ${result.refused.reason}`
        : result?.ok === false
          ? `failed: ${result.error?.message ?? "unknown"}`
          : step.status;
    const projected = projectResult(action?.name, result?.result);
    return {
      seq: step.seq,
      kind: step.kind,
      summary: action?.name
        ? `${action.name} → ${outcome}${projected}`
        : `${step.kind} → ${outcome}`,
    };
  });
}

/**
 * O resultado útil da ferramenta, com proveniência e limite explícito.
 *
 * É assim que um `plan_form` entrega os assignments à decisão seguinte: o JSON limitado vai
 * etiquetado como dado não confiável, nunca como instrução. Sem resultado, sem projeção.
 */
function projectResult(name: string | undefined, result: unknown): string {
  if (result === undefined) return "";
  let json: string;
  try {
    const encoded = JSON.stringify(result);
    if (typeof encoded !== "string" || !encoded) return "";
    json = encoded;
  } catch {
    return "";
  }
  return ` ${toolData(name ?? "ferramenta", truncateForContext(json, TOOL_RESULT_CHARS))}`;
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
 * Um sinal que aborta quando o prazo estoura, medido pelo mesmo relógio do orçamento.
 *
 * O orçamento usa o `now` injetado (controlado nos testes), então o prazo não pode ser um
 * `setTimeout` real: uma sondagem curta observa o relógio injetado e aborta a chamada em
 * andamento. O receptor distingue o aborto do pai (`request.signal`) do estouro do prazo
 * comparando o relógio com `deadlineAt`.
 */
function budgetSignal(
  parent: AbortSignal,
  deadlineAt: number,
  now: () => number,
): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  if (parent.aborted) {
    ctrl.abort();
    return { signal: ctrl.signal, dispose: () => undefined };
  }
  const onParentAbort = (): void => {
    ctrl.abort();
  };
  parent.addEventListener("abort", onParentAbort, { once: true });
  const timer = setInterval(() => {
    if (parent.aborted || now() >= deadlineAt) ctrl.abort();
  }, 10);
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearInterval(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
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
  const now = options.now ?? (() => performance.now());
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
    await repository.releaseLease(
      request.runId,
      request.owner,
      request.generation,
    );
    return true;
  }

  return async function execute(request: RunExecutionRequest): Promise<void> {
    const loaded = await repository.get(request.runId);
    if (!loaded) return;
    if (loaded.status !== "running") return;
    const runBotId = loaded.botId;

    /*
     * O provedor que o run nomeia, e só ele.
     *
     * Havia aqui um `?? options.providers.default()`, que trocava um provedor desconhecido pelo
     * padrão sem dizer nada: a tarefa pedia um modelo e rodava em outro, e a única pista era a
     * resposta parecer estranha. Agora um provedor que não existe fecha o run com
     * PROVIDER_UNAVAILABLE e o nome — quem cria a tarefa valida antes (a rota devolve 400), então
     * chegar aqui é sinal de que o deployment mudou debaixo de um run.
     */
    const provider = options.providers.get(loaded.provider);
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
    /*
     * Base imutável da retomada + delta do relógio injetado.
     *
     * `used.activeMs` é relido do banco a cada iteração e já contém valores persistidos antes;
     * somar o tempo desde `started` a ele de novo conta o mesmo intervalo várias vezes (e
     * persistências no meio da iteração com valor defasado perdem tempo). A base é capturada uma
     * vez aqui e o tempo ativo é sempre `base + (agora - início)`, recalculado no momento de cada
     * persistência via `activeNow()`. A espera humana fica fora porque a execução termina ao
     * estacionar e a próxima retomada parte da base persistida com um `started` novo.
     */
    const resumeBase = usageOf(loaded).activeMs;
    const started = now();
    const activeNow = (): number => resumeBase + (now() - started);
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
        current.status === "running" ||
        current.status === "waiting_model" ||
        current.status === "executing";
      return repository.updateOwned(
        request.runId,
        request.owner,
        request.generation,
        workerOwnsState ? { ...patch, status: to } : patch,
      );
    }

    /**
     * Avalia a decisão final contra fonte do host, nunca contra prosa do modelo.
     *
     * Sem condição e sem efeito externo possível no histórico: tarefa textual, conclui. Com
     * efeito possível ou condição explícita, só prova fresca confirma — observação nova do host
     * para página, artefato do próprio run para artefato. Falha em observar não é prova: com
     * efeito possível ou condição, vira reconciliação, não sucesso.
     */
    async function verifyCompletion(input: {
      completion: CompletionCondition | null;
      decision: AgentRunResult;
      actor: ActionActor;
    }): Promise<{ met: boolean; message: string }> {
      const steps = await repository.steps(request.runId);
      const mayHaveEffect = historyMayHaveExternalEffect(steps, input.decision);
      if (!input.completion) {
        if (!mayHaveEffect) return { met: true, message: "textual" };
        return {
          met: false,
          message:
            "The run may have changed something outside this task and its effect was not confirmed. Model prose is not proof: reconcile before continuing.",
        };
      }
      if (input.completion.kind === "artifact") {
        const candidates = input.completion.artifactId
          ? [await repository.artifact(input.completion.artifactId)]
          : await repository.artifacts(request.runId);
        for (const artifact of candidates) {
          if (!artifact || artifact.runId !== request.runId) continue;
          if (
            artifact.retentionUntil &&
            artifact.retentionUntil.getTime() <= Date.now()
          )
            continue;
          const file = Bun.file(artifact.storagePath);
          if ((await file.exists()) && file.size > 0) {
            return { met: true, message: "artifact" };
          }
        }
        return {
          met: false,
          message:
            "No retained artifact bytes belonging to this run satisfy the condition.",
        };
      }
      let observation: AgentObservation;
      try {
        observation = await options.observations.observe({
          runId: request.runId,
          botId: runBotId,
          actor: input.actor,
          wantImage: false,
          signal: request.signal,
        });
      } catch {
        return {
          met: false,
          message:
            "The completion condition could not be checked against a fresh observation.",
        };
      }
      if (input.completion.kind === "page_text") {
        return observation.text.includes(input.completion.text)
          ? { met: true, message: "page_text" }
          : {
              met: false,
              message:
                "The expected text was not on the current page. The run does not conclude until the host sees it.",
            };
      }
      return urlsEqual(observation.url, input.completion.url)
        ? { met: true, message: "page_url" }
        : {
            met: false,
            message: `The page is at ${observation.url}, not the expected address.`,
          };
    }

    try {
      while (true) {
        const latest = await repository.get(request.runId);
        // `executing` é um passo em andamento deste mesmo worker: voltar ao topo do laço depois de
        // uma ação não é outra pessoa ter assumido a tarefa.
        if (latest?.status !== "running" && latest?.status !== "executing")
          return;

        const budget = budgetOf(latest);
        const used = usageOf(latest);
        const elapsed = activeNow();
        const deadlineAt = started + (budget.maxMs - resumeBase);
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
          // O tempo gasto até aqui é persistido para a base da retomada não o perder.
          if (ACTIVE[latest.status] === true) {
            await repository.updateOwned(
              request.runId,
              request.owner,
              request.generation,
              {
                status: "queued",
                usage: { ...used, activeMs: activeNow() },
              },
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
        /*
         * O pedido de imagem vale só o próximo observe: consumido aqui, antes de observar.
         *
         * Um `wantImage` pegajoso mandaria a captura para todos os passos seguintes ao pedido,
         * e a RQ-07 cobra o contrário — a imagem autorizada chega somente na observação seguinte,
         * salvo novo pedido explícito. Consumir antes do observe (e não depois de agir) também
         * impede que um observe que falhe deixe o pedido pendente para sempre.
         */
        const withImage = provider.capabilities.vision && wantImage;
        wantImage = false;
        let observation: AgentObservation;
        try {
          observation = await options.observations.observe({
            runId: request.runId,
            botId: loaded.botId,
            actor,
            wantImage: withImage,
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
          await settle(request, "failed", {
            usage: { ...used, steps: seq, activeMs: activeNow() },
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
        /*
         * O que uma pessoa disse desde o último passo.
         *
         * Lido aqui, e não no começo da execução, porque uma mensagem pode chegar enquanto a tarefa
         * já está andando — e marcada como entregue antes de o modelo ser chamado, no mesmo passo que
         * a levou. Se o worker morrer depois disso, a mensagem não é repetida no próximo passo; o
         * passo registrado é quem conta o que foi feito com ela.
         */
        const allMessages = await repository.messages(request.runId);
        const pending = allMessages.filter((row) => row.deliveredAt === null);
        if (pending.length) {
          await repository.markMessagesDelivered(
            request.runId,
            pending.map((row) => row.id),
            seq,
          );
        }
        /*
         * Restrições vigentes: o que a pessoa já disse e continua valendo.
         *
         * `pending` é entregue uma única vez em `messages`; isto aqui conserva a restrição nos
         * passos seguintes até substituição explícita ou o fim do run. Só pessoa, só o já entregue
         * neste run e antes deste passo, os mais recentes por último, sem cortar instruções.
         */
        const restrictions = allMessages
          .filter((row) => row.author === "person" && row.deliveredAt !== null)
          .map((row) => ({
            text: row.text,
            kind: row.kind,
          }));
        const humanContextSize = [
          ...restrictions,
          ...pending.filter((row) => row.author === "person"),
        ].reduce((total, row) => total + row.text.length, 0);
        if (humanContextSize > HUMAN_CONTEXT_CHARS) {
          const message =
            "Human instructions exceed the context budget. Start a new task with consolidated instructions; no restriction was silently discarded.";
          await repository.finishStep(request.runId, seq, {
            status: "failed",
            executionResult: { ok: false, summary: message },
          });
          await settle(request, "failed", {
            usage: { ...used, steps: seq, activeMs: activeNow() },
            error: { code: "BUDGET_EXCEEDED", message },
          });
          return;
        }
        /*
         * O modelo escolhido, quando houve escolha.
         *
         * `loaded.model` é `NOT NULL` e sempre traz alguma coisa — o padrão do deployment quando
         * ninguém escolheu. Mandar esse padrão adiante como se fosse decisão apagaria a diferença
         * entre "o Bot pediu este modelo" e "o deployment tem este modelo", e é justamente essa
         * diferença que deixa o serviço do CLI usar o modelo dele quando ninguém pediu nada.
         */
        const modeloEscolhido =
          loaded.model && loaded.model !== options.defaultModel
            ? loaded.model
            : undefined;

        const input: AgentRunInput = {
          runId: request.runId,
          botId: loaded.botId,
          // A declaração de execução que um provedor delegado apresenta em nome desta tarefa precisa
          // dizer de quem ela é: a pessoa vem da linha do run, nunca do que o modelo escrever.
          ...(loaded.userId ? { actorId: loaded.userId } : {}),
          objective: loaded.objective,
          observation,
          tools: options.tools.definitions(),
          history: historyOf(earlier.filter((row) => row.seq < seq)),
          ...(pending.length
            ? {
                messages: pending.map((row) => ({
                  author: row.author,
                  text: row.text,
                  kind: row.kind,
                })),
              }
            : {}),
          ...(restrictions.length ? { restrictions } : {}),
          ...(modeloEscolhido ? { model: modeloEscolhido } : {}),
          usage: { ...used, activeMs: elapsed },
          budget,
          capabilities: provider.capabilities,
        };

        const marked = await advance("waiting_model", {});
        if (marked?.status !== "waiting_model") {
          await repository.finishStep(request.runId, seq, {
            status: "skipped",
          });
          return;
        }

        // The provider is retried in place: another observation would spend a step to learn the
        // page did not change. The call carries the budget deadline, so a long model call is
        // aborted instead of running past the budget; pause/cancel keeps precedence below.
        const callSignal = budgetSignal(request.signal, deadlineAt, now);
        let decision: AgentRunResult | undefined;
        let providerError = "";
        /*
         * Cada tentativa conta, inclusive a que falhou: duas falhas e um sucesso persistem três
         * chamadas, cada uma com a identidade do provedor/modelo e os tokens que o provedor
         * reportou (null quando não reportou). Só identidade e contadores viajam — ver
         * `ModelAttemptUsage` — nenhum prompt, cookie ou credencial entra na telemetria.
         *
         * Um wrapper roteado relata cada tentativa subjacente via `onAttempt`, com a identidade
         * real: quando há relatos, eles são a conta do passo, sem somar o resultado do wrapper
         * por cima. Sem relatos, o provedor é nativo e conta uma vez, como antes.
         */
        const attempts: ModelAttemptUsage[] = [];
        const callbackAttempts: ModelAttemptUsage[] = [];
        const noteAttempt = (reported?: ModelAttemptUsage): void => {
          attempts.push({
            provider: provider.id,
            model: reported?.model ?? loaded.model,
            inputTokens: reported?.inputTokens ?? null,
            outputTokens: reported?.outputTokens ?? null,
            cachedTokens: reported?.cachedTokens ?? null,
            cost: null,
          });
        };
        const noteCallback = (reported: ModelAttemptUsage): void => {
          const clean =
            sanitizeAttempt(reported) ??
            ({
              provider: provider.id,
              model: loaded.model,
              inputTokens: null,
              outputTokens: null,
              cachedTokens: null,
              cost: null,
            } satisfies ModelAttemptUsage);
          callbackAttempts.push(clean);
        };
        try {
          for (
            let attempt = 0;
            attempt <= options.maxProviderRetries;
            attempt += 1
          ) {
            try {
              decision = await provider.run(input, {
                signal: callSignal.signal,
                onAttempt: noteCallback,
              });
              if (callbackAttempts.length === 0) noteAttempt(decision.usage);
              break;
            } catch (error) {
              if (callbackAttempts.length === 0) noteAttempt();
              providerError =
                error instanceof Error ? error.message : "The provider failed.";
              if (callSignal.signal.aborted || now() >= deadlineAt) break;
              // Routed providers already own their one allowed escalation.
              if (
                callbackAttempts.length ||
                (typeof error === "object" &&
                  error !== null &&
                  "retryable" in error &&
                  error.retryable === false)
              )
                break;
              if (attempt < options.maxProviderRetries) {
                await wait(Math.min(4_000, 500 * 2 ** attempt), request.signal);
              }
            }
          }
        } finally {
          callSignal.dispose();
        }
        // O gasto do passo: N tentativas somam N chamadas, e a lista acumulada viaja no JSON de
        // uso existente — sem coluna nova no banco. Todo caminho de saída abaixo carrega
        // `modelSpent`, então pausa, backoff e aborto nunca perdem o consumo já contado.
        const spentAttempts =
          callbackAttempts.length > 0 ? callbackAttempts : attempts;
        const modelSpent = {
          modelCalls: used.modelCalls + spentAttempts.length,
          attempts: [...used.attempts, ...spentAttempts],
        };

        if (!decision) {
          if (!request.signal.aborted && now() >= deadlineAt) {
            const fresh = await repository.get(request.runId);
            const owned =
              fresh?.status === "running" ||
              fresh?.status === "waiting_model" ||
              fresh?.status === "executing";
            if (!owned) {
              // Paused or cancelled while the call was aborted: keep the person's state.
              await repository.finishStep(request.runId, seq, {
                status: "skipped",
              });
              return;
            }
            const message = `The run reached its time limit (${budget.maxMs} ms).`;
            await repository.finishStep(request.runId, seq, {
              status: "failed",
              executionResult: {
                ok: false,
                summary: message,
                error: { code: "BUDGET_EXCEEDED", message },
              },
            });
            await settle(request, "failed", {
              usage: {
                ...used,
                steps: seq,
                ...modelSpent,
                activeMs: activeNow(),
              },
              error: { code: "BUDGET_EXCEEDED", message },
            });
            return;
          }
          await repository.finishStep(request.runId, seq, {
            status: "failed",
            executionResult: {
              ok: false,
              summary: `provider error: ${providerError}`,
              error: { code: "PROVIDER_UNAVAILABLE", message: providerError },
            },
          });
          await settle(request, "failed", {
            usage: {
              ...used,
              steps: seq,
              ...modelSpent,
              activeMs: activeNow(),
            },
            error: { code: "PROVIDER_UNAVAILABLE", message: providerError },
          });
          return;
        }

        const backToWork = await advance("running", {
          usage: {
            ...used,
            steps: seq,
            ...modelSpent,
            activeMs: activeNow(),
          },
          checkpoint: { stepSeq: seq, effect: "none" },
        });
        if (backToWork?.status !== "running") {
          // Paused or cancelled while the model was thinking: the step is closed without acting.
          await repository.finishStep(request.runId, seq, {
            status: "skipped",
          });
          return;
        }
        if (activeNow() > budget.maxMs) {
          // The deadline passed during the model call: the answer is recorded but the next
          // action is not executed. Pause/cancel was already given precedence above.
          const message = `The run reached its time limit (${budget.maxMs} ms).`;
          await repository.finishStep(request.runId, seq, {
            status: "failed",
            executionResult: {
              ok: false,
              summary: message,
              error: { code: "BUDGET_EXCEEDED", message },
            },
          });
          await settle(request, "failed", {
            usage: {
              ...used,
              steps: seq,
              ...modelSpent,
              activeMs: activeNow(),
            },
            error: { code: "BUDGET_EXCEEDED", message },
          });
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
              usage: {
                ...used,
                steps: seq,
                ...modelSpent,
                activeMs: activeNow(),
              },
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
            usage: {
              ...used,
              steps: seq,
              ...modelSpent,
              activeMs: activeNow(),
            },
            message: decision.reason,
            checkpoint: { stepSeq: seq, effect: "none" },
          });
          return;
        }

        if (decision.kind === "final" || decision.kind === "delegated") {
          /*
           * Conclusão verificável: a prosa do modelo nunca prova efeito externo.
           *
           * Com condição explícita do host, ela é avaliada contra fonte do host — observação
           * fresca para página, linha de artefato para artefato. Sem condição, tarefa puramente
           * textual (sem ação com possível efeito externo no histórico) conclui sem screenshot
           * obrigatório; com efeito possível e sem prova, estaciona em needs_reconciliation sem
           * repetir a ação. Evidência vinda no `evidence` do modelo é registrada para leitura,
           * mas nunca conta como prova.
           */
          const completion = completionOf(loaded.metadata);
          const verification = await verifyCompletion({
            completion,
            decision,
            actor,
          });
          // Uma pausa ou cancelamento que chegou durante a verificação tem precedência: o passo
          // fecha sem agir e o estado da pessoa fica onde ela pôs.
          const afterVerify = await repository.get(request.runId);
          if (afterVerify?.status !== "running") {
            await repository.finishStep(request.runId, seq, {
              status: "skipped",
            });
            return;
          }
          if (!verification.met) {
            await repository.finishStep(request.runId, seq, {
              status: "uncertain",
              modelDecision: { kind: decision.kind },
              executionResult: {
                ok: false,
                summary: verification.message,
                ...(decision.evidence ? { evidence: decision.evidence } : {}),
              },
            });
            await repository.appendEvent(request.runId, "run.note", {
              note: "unverified_completion",
              ...(completion ? { condition: completion.kind } : {}),
              message: verification.message,
            });
            await settle(request, "needs_reconciliation", {
              usage: {
                ...used,
                steps: seq,
                ...modelSpent,
                activeMs: activeNow(),
              },
              message: verification.message,
              checkpoint: { stepSeq: seq, effect: "uncertain" },
            });
            return;
          }
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
            usage: {
              ...used,
              steps: seq,
              ...modelSpent,
              activeMs: activeNow(),
            },
            message: decision.message,
            checkpoint: { stepSeq: seq, effect: "done" },
          });
          return;
        }

        // A tool call. Decide whether it needs a person before anything reaches the browser.
        const call: ToolCall = decision.call;
        const review = await options.approvals?.review(call, observation, {
          runId: request.runId,
          stepSeq: seq,
          actorUserId: loaded.userId,
          destination: observation.url,
        });
        if (review?.decision === "denied") {
          /*
           * A pessoa negou esta ação. O modelo é informado e decide outra coisa — tentar o mesmo
           * caminho de novo conta como recusa e é limitado como qualquer recusa de política.
           */
          refusals += 1;
          await repository.finishStep(request.runId, seq, {
            status: "refused",
            modelDecision: { kind: "tool_call", call },
            proposedAction: { name: call.name, arguments: call.arguments },
            policyDecision: {
              allowed: false,
              rule: "approval",
              approvalId: review.approvalId,
            },
            executionResult: {
              ok: false,
              summary: `negado pela pessoa: ${call.name}`,
              refused: { rule: "approval", reason: review.reason },
            },
          });
          await repository.appendEvent(request.runId, "run.approval_denied", {
            approval: review.approvalId,
            tool: call.name,
          });
          if (refusals > options.maxRefusals) {
            await settle(request, "failed", {
              usage: {
                ...used,
                steps: seq,
                ...modelSpent,
                activeMs: activeNow(),
              },
              error: {
                code: "POLICY_DENIED",
                message: review.reason,
              },
            });
            return;
          }
          continue;
        }
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
            usage: {
              ...used,
              steps: seq,
              ...modelSpent,
              activeMs: activeNow(),
            },
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
              usage: {
                ...used,
                steps: seq,
                ...modelSpent,
                activeMs: activeNow(),
              },
              message:
                "A ação mudou desde a aprovação. Peça aprovação novamente.",
              checkpoint: { stepSeq: seq, effect: "none" },
            });
            return;
          }
        }

        /*
         * Última olhada antes do navegador, e o estado que a pessoa vê enquanto a ação acontece.
         *
         * Uma pausa ou um cancelamento que chegou enquanto o modelo respondia custa zero: `advance`
         * não sobrescreve o estado de quem assumiu a tarefa, e o passo fica `skipped`. O mesmo
         * mecanismo é o que faz o painel mostrar `executing` em vez de `running` durante a ação.
         */
        const acting = await advance("executing", {});
        if (acting?.status !== "executing") {
          await repository.finishStep(request.runId, seq, {
            status: "skipped",
          });
          return;
        }

        await repository.finishStep(request.runId, seq, {
          status: "executing",
          modelDecision: { kind: "tool_call", call },
          proposedAction: { name: call.name, arguments: call.arguments },
        });

        let outcome: ToolOutcome;
        const toolSignal = budgetSignal(request.signal, deadlineAt, now);
        try {
          outcome = await options.tools.execute(call, {
            runId: request.runId,
            botId: loaded.botId,
            stepSeq: seq,
            actor,
            signal: toolSignal.signal,
          });
        } catch (error) {
          if (!request.signal.aborted && now() >= deadlineAt) {
            // O prazo estourou com a ação em voo: não há próximo efeito a executar. Pausa ou
            // cancelamento da pessoa tem precedência sobre o estouro.
            toolSignal.dispose();
            const fresh = await repository.get(request.runId);
            const owned =
              fresh?.status === "running" ||
              fresh?.status === "waiting_model" ||
              fresh?.status === "executing";
            if (!owned) {
              await repository.finishStep(request.runId, seq, {
                status: "skipped",
              });
              return;
            }
            const toolUsage = usageOf(fresh ?? latest);
            const message = `The run reached its time limit (${budget.maxMs} ms).`;
            await repository.finishStep(request.runId, seq, {
              status: "failed",
              executionResult: {
                ok: false,
                summary: message,
                error: { code: "BUDGET_EXCEEDED", message },
              },
            });
            await settle(request, "failed", {
              usage: { ...toolUsage, activeMs: activeNow() },
              error: { code: "BUDGET_EXCEEDED", message },
            });
            return;
          }
          outcome = {
            ok: false,
            error: {
              code: "INTERNAL",
              message:
                error instanceof Error ? error.message : "The tool failed.",
            },
          };
        }
        toolSignal.dispose();

        const afterTool = await repository.get(request.runId);
        const toolUsage = usageOf(afterTool ?? latest);
        const toolPersisted = {
          ...toolUsage,
          toolCalls: toolUsage.toolCalls + 1,
          activeMs: activeNow(),
        };
        await repository.updateOwned(
          request.runId,
          request.owner,
          request.generation,
          {
            usage: toolPersisted,
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
            usage: { ...toolPersisted, activeMs: activeNow() },
            message: outcome.help.reason,
            checkpoint: { stepSeq: seq, effect: "none" },
          });
          return;
        }

        /*
         * Uma pessoa assumiu o volante, ou está digitando um valor que o modelo não pode ver.
         *
         * Não é falha da ferramenta e não é algo que o modelo resolva tentando de novo: enquanto ela
         * estiver ali, toda ação é recusada. Parar em `waiting_human` é a única resposta que não
         * gasta passos contra a parede, e é o que faz o painel mostrar a tarefa esperando a pessoa em
         * vez de um erro.
         */
        if (
          !outcome.ok &&
          (outcome.error?.code === "HUMAN_CONTROL" ||
            outcome.error?.code === "SECRET_PENDING")
        ) {
          await settle(request, "waiting_human", {
            usage: { ...toolPersisted, activeMs: activeNow() },
            message: outcome.error.message,
            checkpoint: { stepSeq: seq, effect: "none" },
          });
          return;
        }

        if (outcome.uncertain) {
          await settle(request, "needs_reconciliation", {
            usage: { ...toolPersisted, activeMs: activeNow() },
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
              usage: { ...toolPersisted, activeMs: activeNow() },
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
