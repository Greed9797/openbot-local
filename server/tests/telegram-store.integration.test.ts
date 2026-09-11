/**
 * O armazenamento do canal, sobre o banco de verdade.
 *
 * O que se fixa aqui são as duas garantias que a plataforma obriga a ter: um update reentregue não
 * vira trabalho duas vezes, e um código de pareamento vale uma vez só. A terceira é a caixa de saída:
 * a mesma notificação não é enfileirada duas vezes, e o que foi entregue não é entregue de novo.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  notificationOutbox,
  telegramBindings,
  telegramInbox,
  telegramPairingCodes,
} from "../src/db/schema";
import { createTelegramStore } from "../src/telegram/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  TEST_POOL,
);
const store = createTelegramStore(database);

const botId = `bot-${crypto.randomUUID().slice(0, 8)}`;
const chatId = `chat-${crypto.randomUUID().slice(0, 8)}`;
const runId = crypto.randomUUID();
const codeSpent = `SPENT${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
const codeAlive = `ALIVE${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

afterAll(async () => {
  await database
    .delete(telegramInbox)
    .where(eq(telegramInbox.telegramBotId, botId));
  await database
    .delete(telegramBindings)
    .where(eq(telegramBindings.chatId, chatId));
  await database
    .delete(notificationOutbox)
    .where(eq(notificationOutbox.runId, runId));
  await database
    .delete(telegramPairingCodes)
    .where(inArray(telegramPairingCodes.code, [codeSpent, codeAlive]));
});

describe("o registro de updates", () => {
  test("o mesmo update não é gravado duas vezes", async () => {
    const first = await store.recordUpdate({
      botId,
      updateId: 10,
      payload: { update_id: 10 },
    });
    expect(first).toBeDefined();

    const again = await store.recordUpdate({
      botId,
      updateId: 10,
      payload: { update_id: 10 },
    });
    expect(again).toBeUndefined();
    expect(await store.lastUpdateId(botId)).toBe(10);
    if (!first) throw new Error("o update devia ter sido gravado");
    await store.markProcessed(first.id);
  });

  test("o que foi tratado sai da fila, e o que falhou fica com o motivo", async () => {
    await store.recordUpdate({ botId, updateId: 11, payload: { update_id: 11 } });
    await store.recordUpdate({ botId, updateId: 12, payload: { update_id: 12 } });

    const pending = await store.pendingUpdates(10);
    const mine = pending.filter((row) => row.telegramBotId === botId);
    expect(mine.map((row) => row.updateId).sort((a, b) => a - b)).toEqual([11, 12]);

    const first = mine[0];
    const second = mine[1];
    if (!first || !second) throw new Error("os dois updates deviam estar na fila");
    await store.markProcessed(first.id);
    await store.markProcessed(second.id, "o manipulador falhou");

    const left = (await store.pendingUpdates(10)).filter(
      (row) => row.telegramBotId === botId,
    );
    expect(left).toEqual([]);
    const [failed] = await database
      .select()
      .from(telegramInbox)
      .where(eq(telegramInbox.updateId, 12));
    expect(failed?.error).toBe("o manipulador falhou");
  });
});

describe("os códigos de pareamento", () => {
  test("um código vale uma vez", async () => {
    await store.createPairingCode({
      code: codeSpent,
      userId: "user-1",
      botId: "bot-1",
      ttlMs: 60_000,
    });
    const consumed = await store.consumePairingCode(codeSpent);
    expect(consumed).toEqual({ userId: "user-1", botId: "bot-1" });
    expect(await store.consumePairingCode(codeSpent)).toBeUndefined();
  });

  test("um código vencido não vale", async () => {
    await store.createPairingCode({
      code: codeAlive,
      userId: "user-1",
      botId: "bot-1",
      ttlMs: -1_000,
    });
    expect(await store.consumePairingCode(codeAlive)).toBeUndefined();
  });

  test("vincular o mesmo chat de novo atualiza o vínculo em vez de duplicar", async () => {
    const first = await store.upsertBinding({
      telegramUserId: "777",
      chatId,
      userId: "user-1",
      botId: "bot-1",
    });
    const second = await store.upsertBinding({
      telegramUserId: "777",
      chatId,
      userId: "user-1",
      botId: "bot-2",
    });
    expect(second.id).toBe(first.id);
    expect(second.botId).toBe("bot-2");
    expect((await store.bindingsForUser("user-1")).some((row) => row.chatId === chatId)).toBe(
      true,
    );
  });
});

describe("a caixa de saída", () => {
  const dedupeKey = `test:${crypto.randomUUID()}`;

  test("a mesma notificação entra uma vez e sai quando entregue", async () => {
    await store.enqueue({
      runId,
      channel: "telegram",
      destination: { chatId },
      eventType: "waiting_approval",
      dedupeKey,
      payload: { text: "Tarefa precisa de aprovação." },
    });
    await store.enqueue({
      runId,
      channel: "telegram",
      destination: { chatId },
      eventType: "waiting_approval",
      dedupeKey,
      payload: { text: "Tarefa precisa de aprovação." },
    });

    const claimedRows = (
      await store.claimNotifications({ limit: 50, leaseMs: 1_000 })
    ).filter((row) => row.dedupeKey === dedupeKey);
    expect(claimedRows.length).toBe(1);
    const claimed = claimedRows[0];
    if (!claimed) throw new Error("a notificação devia ter sido reservada");

    await store.markDelivered(claimed.id);
    const again = (await store.claimNotifications({ limit: 50, leaseMs: 1_000 })).filter(
      (row) => row.dedupeKey === dedupeKey,
    );
    expect(again).toEqual([]);
    expect(await store.pendingForRun(runId)).toEqual([]);
  });

  test("uma falha não perde a mensagem: ela volta com o motivo", async () => {
    const failing = `${dedupeKey}:fail`;
    await store.enqueue({
      runId,
      channel: "telegram",
      destination: { chatId },
      eventType: "failed",
      dedupeKey: failing,
      payload: { text: "A tarefa falhou." },
    });
    const [claimed] = (
      await store.claimNotifications({ limit: 50, leaseMs: 0 })
    ).filter((row) => row.dedupeKey === failing);
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error("a notificação devia ter sido reservada");

    await store.markFailed(claimed.id, "chat não encontrado", new Date(Date.now() - 1));
    const retried = (
      await store.claimNotifications({ limit: 50, leaseMs: 1_000 })
    ).filter((row) => row.dedupeKey === failing);
    expect(retried.length).toBe(1);
    expect(retried[0]?.attempts).toBe(1);
    expect(retried[0]?.lastError).toBe("chat não encontrado");
    const done = retried[0];
    if (!done) throw new Error("a mensagem devia voltar para a fila");
    await store.markDelivered(done.id);
  });
});
