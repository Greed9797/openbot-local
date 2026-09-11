/**
 * O que o Telegram precisa guardar, e nada além.
 *
 * Quatro coisas, cada uma resolvendo um problema que a plataforma cria:
 *
 * - O update é gravado antes de ser tratado. A plataforma reentrega o que não foi confirmado, e sem
 *   o registro a mesma frase viraria duas tarefas.
 * - O vínculo diz de quem é um chat. Um id de usuário do Telegram não é uma pessoa deste deployment,
 *   e é o vínculo (feito por um código de uso único) que faz essa tradução.
 * - O código de pareamento é de uso único e vence. É ele que impede que qualquer chat que descubra o
 *   bot vire uma pessoa autorizada.
 * - A caixa de saída separa "o que a tarefa quer dizer" de "conseguiu dizer". Uma queda do Telegram
 *   não é uma falha de tarefa; ela é uma linha que será tentada de novo.
 */
import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  notificationOutbox,
  telegramBindings,
  telegramInbox,
  telegramPairingCodes,
} from "../db/schema";

export type TelegramBindingRow = typeof telegramBindings.$inferSelect;
export type TelegramInboxRow = typeof telegramInbox.$inferSelect;
export type NotificationRow = typeof notificationOutbox.$inferSelect;

export type NotificationInput = {
  runId: string | null;
  channel: "telegram" | "web";
  destination: Record<string, unknown>;
  eventType: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
};

export interface TelegramStore {
  /** Grava o update antes de tratá-lo. Nada devolvido significa que já o tínhamos. */
  recordUpdate(input: {
    botId: string;
    updateId: number;
    payload: unknown;
  }): Promise<{ id: string; updateId: number } | undefined>;
  lastUpdateId(botId: string): Promise<number>;
  pendingUpdates(limit: number): Promise<TelegramInboxRow[]>;
  markProcessed(id: string, error?: string): Promise<void>;

  bindingFor(chatId: string): Promise<TelegramBindingRow | undefined>;
  bindingsForUser(userId: string): Promise<TelegramBindingRow[]>;
  upsertBinding(input: {
    telegramUserId: string;
    chatId: string;
    userId: string;
    botId: string;
  }): Promise<TelegramBindingRow>;
  deleteBinding(id: string): Promise<void>;

  createPairingCode(input: {
    code: string;
    userId: string;
    botId: string | null;
    ttlMs: number;
  }): Promise<{ code: string; expiresAt: Date }>;
  /** Consome o código e devolve para quem ele era. Um código já usado não devolve nada. */
  consumePairingCode(code: string): Promise<{ userId: string; botId: string | null } | undefined>;

  enqueue(input: NotificationInput): Promise<void>;
  claimNotifications(input: {
    limit: number;
    leaseMs: number;
  }): Promise<NotificationRow[]>;
  markDelivered(id: string): Promise<void>;
  markFailed(id: string, error: string, retryAt: Date): Promise<void>;
  pendingForRun(runId: string): Promise<NotificationRow[]>;
}

