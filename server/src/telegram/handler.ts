/**
 * A conversa, do update à resposta.
 *
 * Este arquivo decide, e não envia: devolve as mensagens que devem sair. É o que torna a conversa
 * testável sem rede e sem token, e é o que deixa explícito que a autorização é decidida aqui — quem
 * pode falar com este bot, sobre qual tarefa, e o que essa pessoa pode fazer com ela.
 *
 * Três regras carregam o peso:
 *
 * - Autorizado é quem está na lista do deployment E tem um vínculo. A lista diz "esta pessoa pode
 *   falar com o bot"; o vínculo diz "esta pessoa é fulano deste deployment, e opera aquele Bot". Só
 *   o vínculo dá acesso a tarefas, e ele nasce de um código de uso único, não de uma mensagem.
 * - O Telegram não tem Playwright. Toda ação daqui passa pelo mesmo serviço que a interface usa, e é
 *   por isso que uma tarefa criada por mensagem aparece no painel, com o mesmo estado e a mesma
 *   trilha.
 * - Uma captura só vira imagem no chat se o artefato permitir. Página sensível fica retida para o
 *   painel, e o chat recebe o motivo em vez da foto — a classificação vale igual nas duas telas.
 */
import {
  analyzeImage,
  NoVisionModelError,
  visionProvider,
} from "../agent-runtime/analyze-image";
import type { ProviderRegistry } from "../agent-runtime/contracts";
import { imageForModel, refusalReason } from "../agent-runtime/image-input";
import { captureRunScreen, type RunVision } from "../agent-runs/capture";
import type { AgentRunRow } from "../agent-runs/repository";
import type { AgentRunService, RunActor } from "../agent-runs/service";
import { callbackIntent, intentOf, type TelegramIntent } from "./commands";
import type { TelegramStore } from "./store";
import type { TelegramButton, TelegramOutgoing, TelegramUpdate } from "./types";

/** Quantas tarefas a listagem mostra, e quantas linhas cabem numa mensagem de celular. */
const TASK_LIST_LIMIT = 8;

export type TelegramHandlerOptions = {
  store: TelegramStore;
  runs: AgentRunService;
  /** Ids numéricos autorizados a falar com este bot. Vazio significa que ninguém está. */
  allowedUserIds: readonly string[];
  vision?: RunVision;
  /** Quem responde "o que está nessa tela". Sem nenhum modelo que enxergue, a análise é recusada. */
  providers?: ProviderRegistry;
  /** O que fazer quando a conversa pede uma análise e não há modelo que veja. */
  signal?: AbortSignal;
};

export type TelegramHandler = {
  handle(update: TelegramUpdate): Promise<TelegramOutgoing[]>;
};

/** Como uma tarefa aparece numa linha de chat. */
function describeRun(run: AgentRunRow): string {
  const objective =
    run.objective.length > 60 ? `${run.objective.slice(0, 57)}...` : run.objective;
  return `${run.id.slice(0, 8)} · ${STATE_PT[run.status] ?? run.status} · ${objective}`;
}

const STATE_PT: Record<string, string> = {
  queued: "na fila",
  running: "trabalhando",
  waiting_model: "pensando",
  executing: "executando",
  waiting_approval: "esperando sua aprovação",
  waiting_human: "esperando você",
  paused: "pausada",
  needs_reconciliation: "parada para conferência",
  succeeded: "concluída",
  failed: "falhou",
  cancelled: "cancelada",
};

const ACTIVE_STATUSES = [
  "queued",
  "running",
  "waiting_model",
  "executing",
  "waiting_approval",
  "waiting_human",
  "paused",
  "needs_reconciliation",
] as const;

