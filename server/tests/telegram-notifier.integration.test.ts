/**
 * O aviso que sai da tarefa.
 *
 * Uma tarefa que para pedindo aprovação precisa que a pessoa saiba disso, com o que vai ser feito e
 * com os botões para decidir. O que se fixa aqui é que o aviso é escrito uma vez — o executor pode
 * repetir o mesmo estado sem que a pessoa receba a mesma mensagem duas vezes — e que ele carrega a
 * ação exata que espera decisão.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createAgentRunRepository } from "../src/agent-runs/repository";
import { createAgentRunService } from "../src/agent-runs/service";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agentRuns, notificationOutbox, telegramBindings } from "../src/db/schema";
import { actionHashOf } from "../src/agent-runtime/loop";
import { createTelegramNotifier } from "../src/telegram/notifier";
import { createTelegramStore } from "../src/telegram/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  TEST_POOL,
);
const repository = createAgentRunRepository(database);
const store = createTelegramStore(database);
const service = createAgentRunService({
  repository,
  auditStore: createAuditStore(database),
  defaults: {
    provider: "scripted",
    model: "scripted-1",
    budget: { maxSteps: 5, maxMs: 30_000, maxCorrections: 0 },
    leaseTtlMs: 30_000,
  },
});
const notifier = createTelegramNotifier({ store, repository });

const botId = `notif-bot-${crypto.randomUUID().slice(0, 6)}`;
const chatId = `notif-chat-${crypto.randomUUID().slice(0, 6)}`;
const userId = `notif-user-${crypto.randomUUID().slice(0, 6)}`;
const created: string[] = [];

afterAll(async () => {
  if (created.length) {
    await database.delete(agentRuns).where(inArray(agentRuns.id, created));
  }
  await database
    .delete(telegramBindings)
    .where(eq(telegramBindings.chatId, chatId));
  await database
    .delete(notificationOutbox)
    .where(eq(notificationOutbox.destination, { chatId }));
});

describe("o aviso de uma tarefa", () => {
  test("uma aprovação pendente vira uma mensagem com os botões da ação", async () => {
    await store.upsertBinding({
      telegramUserId: "777",
      chatId,
      userId,
      botId,
    });
    const { run } = await service.createRun(
      { id: userId },
      { botId, userId, origin: "telegram", objective: "Publicar o produto." },
      userId,
    );
    created.push(run.id);

    const call = { name: "click", arguments: { ref: "e9", snapshotId: 1 } };
    await repository.insertApproval({
      runId: run.id,
      stepId: null,
      actorUserId: userId,
      actionHash: actionHashOf(call),
      action: call,
      destination: "https://loja.test/produtos/novo",
      expectedEffect: "Publicar o produto na loja.",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await notifier.statusChanged({
      runId: run.id,
      botId,
      userId,
      from: "running",
      to: "waiting_approval",
      message: "Aguardando aprovação para click.",
    });
    // O executor pode repetir o mesmo estado: a pessoa não recebe a mesma frase duas vezes.
    await notifier.statusChanged({
      runId: run.id,
      botId,
      userId,
      from: "running",
      to: "waiting_approval",
      message: "Aguardando aprovação para click.",
    });

    const pending = await store.pendingForRun(run.id);
    expect(pending.length).toBe(1);
    const payload = pending[0]?.payload as {
      text: string;
      buttons: { text: string; data: string }[][];
    };
    expect(payload.text).toContain("precisa de aprovação");
    expect(payload.text).toContain("Publicar o produto na loja.");
    const buttons = payload.buttons[0] ?? [];
    expect(buttons.map((button) => button.text)).toEqual([
      "Ver tela",
      "Aprovar",
      "Recusar",
    ]);
    expect(buttons[1]?.data.startsWith(`approve:${run.id}:`)).toBe(true);
  });

  test("um pedido de ajuda diz que a resposta é por ali", async () => {
    const { run } = await service.createRun(
      { id: userId },
      { botId, userId, origin: "telegram", objective: "Entrar no TikTok." },
      userId,
    );
    created.push(run.id);
    await notifier.statusChanged({
      runId: run.id,
      botId,
      userId,
      from: "running",
      to: "waiting_human",
      message: "Há um CAPTCHA na tela.",
    });
    const pending = await store.pendingForRun(run.id);
    const payload = pending[0]?.payload as { text: string };
    expect(payload.text).toContain("CAPTCHA");
    expect(payload.text).toContain("Responda por aqui");
  });

  test("sem vínculo para este Bot, ninguém é avisado", async () => {
    const { run } = await service.createRun(
      { id: userId },
      { botId: `${botId}-outro`, userId, origin: "web", objective: "Nada." },
      userId,
    );
    created.push(run.id);
    await notifier.statusChanged({
      runId: run.id,
      botId: `${botId}-outro`,
      userId,
      from: "running",
      to: "succeeded",
      message: "Pronto.",
    });
    expect(await store.pendingForRun(run.id)).toEqual([]);
  });
});
