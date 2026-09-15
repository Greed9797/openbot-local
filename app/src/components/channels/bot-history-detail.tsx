import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import type { ChannelSummary } from "@/lib/channels/queries";
import { readThreadMessages } from "@/lib/copilot/thread-messages";

/**
 * An old conversation, open for reading.
 *
 * Read-only on purpose: the composer is absent, not disabled, so there is no
 * draft to lose and no send path to guard. What it does offer is Continuar,
 * which hands the channel back — the parent makes it active. History is read
 * straight from the thread endpoint, the same source ChannelChat restores
 * from, so reopening shows what was actually said.
 */
export function BotHistoryDetail({
  botId,
  channel,
  onVoltar,
  onContinuar,
}: {
  botId: string;
  channel: ChannelSummary;
  onVoltar: () => void;
  onContinuar: (channel: ChannelSummary) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const leitura = useQuery({
    queryKey: ["bots", "conversas", botId, channel.id, nonce],
    queryFn: () => readThreadMessages(channel.threadId, botId),
    retry: false,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <button
          className="text-sm font-medium underline underline-offset-4"
          onClick={onVoltar}
          type="button"
        >
          Voltar
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {channel.name}
        </span>
        <button
          className="h-8 shrink-0 rounded-lg bg-foreground px-3 text-sm font-medium text-background"
          onClick={() => onContinuar(channel)}
          type="button"
        >
          Continuar
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {leitura.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Carregando histórico…
          </p>
        ) : null}
        {leitura.error ? (
          <div className="flex items-center gap-2" role="alert">
            <p className="text-sm text-muted-foreground">
              Não foi possível carregar o histórico.
            </p>
            <button
              className="text-sm font-medium underline underline-offset-4"
              onClick={() => setNonce((n) => n + 1)}
              type="button"
            >
              Tentar novamente
            </button>
          </div>
        ) : null}
        {leitura.data ? <ChatTranscript messages={leitura.data} /> : null}
      </div>
    </div>
  );
}
