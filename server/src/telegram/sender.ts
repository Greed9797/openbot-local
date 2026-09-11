/**
 * O laço que entrega o que a caixa de saída acumulou.
 *
 * Separado do executor de propósito: a plataforma cai, tem limite de taxa e às vezes responde 429
 * com um tempo para tentar de novo. Nada disso é assunto de uma tarefa, e uma tarefa não pode parar
 * porque um chat não recebeu o aviso.
 *
 * O intervalo cresce a cada falha, e para de crescer num teto: insistir a cada segundo num chat que
 * bloqueou o bot é uma forma de ser bloqueado de vez.
 */
import type { TelegramClient } from "./client";
import type { TelegramStore } from "./store";
import type { TelegramButton } from "./types";

const MAX_BACKOFF_MS = 15 * 60_000;
const CLAIM_LIMIT = 20;
const LEASE_MS = 60_000;

/** As tentativas de uma mensagem, em memória enquanto ela é tentada. */
const attempts = new Map<string, number>();

function backoffFor(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(attempt, 10));
}

export function createTelegramSender(options: {
  store: TelegramStore;
  client: TelegramClient;
  intervalMs?: number;
  signal?: AbortSignal;
}) {
  const interval = options.intervalMs ?? 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** Uma passagem: pega o que está pronto, tenta entregar, agenda o resto. */
  async function tick(): Promise<number> {
    const claimed = await options.store.claimNotifications({
      limit: CLAIM_LIMIT,
      leaseMs: LEASE_MS,
    });
    let delivered = 0;
    for (const row of claimed) {
      const destination = row.destination as { chatId?: unknown };
      const payload = row.payload as {
        text?: unknown;
        buttons?: unknown;
      };
      const chatId =
        typeof destination.chatId === "string" ? destination.chatId : undefined;
      const text = typeof payload.text === "string" ? payload.text : undefined;
      if (!chatId || !text) {
        await options.store.markFailed(
          row.id,
          "Notificação sem destino ou sem texto.",
          new Date(Date.now() + 24 * 60 * 60_000),
        );
        continue;
      }
      try {
        await options.client.sendMessage({
          chatId,
          text,
          ...(Array.isArray(payload.buttons)
            ? { buttons: payload.buttons as TelegramButton[][] }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        await options.store.markDelivered(row.id);
        attempts.delete(row.id);
        delivered += 1;
      } catch (error) {
        const attempt = (attempts.get(row.id) ?? row.attempts) + 1;
        attempts.set(row.id, attempt);
        const message =
          error instanceof Error ? error.message : "A entrega falhou.";
        await options.store.markFailed(
          row.id,
          message,
          new Date(Date.now() + backoffFor(attempt)),
        );
      }
    }
    return delivered;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      void tick()
        .catch((error) => {
          console.error("A entrega ao Telegram falhou.", error);
        })
        .finally(schedule);
    }, interval);
    timer.unref?.();
  }

  return {
    tick,
    start() {
      stopped = false;
      schedule();
      return Promise.resolve();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      return Promise.resolve();
    },
  };
}
