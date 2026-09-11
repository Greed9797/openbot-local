/**
 * O laço de leitura: long polling, e nada de webhook.
 *
 * Long polling é a escolha certa para este produto: um deployment local atrás de um roteador não tem
 * endereço público para a plataforma chamar, e um webhook exigiria abrir uma porta e um certificado
 * para receber mensagens de um bot. O modo de falha do polling é conhecido e tratado aqui — a
 * plataforma reentrega o que não foi confirmado, então o update é gravado antes de ser tratado, e o
 * `offset` sai da própria tabela: o que já está gravado não é pedido de novo.
 *
 * Cada update é tratado uma vez e a resposta é enviada na hora. O que falha é registrado com o erro
 * e não é tentado de novo sozinho: uma mensagem que derruba o manipulador derruba de novo, e o lugar
 * de descobrir isso é a tabela, não um laço infinito.
 */
import { TelegramApiError, type TelegramClient } from "./client";
import type { TelegramHandler } from "./handler";
import type { TelegramStore } from "./store";
import { parseUpdate } from "./types";
import type { TelegramOutgoing } from "./types";

/** Quanto o getUpdates pode ficar pendurado. A plataforma aceita até 50s. */
const POLL_TIMEOUT_SECONDS = 25;
/** Quando a plataforma falha, espera isto antes de tentar de novo. */
const ERROR_BACKOFF_MS = 5_000;

export type TelegramPollerOptions = {
  store: TelegramStore;
  handler: TelegramHandler;
  client: TelegramClient;
  /** Identidade do bot nas tabelas: um deployment pode ter mais de um. */
  botId: string;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
};

export function createTelegramPoller(options: TelegramPollerOptions) {
  let stopped = false;
  const { store, handler, client } = options;

  /** Entrega uma resposta, do jeito que ela pediu para sair. */
  async function send(outgoing: TelegramOutgoing): Promise<void> {
    if (outgoing.kind === "photo") {
      await client.sendPhoto({
        chatId: outgoing.chatId,
        bytes: outgoing.bytes,
        mime: outgoing.mime,
        ...(outgoing.caption ? { caption: outgoing.caption } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (outgoing.answerCallbackId) {
        await client.answerCallback({ callbackId: outgoing.answerCallbackId });
      }
      return;
    }
    await client.sendMessage({
      chatId: outgoing.chatId,
      text: outgoing.text,
      ...(outgoing.buttons ? { buttons: outgoing.buttons } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (outgoing.answerCallbackId) {
      await client.answerCallback({ callbackId: outgoing.answerCallbackId });
    }
  }

  /** Trata um update já gravado: o manipulador decide, o poller envia. */
  async function process(row: {
    id: string;
    payload: unknown;
  }): Promise<number> {
    const update = parseUpdate(row.payload);
    if (!update) {
      await store.markProcessed(row.id, "update sem mensagem nem clique");
      return 0;
    }
    try {
      const outgoing = await handler.handle(update);
      for (const message of outgoing) {
        await send(message);
      }
      await store.markProcessed(row.id);
      return 1;
    } catch (error) {
      await store.markProcessed(
        row.id,
        error instanceof Error ? error.message : "falha ao tratar o update",
      );
      options.onError?.(error);
      return 0;
    }
  }

  /** O que ficou por tratar de uma execução anterior, antes de pedir coisa nova. */
  async function drain(limit = 20): Promise<number> {
    const pending = await store.pendingUpdates(limit);
    let handled = 0;
    for (const row of pending) {
      handled += await process(row);
    }
    return handled;
  }

  async function tick(): Promise<number> {
    let handled = await drain();
    const offset = (await store.lastUpdateId(options.botId)) + 1;
    const updates = await client.getUpdates({
      offset,
      timeoutSeconds: POLL_TIMEOUT_SECONDS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    for (const raw of updates) {
      const parsed = parseUpdate(raw);
      if (!parsed) continue;
      // Gravado antes de tratado: a reentrega encontra a linha e para.
      const recorded = await store.recordUpdate({
        botId: options.botId,
        updateId: parsed.updateId,
        payload: raw,
      });
      if (!recorded) continue;
      handled += await process({ id: recorded.id, payload: raw });
    }
    return handled;
  }

  /** Uma execução: lê e trata até o processo parar. */
  async function run(): Promise<void> {
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        const status = error instanceof TelegramApiError ? error.status : undefined;
        if (status === 401 || status === 404) {
          // Token errado ou bot inexistente: tentar de novo não vai consertar nada.
          console.error(
            "O Telegram recusou o token deste Bot. Corrija TELEGRAM_BOT_TOKEN e reinicie.",
          );
          return;
        }
        options.onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
      }
    }
  }

  return {
    tick,
    drain,
    run,
    start(): Promise<void> {
      stopped = false;
      void run();
      return Promise.resolve();
    },
    async stop(): Promise<void> {
      stopped = true;
    },
  };
}