export function createTelegramStore(database: Database): TelegramStore {
  return {
    async recordUpdate({ botId, updateId, payload }) {
      const rows = await database
        .insert(telegramInbox)
        .values({
          telegramBotId: botId,
          updateId,
          // O update cru, como chegou: é ele que um reprocessamento vai reler.
          payload: payload as Record<string, unknown>,
        })
        .onConflictDoNothing({
          target: [telegramInbox.telegramBotId, telegramInbox.updateId],
        })
        .returning({ id: telegramInbox.id, updateId: telegramInbox.updateId });
      const row = rows[0];
      return row ? { id: row.id, updateId: Number(row.updateId) } : undefined;
    },

    async lastUpdateId(botId: string): Promise<number> {
      const [row] = await database
        .select({
          last: sql<number>`coalesce(max(${telegramInbox.updateId}), 0)`,
        })
        .from(telegramInbox)
        .where(eq(telegramInbox.telegramBotId, botId));
      return Number(row?.last ?? 0);
    },

    async pendingUpdates(limit: number) {
      return database
        .select()
        .from(telegramInbox)
        .where(isNull(telegramInbox.processedAt))
        .orderBy(asc(telegramInbox.updateId))
        .limit(limit);
    },

    async markProcessed(id, error) {
      await database
        .update(telegramInbox)
        .set({ processedAt: new Date(), ...(error ? { error } : {}) })
        .where(eq(telegramInbox.id, id));
    },

    async bindingFor(chatId: string) {
      const [row] = await database
        .select()
        .from(telegramBindings)
        .where(eq(telegramBindings.chatId, chatId))
        .orderBy(desc(telegramBindings.createdAt))
        .limit(1);
      return row;
    },

    async bindingsForUser(userId: string) {
      return database
        .select()
        .from(telegramBindings)
        .where(eq(telegramBindings.userId, userId))
        .orderBy(desc(telegramBindings.createdAt));
    },

    async upsertBinding(input) {
      const [row] = await database
        .insert(telegramBindings)
        .values({
          telegramUserId: input.telegramUserId,
          chatId: input.chatId,
          userId: input.userId,
          botId: input.botId,
          permissions: { runs: true },
        })
        .onConflictDoUpdate({
          target: [telegramBindings.telegramUserId, telegramBindings.chatId],
          set: { userId: input.userId, botId: input.botId },
        })
        .returning();
      return row;
    },

    async deleteBinding(id) {
      await database.delete(telegramBindings).where(eq(telegramBindings.id, id));
    },

    async createPairingCode({ code, userId, botId, ttlMs }) {
      const expiresAt = new Date(Date.now() + ttlMs);
      await database
        .insert(telegramPairingCodes)
        .values({ code, userId, botId, expiresAt });
      return { code, expiresAt };
    },

    async consumePairingCode(code) {
      const [row] = await database
        .update(telegramPairingCodes)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(telegramPairingCodes.code, code),
            isNull(telegramPairingCodes.consumedAt),
            sql`${telegramPairingCodes.expiresAt} > now()`,
          ),
        )
        .returning();
      if (!row) return undefined;
      return { userId: row.userId, botId: row.botId };
    },

    async enqueue(input) {
      await database
        .insert(notificationOutbox)
        .values({
          runId: input.runId,
          channel: input.channel,
          destination: input.destination,
          eventType: input.eventType,
          dedupeKey: input.dedupeKey,
          payload: input.payload,
        })
        // A mesma notificação duas vezes é uma linha só: o retry de uma tarefa não repete a mensagem.
        .onConflictDoNothing({
          target: [notificationOutbox.channel, notificationOutbox.dedupeKey],
        });
    },

    /**
     * Pega o que está pronto para sair, empurrando o relógio da próxima tentativa.
     *
     * A linha é reservada no mesmo UPDATE que a devolve — dois processos enviam ao mesmo tempo só se
     * um deles roubar a linha do outro, e para isso o `next_attempt_at` teria de voltar ao passado
     * entre a leitura e a escrita.
     */
    async claimNotifications({ limit, leaseMs }) {
      return database
        .update(notificationOutbox)
        .set({ nextAttemptAt: new Date(Date.now() + leaseMs) })
        .where(
          and(
            isNull(notificationOutbox.deliveredAt),
            or(
              isNull(notificationOutbox.nextAttemptAt),
              lte(notificationOutbox.nextAttemptAt, new Date()),
            ),
            eq(notificationOutbox.channel, "telegram"),
          ),
        )
        .returning()
        .then((rows) => rows.slice(0, limit));
    },

    async markDelivered(id) {
      await database
        .update(notificationOutbox)
        .set({ deliveredAt: new Date(), lastError: null })
        .where(eq(notificationOutbox.id, id));
    },

    async markFailed(id, error, retryAt) {
      await database
        .update(notificationOutbox)
        .set({
          lastError: error.slice(0, 500),
          nextAttemptAt: retryAt,
          attempts: sql`${notificationOutbox.attempts} + 1`,
        })
        .where(eq(notificationOutbox.id, id));
    },

    async pendingForRun(runId) {
      return database
        .select()
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.runId, runId),
            isNull(notificationOutbox.deliveredAt),
          ),
        )
        .orderBy(asc(notificationOutbox.createdAt));
    },
  };
}
