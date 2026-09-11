/**
 * O que a tarefa quer dizer a quem a pediu.
 *
 * A notificação nasce aqui e vai para a caixa de saída, não para o Telegram: o executor termina um
 * passo e volta ao trabalho, e quem conversa com a plataforma é outro laço. A diferença importa
 * quando a plataforma está fora do ar — a tarefa não falha por isso, a mensagem espera.
 *
 * O que se manda é sempre uma decisão ou um fim: uma tarefa que anda não interrompe ninguém. E cada
 * mensagem tem uma chave de deduplicação derivada do que ela diz, porque o executor pode repetir o
 * mesmo estado (um lease perdido, um restart) sem que a pessoa receba a mesma frase duas vezes.
 */
import { createHash } from "node:crypto";
import type { AgentRunRepository } from "../agent-runs/repository";
import type { RunNotifier } from "../agent-runtime/contracts";
import type { TelegramStore } from "./store";
import type { TelegramButton } from "./types";

/** Depois disto, uma mensagem que ainda falha espera um dia em vez de insistir a cada minuto. */
const GIVE_UP_AFTER_HOURS = 24;

const STATUS_PT: Record<string, string> = {
  waiting_approval: "precisa de aprovação",
  waiting_human: "precisa de você",
  needs_reconciliation: "parou para conferência",
  succeeded: "concluiu",
  failed: "falhou",
  cancelled: "foi cancelada",
  paused: "foi pausada",
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function createTelegramNotifier(options: {
  store: TelegramStore;
  repository: AgentRunRepository;
}): RunNotifier {
  const { store, repository } = options;

  return {
    async statusChanged(event) {
      if (!event.userId) return;
      const bindings = (await store.bindingsForUser(event.userId)).filter(
        (binding) => binding.botId === event.botId,
      );
      if (!bindings.length) return;

      const short = event.runId.slice(0, 8);
      const label = STATUS_PT[event.to] ?? event.to;
      const lines = [`Tarefa ${short} ${label}.`];
      if (event.message) lines.push(event.message);

      let buttons: TelegramButton[][] = [[{ text: "Ver tela", data: `screen:${event.runId}` }]];
      let dedupeSuffix = "";
      if (event.to === "waiting_approval") {
        const pending = await repository.pendingApprovals(event.runId);
        const approval = pending.at(-1);
        if (approval) {
          const action =
            (approval.action as { name?: string } | null)?.name ?? "a ação";
          lines.push(
            `Ação: ${action} — ${approval.expectedEffect ?? "executar o que foi pedido"}.`,
          );
          if (approval.destination) lines.push(`Onde: ${approval.destination}`);
          buttons = [
            [
              { text: "Ver tela", data: `screen:${event.runId}` },
              {
                text: "Aprovar",
                data: `approve:${event.runId}:${approval.id}`,
              },
              {
                text: "Recusar",
                data: `deny:${event.runId}:${approval.id}`,
              },
            ],
          ];
          dedupeSuffix = `:${approval.id}`;
        }
      }
      if (event.to === "waiting_human") {
        lines.push("Responda por aqui que eu continuo de onde parei.");
      }
      if (event.to === "needs_reconciliation") {
        lines.push("Confirme no painel antes que eu continue.");
      }

      const text = lines.join("\n");
      const dedupeKey = `run:${event.runId}:${event.to}${dedupeSuffix}:${digest(text)}`;
      const destination = { chatIds: bindings.map((binding) => binding.chatId) };

      for (const binding of bindings) {
        await store.enqueue({
          runId: event.runId,
          channel: "telegram",
          destination: { chatId: binding.chatId, chatIds: destination.chatIds },
          eventType: event.to,
          dedupeKey: `${dedupeKey}:${binding.chatId}`,
          payload: {
            text,
            buttons,
            runId: event.runId,
            status: event.to,
            retryAfterHours: GIVE_UP_AFTER_HOURS,
          },
        });
      }
    },
  };
}
