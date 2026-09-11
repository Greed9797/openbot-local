/**
 * A conversa, sem rede e sem banco.
 *
 * O que se fixa aqui são as decisões que a autorização carrega: quem fala, sobre qual tarefa, e o
 * que essa pessoa pode fazer. É o lugar onde um erro vira acesso indevido — um chat que não está
 * vinculado agindo como se estivesse, um botão que alcança a tarefa de outra pessoa, uma captura de
 * página sensível saindo no chat.
 */
import { describe, expect, test } from "bun:test";
import type { RunArtifactRow } from "../src/agent-runs/repository";
import { createTelegramHandler } from "../src/telegram/handler";
import type { TelegramStore } from "../src/telegram/store";
import type { TelegramOutgoing } from "../src/telegram/types";

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Um vínculo desta conversa: a pessoa `user-1`, operando o Bot `bot-1`. */
const binding = {
  id: "binding-1",
  telegramUserId: "777",
  chatId: "555",
  userId: "user-1",
  botId: "bot-1",
  permissions: {},
  createdAt: new Date("2026-09-11T10:00:00.000Z"),
};

const run = {
  id: "11111111-2222-3333-4444-555555555555",
  botId: "bot-1",
  userId: "user-1",
  threadId: null,
  origin: "web" as const,
  sourceMessageId: null,
  idempotencyKey: null,
  provider: "scripted",
  model: "scripted-1",
  objective: "Preencher o formulário.",
  status: "waiting_approval" as const,
  currentStep: 3,
  budget: {},
  usage: {},
  checkpoint: null,
  error: null,
  metadata: {},
  heartbeatAt: new Date(),
  finishedAt: null,
  startedAt: new Date(),
  leaseOwner: null,
  leaseGeneration: 0,
  leaseExpiresAt: null,
  createdAt: new Date("2026-09-11T10:00:00.000Z"),
};

function artifact(allowed: string[]): RunArtifactRow {
  return {
    id: "artifact-1",
    runId: run.id,
    stepId: null,
    kind: "screenshot",
    mime: "image/png",
    width: 1280,
    height: 800,
    hash: "hash",
    bytes: 68,
    storagePath: "2026/09/11/artifact-1.png",
    classification: allowed.includes("model") ? "internal" : "sensitive",
    protection: "none",
    retentionUntil: null,
    allowedDestinations: allowed,
    metadata: {},
    createdAt: new Date("2026-09-11T10:00:00.000Z"),
  };
}

type Calls = {
  created: {
    botId: string;
    userId: string | null;
    origin: string;
    objective: string;
    idempotencyKey?: string | null;
  }[];
  decisions: { runId: string; approvalId: string; decision: string; note?: string }[];
  messages: { runId: string; text: string; source: string }[];
  sent: TelegramOutgoing[];
  enqueued: number;
};

