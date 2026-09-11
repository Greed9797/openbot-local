import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/**
 * Um chat do Telegram que opera um Bot deste deployment.
 *
 * `telegramUserId` é o número da conta no Telegram; `chatId` é a conversa. Guardar os dois é o que
 * permite uma pessoa desligar o vínculo sem derrubar o de outra no mesmo bot.
 */
export type TelegramBinding = {
  id: string;
  chatId: string;
  telegramUserId: string;
  botId: string;
  createdAt: string;
};

export type TelegramBindingsView = {
  /**
   * Se este deployment tem bot configurado.
   *
   * Falso não é erro: as rotas de pareamento só existem quando `TELEGRAM_BOT_TOKEN` está definido, e
   * um servidor sem bot responde 404. A tela precisa distinguir "não há Telegram aqui" de "a chamada
   * falhou", porque a primeira é um estado normal e a segunda é um problema.
   */
  available: boolean;
  bindings: TelegramBinding[];
};

/** O código de pareamento, como o servidor o devolve. */
export type PairingCode = {
  code: string;
  expiresAt: string;
  instructions: string;
};

export const telegramKeys = {
  all: ["telegram"] as const,
  bindings: () => ["telegram", "bindings"] as const,
};

export function telegramBindingsQueryOptions() {
  return queryOptions({
    queryKey: telegramKeys.bindings(),
    queryFn: async (): Promise<TelegramBindingsView> => {
      const response = await tryClient("/api/telegram/bindings");
      if (response.status === 404) {
        return { available: false, bindings: [] };
      }
      if (!response.ok) {
        throw new Error("Não foi possível carregar os chats ligados.");
      }
      const body = (await response.json()) as { bindings: TelegramBinding[] };
      return { available: true, bindings: body.bindings };
    },
  });
}
