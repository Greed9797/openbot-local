/**
 * O laço de leitura, com um Telegram de mentira.
 *
 * O teste que importa é o da reentrega: a plataforma manda o mesmo update de novo quando não teve
 * confirmação, e um agente que cria duas tarefas para a mesma frase é pior do que um que não
 * responde. O resto é a ordem — gravar antes de tratar, responder depois de decidir.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { telegramInbox } from "../src/db/schema";
import type { TelegramClient } from "../src/telegram/client";
import { createTelegramHandler } from "../src/telegram/handler";
import { createTelegramPoller } from "../src/telegram/poller";
import { createTelegramStore } from "../src/telegram/store";
import type { TelegramStore } from "../src/telegram/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  TEST_POOL,
);
const store = createTelegramStore(database);
const botId = `poll-${crypto.randomUUID().slice(0, 8)}`;
const chatId = `poll-chat-${crypto.randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.delete(telegramInbox).where(eq(telegramInbox.telegramBotId, botId));
});

/** Um cliente que devolve o que foi combinado e anota o que mandaram. */
function fakeClient(updates: unknown[][], sent: string[]) {
  let call = 0;
  return {
    async getUpdates() {
      const batch = updates[Math.min(call, updates.length - 1)] ?? [];
      call += 1;
      return batch;
    },
    async sendMessage(options: { chatId: string; text: string }) {
      sent.push(`${options.chatId}:${options.text}`);
      return { messageId: 1 };
    },
    async sendPhoto(options: { chatId: string }) {
      sent.push(`${options.chatId}:[foto]`);
      return { messageId: 2 };
    },
    async answerCallback() {
      return undefined;
    },
  } as unknown as TelegramClient;
}

function updateRequest(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      chat: { id: Number(chatId.replace(/\D/g, "")) || 555 },
      from: { id: 777 },
      text,
    },
  };
}

function pollerWith(options: { updates: unknown[][]; sent: string[]; handled: string[] }) {
  const handler = {
    async handle(update: { message?: { text: string } }) {
      options.handled.push(update.message?.text ?? "");
      return [
        {
          kind: "text" as const,
          chatId,
          text: `recebi: ${update.message?.text ?? ""}`,
        },
      ];
    },
  };
  const poller = createTelegramPoller({
    store,
    handler,
    client: fakeClient(options.updates, options.sent),
    botId,
  });
  return poller;
}

describe("o laço de leitura", () => {
  test("um update é tratado uma vez, e o reentrega não vira trabalho de novo", async () => {
    const sent: string[] = [];
    const handled: string[] = [];
    const update = updateRequest(101, "Abra o TikTok");
    const poller = pollerWith({ updates: [[update], [update]], sent, handled });

    expect(await poller.tick()).toBe(1);
    expect(handled).toEqual(["Abra o TikTok"]);
    expect(sent.length).toBe(1);

    // A plataforma reentrega o mesmo update: nada é tratado de novo.
    expect(await poller.tick()).toBe(0);
    expect(handled).toEqual(["Abra o TikTok"]);
    expect(sent.length).toBe(1);
  });

  test("um update que falha fica registrado, sem derrubar o laço", async () => {
    const sent: string[] = [];
    const handled: string[] = [];
    const store = createTelegramStore(database);
    const failing: TelegramStore = {
      ...store,
      async markProcessed(id, error) {
        await store.markProcessed(id, error);
      },
    };
    const poller = createTelegramPoller({
      store: failing,
      handler: {
        async handle() {
          throw new Error("o manipulador quebrou");
        },
      },
      client: fakeClient([[updateRequest(102, "qualquer coisa")]], sent),
      botId,
      onError: () => undefined,
    });

    expect(await poller.tick()).toBe(0);
    const [row] = await database
      .select()
      .from(telegramInbox)
      .where(eq(telegramInbox.updateId, 102));
    expect(row?.error).toContain("quebrou");
    expect(row?.processedAt).not.toBeNull();
    expect(handled).toEqual([]);
  });

  test("o que ficou pendente de uma execução anterior é tratado antes de pedir updates", async () => {
    const pending = updateRequest(103, "mensagem antiga");
    await store.recordUpdate({ botId, updateId: 103, payload: pending });

    const sent: string[] = [];
    const handled: string[] = [];
    const poller = pollerWith({ updates: [[]], sent, handled });
    expect(await poller.drain()).toBeGreaterThan(0);
    expect(handled).toEqual(["mensagem antiga"]);
    expect(sent).toEqual([`${chatId}:recebi: mensagem antiga`]);
  });
});

describe("quem fala com o bot", () => {
  test("o manipulador real cria a tarefa pelo serviço, com a chave da mensagem", async () => {
    const created: { idempotencyKey?: string | null; origin: string }[] = [];
    const handler = createTelegramHandler({
      store: {
        ...store,
        async bindingFor() {
          return {
            id: "b",
            telegramUserId: "777",
            chatId,
            userId: "user-1",
            botId: "bot-1",
            permissions: {},
            createdAt: new Date(),
          };
        },
      },
      runs: {
        async createRun(
          _actor: unknown,
          input: { idempotencyKey?: string | null; origin: string },
        ) {
          created.push(input);
          return {
            run: { id: "run-1", status: "queued", currentStep: 0, objective: "x" },
            created: true,
          };
        },
      } as never,
      allowedUserIds: ["777"],
    });

    const outgoing = await handler.handle({
      updateId: 500,
      message: {
        messageId: 5000,
        chatId,
        from: { id: "777" },
        text: "Abra o TikTok",
      },
    });
    expect(created[0]?.idempotencyKey).toBe("telegram:bot-1:500");
    expect(created[0]?.origin).toBe("telegram");
    expect(outgoing[0]?.kind).toBe("text");
  });
});