function harness(options: {
  allowed?: string[];
  bound?: boolean;
  pairing?: { userId: string; botId: string | null } | undefined;
  runRow?: typeof run;
  destinations?: string[];
  providerVision?: boolean;
} = {}) {
  const calls: Calls = {
    created: [],
    decisions: [],
    messages: [],
    sent: [],
    enqueued: 0,
  };
  const state = {
    binding: options.bound === false ? undefined : binding,
    row: options.runRow ?? run,
    artifact: artifact(options.destinations ?? ["panel", "model", "telegram"]),
  };

  const store = {
    bindingFor: async () => state.binding,
    bindingsForUser: async () => (state.binding ? [state.binding] : []),
    upsertBinding: async (input: {
      telegramUserId: string;
      chatId: string;
      userId: string;
      botId: string;
    }) => {
      state.binding = { ...binding, ...input };
      return state.binding;
    },
    consumePairingCode: async () => options.pairing,
    createPairingCode: async () => ({
      code: "CODE",
      expiresAt: new Date(),
    }),
    deleteBinding: async () => undefined,
    recordUpdate: async () => undefined,
    lastUpdateId: async () => 0,
    pendingUpdates: async () => [],
    markProcessed: async () => undefined,
    enqueue: async () => {
      calls.enqueued += 1;
    },
    claimNotifications: async () => [],
    markDelivered: async () => undefined,
    markFailed: async () => undefined,
    pendingForRun: async () => [],
  } as unknown as TelegramStore;

  const runs = {
    async getRun(id: string) {
      return id === state.row.id ? state.row : undefined;
    },
    async listRuns() {
      return [state.row];
    },
    async steps() {
      return [{ seq: 1, kind: "decision", status: "ok" }];
    },
    async createRun(
      actor: { id: string },
      input: {
        botId: string;
        userId: string | null;
        origin: string;
        objective: string;
        idempotencyKey?: string | null;
      },
    ) {
      calls.created.push(input);
      return { run: state.row, created: true, actor };
    },
    async pause() {
      return state.row;
    },
    async cancel() {
      return state.row;
    },
    async resume() {
      return state.row;
    },
    async appendMessage(runId: string, _actor: unknown, input: { text: string; source: string }) {
      calls.messages.push({ runId, text: input.text, source: input.source });
      return { run: state.row, message: { seq: 1, text: input.text } };
    },
    async decideApproval(
      runId: string,
      approvalId: string,
      _actor: unknown,
      decision: string,
      note?: string,
    ) {
      calls.decisions.push({ runId, approvalId, decision, ...(note ? { note } : {}) });
      return {
        run: state.row,
        approval: {
          id: approvalId,
          status: decision,
          actionName: "click",
          action: {},
          destination: null,
          expectedEffect: null,
          expiresAt: new Date().toISOString(),
          decidedBy: null,
          decidedAt: null,
          createdAt: new Date().toISOString(),
        },
      };
    },
  };

  const vision = {
    gateway: {
      screenshot: async () => ({
        base64: PIXEL_PNG,
        width: 1280,
        height: 800,
        capturedAt: "2026-09-11T10:00:00.000Z",
        url: "https://loja.test/produtos/novo",
        masked: 0,
      }),
    },
    artifacts: {
      capture: async () => state.artifact,
      read: async () => ({
        row: state.artifact,
        bytes: Buffer.from(PIXEL_PNG, "base64"),
      }),
    },
    sensitiveHosts: [] as string[],
    retentionDays: 7,
  };

  const providers = options.providerVision
    ? {
        get: (id: string) =>
          id === "seer"
            ? {
                id: "seer",
                capabilities: { vision: true, tools: false, streaming: false, mode: "step" },
                run: async () => ({ kind: "final", message: "A tela mostra um formulário." }),
              }
            : undefined,
        list: () => [
          { id: "seer", capabilities: { vision: true, tools: false, streaming: false, mode: "step" } },
        ],
      }
    : undefined;

  const handler = createTelegramHandler({
    store,
    // O dublê cobre exatamente o que o manipulador usa; o serviço de verdade tem a suíte dele.
    runs: runs as never,
    allowedUserIds: options.allowed ?? ["777"],
    vision: vision as never,
    ...(providers ? { providers: providers as never } : {}),
  });

  return { handler, calls, state };
}

