/**
 * O pareamento, pela rota.
 *
 * É o único caminho pelo qual um chat passa a operar um Bot. O que se fixa aqui é que o código nasce
 * para uma pessoa e um Bot, que ele vale uma vez, e que um vínculo de outra pessoa não é desfeito por
 * engano.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { telegramBindings, telegramPairingCodes } from "../src/db/schema";
import { createTelegramRoutes } from "../src/telegram/routes";
import { createTelegramStore } from "../src/telegram/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  TEST_POOL,
);
const store = createTelegramStore(database);

const member: AuthenticatedActor = {
  id: "pair-user",
  email: "pair@example.com",
  name: "Pair",
  role: "user",
};
const otherUserId = `pair-other-${crypto.randomUUID().slice(0, 6)}`;
const chatId = `pair-chat-${crypto.randomUUID().slice(0, 6)}`;
const codes: string[] = [];

afterAll(async () => {
  if (codes.length) {
    await database
      .delete(telegramPairingCodes)
      .where(eq(telegramPairingCodes.code, codes[0] as string));
  }
  await database
    .delete(telegramBindings)
    .where(eq(telegramBindings.chatId, chatId));
});

function asActor(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function appFor(actor: AuthenticatedActor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/telegram", createTelegramRoutes(store, asActor(actor)));
  return app;
}

describe("as rotas do Telegram", () => {
  test("o código nasce para quem pediu e para o Bot escolhido", async () => {
    const response = await appFor(member).request("/api/telegram/pairing-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-pair" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      code: string;
      instructions: string;
    };
    codes.push(body.code);
    expect(body.code.length).toBe(8);
    expect(body.instructions).toContain(body.code);

    const consumed = await store.consumePairingCode(body.code);
    expect(consumed).toEqual({ userId: member.id, botId: "bot-pair" });
    // Uma vez só: o mesmo código não vale de novo.
    expect(await store.consumePairingCode(body.code)).toBeUndefined();
  });

  test("sem Bot escolhido, nenhum código é emitido", async () => {
    const response = await appFor(member).request("/api/telegram/pairing-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  test("um vínculo só é desfeito por quem é dono dele", async () => {
    const binding = await store.upsertBinding({
      telegramUserId: "888",
      chatId,
      userId: member.id,
      botId: "bot-pair",
    });
    const others = await appFor({ ...member, id: otherUserId }).request(
      `/api/telegram/bindings/${binding.id}`,
      { method: "DELETE" },
    );
    expect(others.status).toBe(404);

    const listed = await appFor(member).request("/api/telegram/bindings");
    const body = (await listed.json()) as { bindings: { id: string }[] };
    expect(body.bindings.some((row) => row.id === binding.id)).toBe(true);

    const removed = await appFor(member).request(
      `/api/telegram/bindings/${binding.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(await store.bindingFor(chatId)).toBeUndefined();
  });
});