export function createTelegramHandler(
  options: TelegramHandlerOptions,
): TelegramHandler {
  const { store, runs } = options;

  const text = (
    chatId: string,
    body: string,
    extra: { buttons?: TelegramButton[][]; answerCallbackId?: string } = {},
  ): TelegramOutgoing => ({ kind: "text", chatId, text: body, ...extra });

  /** A tarefa desta conversa: a que está viva, ou a última que rodou. */
  async function currentRun(
    binding: { userId: string; botId: string },
    explicitId?: string,
  ): Promise<AgentRunRow | undefined> {
    if (explicitId) {
      const run = await runs.getRun(explicitId);
      if (
        !run ||
        run.userId !== binding.userId ||
        run.botId !== binding.botId
      ) {
        return undefined;
      }
      return run;
    }
    const recent = await runs.listRuns({
      botId: binding.botId,
      userId: binding.userId,
      limit: 10,
    });
    return (
      recent.find((run) =>
        (ACTIVE_STATUSES as readonly string[]).includes(run.status),
      ) ?? recent[0]
    );
  }

  async function screen(
    chatId: string,
    binding: { userId: string; botId: string },
    runId?: string,
    answerCallbackId?: string,
  ): Promise<TelegramOutgoing[]> {
    if (!options.vision) {
      return [
        text(chatId, "Este deployment não tem navegador ligado ao runtime.", {
          ...(answerCallbackId ? { answerCallbackId } : {}),
        }),
      ];
    }
    const run = await currentRun(binding, runId);
    if (!run) {
      return [
        text(chatId, "Não encontrei uma tarefa sua para mostrar.", {
          ...(answerCallbackId ? { answerCallbackId } : {}),
        }),
      ];
    }
    try {
      const { artifact } = await captureRunScreen(options.vision, run, {
        stepId: null,
      });
      if (!artifact.allowedDestinations.includes("telegram")) {
        return [
          text(
            chatId,
            `A tela da tarefa ${run.id.slice(0, 8)} é de uma página que este deployment marcou como sensível. A captura ficou guardada para o painel, e não sai daqui.`,
            { ...(answerCallbackId ? { answerCallbackId } : {}) },
          ),
        ];
      }
      const stored = await options.vision.artifacts.read(artifact.id);
      if (!stored) {
        return [
          text(chatId, "A captura não pôde ser lida.", {
            ...(answerCallbackId ? { answerCallbackId } : {}),
          }),
        ];
      }
      return [
        {
          kind: "photo",
          chatId,
          bytes: new Uint8Array(stored.bytes),
          mime: artifact.mime,
          caption: `Tarefa ${run.id.slice(0, 8)} · ${STATE_PT[run.status] ?? run.status}`,
          ...(answerCallbackId ? { answerCallbackId } : {}),
        },
      ];
    } catch (error) {
      return [
        text(
          chatId,
          `Não consegui tirar a captura: ${error instanceof Error ? error.message : "erro desconhecido"}.`,
          { ...(answerCallbackId ? { answerCallbackId } : {}) },
        ),
      ];
    }
  }

  async function analyze(
    chatId: string,
    binding: { userId: string; botId: string },
    runId: string | undefined,
    question: string | undefined,
    answerCallbackId?: string,
  ): Promise<TelegramOutgoing[]> {
    if (!options.vision) {
      return [
        text(chatId, "Este deployment não tem navegador ligado ao runtime."),
      ];
    }
    const provider = options.providers
      ? visionProvider(options.providers, (id) => options.providers?.get(id))
      : undefined;
    if (!provider) {
      return [
        text(chatId, new NoVisionModelError().message, {
          ...(answerCallbackId ? { answerCallbackId } : {}),
        }),
      ];
    }

    const run = await currentRun(binding, runId);
    if (!run) return [text(chatId, "Não encontrei uma tarefa sua para mostrar.")];
    try {
      const { artifact } = await captureRunScreen(options.vision, run, {
        stepId: null,
      });
      const stored = await options.vision.artifacts.read(artifact.id);
      if (!stored) {
        return [
          text(chatId, "A captura não pôde ser lida.", {
            ...(answerCallbackId ? { answerCallbackId } : {}),
          }),
        ];
      }
      const image = imageForModel(artifact, stored.bytes);
      if (!image) {
        return [
          text(
            chatId,
            refusalReason(artifact) ??
              "Esta captura não pode ser enviada a um modelo.",
            { ...(answerCallbackId ? { answerCallbackId } : {}) },
          ),
        ];
      }
      const answer = await analyzeImage({
        provider,
        run,
        question:
          question ??
          "O que está aparecendo nesta tela, e o que isso significa para a tarefa?",
        image,
        signal: options.signal ?? new AbortController().signal,
      });
      return [
        text(chatId, answer, {
          ...(answerCallbackId ? { answerCallbackId } : {}),
        }),
      ];
    } catch (error) {
      return [
        text(
          chatId,
          `A análise falhou: ${error instanceof Error ? error.message : "erro desconhecido"}.`,
          { ...(answerCallbackId ? { answerCallbackId } : {}) },
        ),
      ];
    }
  }

  function helpText(): string {
    return [
      "Sou o navegador desta conta. Escreva o que fazer e eu abro, preencho e paro quando precisar de você.",
      "",
      "Exemplos:",
      "· Abra o TikTok e me diga quais campos tem o cadastro de produto.",
      "· Preencha o formulário com nome Caderno, preço 29,90.",
      "",
      "Comandos:",
      "/tela — a captura da tarefa atual, sem gastar modelo",
      "/analisar — a captura vai a um modelo que vê e volta a análise",
      "/tarefas — as últimas tarefas",
      "/status — em que pé está a tarefa atual",
      "/pausar, /continuar, /cancelar — o controle da tarefa atual",
      "/aprovar, /recusar — o que está esperando a sua decisão",
    ].join("\n");
  }

  async function runApproval(
    chatId: string,
    binding: { userId: string; botId: string },
    intent: {
      kind: "approve" | "deny";
      runId: string;
      approvalId: string;
      reason?: string;
    },
    answerCallbackId?: string,
  ): Promise<TelegramOutgoing[]> {
    const run = await currentRun(binding, intent.runId);
    if (!run) {
      return [
        text(chatId, "Não encontrei essa tarefa sua.", {
          ...(answerCallbackId ? { answerCallbackId } : {}),
        }),
      ];
    }
    const actor: RunActor = { id: binding.userId };
    try {
      const decided = await runs.decideApproval(
        run.id,
        intent.approvalId,
        actor,
        intent.kind === "approve" ? "approved" : "denied",
        intent.kind === "deny" ? intent.reason : undefined,
      );
      const verb = intent.kind === "approve" ? "Aprovada" : "Recusada";
      return [
        text(
          chatId,
          `${verb}: ${decided.approval.actionName ?? "a ação"} na tarefa ${run.id.slice(0, 8)}. A tarefa continua.`,
          { ...(answerCallbackId ? { answerCallbackId } : {}) },
        ),
      ];
    } catch (error) {
      return [
        text(
          chatId,
          error instanceof Error
            ? error.message
            : "Não foi possível registrar a decisão.",
          { ...(answerCallbackId ? { answerCallbackId } : {}) },
        ),
      ];
    }
  }

  async function handleIntent(
    intent: TelegramIntent,
    chatId: string,
    binding: { userId: string; botId: string },
    idempotencyKey: string,
    sourceMessageId: string,
  ): Promise<TelegramOutgoing[]> {
    const actor: RunActor = { id: binding.userId };
    switch (intent.kind) {
      case "help":
        return [text(chatId, helpText())];

      case "status": {
        const run = await currentRun(binding);
        if (!run) {
          return [
            text(
              chatId,
              "Nenhuma tarefa ainda. Escreva o que fazer, por exemplo: abra o TikTok e liste os campos do cadastro de produto.",
            ),
          ];
        }
        const steps = await runs.steps(run.id);
        const last = steps.at(-1);
        return [
          text(
            chatId,
            [
              `Tarefa ${run.id.slice(0, 8)} — ${STATE_PT[run.status] ?? run.status}`,
              run.objective,
              `${run.currentStep} passo(s)`,
              ...(last ? [`último: ${last.kind} (${last.status})`] : []),
              ...(run.error ? [`erro: ${run.error.message}`] : []),
            ].join("\n"),
            { buttons: [[{ text: "Ver tela", data: `screen:${run.id}` }]] },
          ),
        ];
      }

      case "tasks": {
        const recent = await runs.listRuns({
          botId: binding.botId,
          userId: binding.userId,
          limit: TASK_LIST_LIMIT,
        });
        if (!recent.length) return [text(chatId, "Nenhuma tarefa ainda.")];
        return [
          text(
            chatId,
            [
              "Últimas tarefas:",
              ...recent.map((run) => `· ${describeRun(run)}`),
            ].join("\n"),
          ),
        ];
      }

      case "screen":
        return screen(chatId, binding, intent.runId);

      case "analyze":
        return analyze(chatId, binding, intent.runId, intent.question);

      case "pause":
      case "cancel":
      case "resume": {
        const run = await currentRun(binding, intent.runId);
        if (!run) return [text(chatId, "Não encontrei essa tarefa sua.")];
        try {
          if (intent.kind === "pause") await runs.pause(run.id, actor);
          if (intent.kind === "cancel") await runs.cancel(run.id, actor);
          if (intent.kind === "resume") {
            if (intent.note) {
              await runs.appendMessage(run.id, actor, {
                text: intent.note,
                source: "telegram",
              });
            } else {
              await runs.resume(run.id, actor);
            }
          }
          const after = await runs.getRun(run.id);
          const status = after?.status ?? run.status;
          return [
            text(
              chatId,
              `Tarefa ${run.id.slice(0, 8)}: ${STATE_PT[status] ?? status}.`,
            ),
          ];
        } catch (error) {
          return [
            text(
              chatId,
              error instanceof Error
                ? error.message
                : "Não foi possível mudar a tarefa.",
            ),
          ];
        }
      }

      case "approve":
      case "deny":
        return runApproval(chatId, binding, intent);

      case "task": {
        if (!intent.objective.trim()) {
          return [text(chatId, helpText())];
        }
        const { run, created } = await runs.createRun(
          actor,
          {
            botId: binding.botId,
            userId: binding.userId,
            origin: "telegram",
            objective: intent.objective,
            idempotencyKey,
            sourceMessageId,
          },
          binding.userId,
        );
        if (!created) {
          return [
            text(
              chatId,
              `Essa mensagem já virou a tarefa ${run.id.slice(0, 8)}.`,
            ),
          ];
        }
        return [
          text(
            chatId,
            `Tarefa ${run.id.slice(0, 8)} na fila. Eu aviso quando precisar de você.`,
            { buttons: [[{ text: "Ver tela", data: `screen:${run.id}` }]] },
          ),
        ];
      }

      default:
        // A união é fechada; isto existe para o TypeScript, e responde como o /ajuda.
        return [text(chatId, helpText())];
    }
  }

  return {
    async handle(update: TelegramUpdate): Promise<TelegramOutgoing[]> {
      if (update.message) {
        const message = update.message;
        const userId = message.from?.id;
        if (!userId) return [];
        if (
          options.allowedUserIds.length > 0 &&
          !options.allowedUserIds.includes(userId)
        ) {
          return [
            text(
              message.chatId,
              "Este telegram não está autorizado neste deployment.",
            ),
          ];
        }

        const intent = intentOf(message);
        if (intent.kind === "help") {
          const existing = await store.bindingFor(message.chatId);
          return [
            text(
              message.chatId,
              existing
                ? helpText()
                : `${helpText()}\n\nEste chat ainda não está ligado a nenhuma conta. Gere um código no painel e mande /start CODIGO.`,
            ),
          ];
        }
        if (intent.kind === "pair") {
          // O pareamento é a única porta que não exige vínculo: é ele que cria o vínculo.
          const pairing = await store.consumePairingCode(intent.code);
          if (!pairing) {
            return [
              text(
                message.chatId,
                "Esse código não vale mais. Gere outro no painel: eles são de uso único e vencem.",
              ),
            ];
          }
          const binding = await store.upsertBinding({
            telegramUserId: userId,
            chatId: message.chatId,
            userId: pairing.userId,
            botId: pairing.botId ?? "",
          });
          return [
            text(
              message.chatId,
              `Pronto. Este chat agora opera o Bot ${binding.botId || "padrão"}. Escreva o que fazer.`,
            ),
          ];
        }

        const binding = await store.bindingFor(message.chatId);
        if (!binding) {
          return [
            text(
              message.chatId,
              "Este chat ainda não está ligado a nenhuma conta. Gere um código no painel e mande /start CODIGO.",
            ),
          ];
        }
        return handleIntent(
          intent,
          message.chatId,
          binding,
          `telegram:${binding.botId}:${update.updateId}`,
          String(message.messageId),
        );
      }

      if (update.callback) {
        const callback = update.callback;
        const userId = callback.from.id;
        if (
          options.allowedUserIds.length > 0 &&
          !options.allowedUserIds.includes(userId)
        ) {
          return [
            text(callback.chatId, "Este telegram não está autorizado.", {
              answerCallbackId: callback.id,
            }),
          ];
        }
        const binding = await store.bindingFor(callback.chatId);
        if (!binding) {
          return [
            text(
              callback.chatId,
              "Este chat não está ligado a nenhuma conta.",
              { answerCallbackId: callback.id },
            ),
          ];
        }
        const intent = callbackIntent(callback.data);
        if (!intent) {
          return [
            text(callback.chatId, "Não entendi esse botão.", {
              answerCallbackId: callback.id,
            }),
          ];
        }
        if (intent.kind === "screen") {
          return screen(callback.chatId, binding, intent.runId, callback.id);
        }
        return runApproval(callback.chatId, binding, intent, callback.id);
      }

      return [];
    },
  };
}