function message(text: string, options: { from?: string; command?: boolean } = {}) {
  const match = /^\/([A-Za-z0-9_]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return {
    updateId: 1,
    message: {
      messageId: 10,
      chatId: "555",
      from: { id: options.from ?? "777" },
      text,
      ...(options.command !== false && match?.[1]
        ? { command: { name: match[1].toLowerCase(), argument: (match[2] ?? "").trim() } }
        : {}),
    },
  };
}

describe("a conversa do Telegram", () => {
  test("quem não está na lista recebe uma recusa, e nada acontece", async () => {
    const { handler, calls } = harness();
    const outgoing = await handler.handle(message("Abra o TikTok", { from: "999" }));
    expect(outgoing[0]?.kind).toBe("text");
    expect((outgoing[0] as { text: string }).text).toContain("não está autorizado");
    expect(calls.created.length).toBe(0);
  });

  test("um chat sem vínculo aprende a se vincular, e não cria tarefa", async () => {
    const { handler, calls } = harness({ bound: false });
    const outgoing = await handler.handle(message("Abra o TikTok"));
    expect((outgoing[0] as { text: string }).text).toContain("/start");
    expect(calls.created.length).toBe(0);
  });

  test("um código válido vincula o chat", async () => {
    const { handler, state } = harness({
      bound: false,
      pairing: { userId: "user-1", botId: "bot-1" },
    });
    const outgoing = await handler.handle(message("/start ABC123"));
    expect(state.binding?.userId).toBe("user-1");
    expect(state.binding?.botId).toBe("bot-1");
    expect((outgoing[0] as { text: string }).text).toContain("Pronto");
  });

  test("um código gasto não vincula ninguém", async () => {
    const { handler, state } = harness({ bound: false, pairing: undefined });
    const outgoing = await handler.handle(message("/start ABC123"));
    expect(state.binding).toBeUndefined();
    expect((outgoing[0] as { text: string }).text).toContain("não vale mais");
  });

  test("linguagem natural vira tarefa, com o mesmo runtime do painel", async () => {
    const { handler, calls } = harness();
    await handler.handle(message("Abra o TikTok e liste os campos do cadastro"));
    expect(calls.created[0]).toMatchObject({
      botId: "bot-1",
      userId: "user-1",
      origin: "telegram",
      objective: "Abra o TikTok e liste os campos do cadastro",
      idempotencyKey: "telegram:bot-1:1",
    });
  });

  test("me manda a tela devolve a captura, sem passar por modelo", async () => {
    const { handler, calls } = harness();
    const outgoing = await handler.handle(message("me manda a tela"));
    expect(outgoing[0]?.kind).toBe("photo");
    expect((outgoing[0] as { caption: string }).caption).toContain("esperando sua aprovação");
    expect(calls.created.length).toBe(0);
  });

  test("uma página sensível fica retida, e o chat recebe o motivo", async () => {
    const { handler } = harness({ destinations: ["panel"] });
    const outgoing = await handler.handle(message("/tela"));
    expect(outgoing[0]?.kind).toBe("text");
    expect((outgoing[0] as { text: string }).text).toContain("sensível");
  });

  test("analisar sem modelo que enxergue é dito, em vez de inventado", async () => {
    const { handler } = harness();
    const outgoing = await handler.handle(message("analise essa tela"));
    expect((outgoing[0] as { text: string }).text).toContain("vê imagens");
  });

  test("analisar com um modelo que vê volta a resposta dele", async () => {
    const { handler } = harness({ providerVision: true });
    const outgoing = await handler.handle(message("o que está aparecendo nessa tela?"));
    expect((outgoing[0] as { text: string }).text).toContain("formulário");
  });

  test("um botão de aprovar decide a aprovação da tarefa desta conversa", async () => {
    const { handler, calls } = harness();
    const outgoing = await handler.handle({
      updateId: 2,
      callback: {
        id: "callback-1",
        messageId: 11,
        chatId: "555",
        from: { id: "777" },
        data: `approve:${run.id}:approval-9`,
      },
    });
    expect(calls.decisions[0]).toMatchObject({
      runId: run.id,
      approvalId: "approval-9",
      decision: "approved",
    });
    expect((outgoing[0] as { answerCallbackId?: string }).answerCallbackId).toBe(
      "callback-1",
    );
  });

  test("um botão não alcança a tarefa de outra pessoa", async () => {
    const other = { ...run, userId: "user-2" };
    const { handler, calls } = harness({ runRow: other });
    const outgoing = await handler.handle({
      updateId: 3,
      callback: {
        id: "callback-2",
        messageId: 11,
        chatId: "555",
        from: { id: "777" },
        data: `approve:${other.id}:approval-9`,
      },
    });
    expect(calls.decisions.length).toBe(0);
    expect((outgoing[0] as { text: string }).text).toContain("Não encontrei");
  });

  test("/continuar com texto manda a resposta na conversa da tarefa", async () => {
    const { handler, calls } = harness();
    await handler.handle(message(`/continuar ${run.id} o código é 4821`));
    expect(calls.messages[0]).toMatchObject({
      runId: run.id,
      text: "o código é 4821",
      source: "telegram",
    });
  });
});
