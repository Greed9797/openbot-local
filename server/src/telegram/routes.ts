/**
 * O que o painel precisa para ligar um chat ao Telegram.
 *
 * Um código de uso único, e nada mais. É o único caminho pelo qual um chat passa a operar um Bot: quem
 * está dentro do painel escolhe o Bot, gera o código, e quem estiver com o Telegram nas mãos manda
 * `/start CODIGO`. Sem isso, qualquer pessoa que descobrisse o nome do bot criaria tarefas na conta
 * de outra.
 *
 * O código nasce com validade curta e é consumido no primeiro uso, inclusive quando o uso é de quem
 * não deveria — um código não fica "meio usado".
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { TelegramStore } from "./store";

/** Quanto tempo um código vive. Curto: é um segredo que viaja por um chat. */
const PAIRING_TTL_MS = 15 * 60_000;

/** Sem caracteres que se confundem lidos em voz alta ou no celular. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function pairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

export function createTelegramRoutes(
  store: TelegramStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/pairing-codes", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      botId?: unknown;
    };
    const botId = typeof body.botId === "string" ? body.botId.trim() : "";
    if (!botId) {
      return context.json({ error: "Escolha o Bot que este chat opera." }, 400);
    }
    const created = await store.createPairingCode({
      code: pairingCode(),
      userId: context.var.actor.id,
      botId,
      ttlMs: PAIRING_TTL_MS,
    });
    return context.json({
      code: created.code,
      expiresAt: created.expiresAt.toISOString(),
      instructions: `No Telegram, mande /start ${created.code} para este bot.`,
    });
  });

  routes.get("/bindings", requireUser, async (context) => {
    const bindings = await store.bindingsForUser(context.var.actor.id);
    return context.json({
      bindings: bindings.map((binding) => ({
        id: binding.id,
        chatId: binding.chatId,
        telegramUserId: binding.telegramUserId,
        botId: binding.botId,
        createdAt: binding.createdAt.toISOString(),
      })),
    });
  });

  /**
   * Desligar um chat.
   *
   * Só o dono. Um vínculo que outra pessoa não pode desfazer é um acesso que sobrevive à decisão de
   * quem o criou, e é por isso que este é o único lugar que apaga um vínculo.
   */
  routes.delete("/bindings/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    const mine = await store.bindingsForUser(context.var.actor.id);
    if (!mine.some((binding) => binding.id === id)) {
      return context.json({ error: "Vínculo não encontrado." }, 404);
    }
    await store.deleteBinding(id);
    return context.json({ removed: true });
  });

  return routes;
}
