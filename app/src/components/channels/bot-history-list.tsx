import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import {
  botConversasQueryOptions,
  botKeys,
  type ChannelSummary,
} from "@/lib/channels/queries";
import { client } from "@/lib/client";

/**
 * The History tab: one bot's hidden conversations, searchable, paged.
 *
 * Search re-keys the infinite query, so every keystroke the server answers,
 * not the fetched pages. Opening an item hands the channel up; this list
 * never renders the transcript itself. Nova conversa creates a hidden
 * channel and hands it up the same way, so the parent decides what becomes
 * active — the list only announces.
 */
export function BotHistoryList({
  botId,
  onAbrir,
  onNovaConversa,
}: {
  botId: string;
  onAbrir: (channel: ChannelSummary) => void;
  onNovaConversa: (channel: {
    id: string;
    name: string;
    agentIds: string[];
    threadId: string;
    active: boolean;
  }) => void;
}) {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState("");
  const historico = useInfiniteQuery(botConversasQueryOptions(botId, busca));
  const nova = useMutation({
    mutationFn: async () => {
      const response = await client("/api/channels", {
        method: "POST",
        body: { agentIds: [botId], visivelNoRoster: false },
        fallback: "Não foi possível começar uma conversa",
      });
      return (
        (await response.json()) as {
          channel: {
            id: string;
            name: string;
            agentIds: string[];
            threadId: string;
            active: boolean;
          };
        }
      ).channel;
    },
    onSuccess: (channel) => {
      /*
       * Only this bot's History. The roster is deliberately left alone: the channel was created
       * with `visivelNoRoster: false`, so `GET /api/channels` excludes it and a refetch would ask
       * the server for a list that cannot have changed — the same churn the socket path avoids.
       */
      void queryClient.invalidateQueries({ queryKey: botKeys.all });
      onNovaConversa(channel);
    },
  });

  const itens = historico.data?.pages.flatMap((page) => page.conversas) ?? [];

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <div className="flex gap-2">
        <input
          aria-label="Buscar no histórico"
          className="h-9 flex-1 rounded-lg border bg-background px-3 text-sm"
          onChange={(event) => setBusca(event.target.value)}
          placeholder="Buscar nas conversas…"
          value={busca}
        />
        <button
          className="h-9 shrink-0 rounded-lg bg-foreground px-3 text-sm font-medium text-background disabled:opacity-50"
          disabled={nova.isPending}
          onClick={() => nova.mutate()}
          type="button"
        >
          Nova conversa
        </button>
      </div>
      {nova.error ? (
        <p className="text-sm text-destructive" role="alert">
          Não foi possível começar uma conversa. Tente de novo.
        </p>
      ) : null}
      {historico.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          Carregando histórico…
        </p>
      ) : null}
      {historico.error ? (
        <div className="flex items-center gap-2" role="alert">
          <p className="text-sm text-muted-foreground">
            Não foi possível carregar o histórico.
          </p>
          <button
            className="text-sm font-medium underline underline-offset-4"
            onClick={() => historico.refetch()}
            type="button"
          >
            Tentar novamente
          </button>
        </div>
      ) : null}
      {!historico.isPending && !historico.error && itens.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          {busca.trim()
            ? `Nada aqui se chama “${busca.trim()}”.`
            : "Nenhuma conversa ainda. Comece uma nova."}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1 overflow-y-auto">
        {itens.map((item) => (
          <li key={item.id}>
            <button
              className="w-full rounded-lg px-3 py-2 text-left hover:bg-foreground/5"
              onClick={() => onAbrir(item)}
              type="button"
            >
              <span className="block truncate text-sm font-medium">
                {item.name}
              </span>
              {item.lastMessage ? (
                <span className="block truncate text-sm text-muted-foreground">
                  {item.lastMessage}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {historico.hasNextPage ? (
        <button
          className="self-center text-sm font-medium underline underline-offset-4 disabled:opacity-50"
          disabled={historico.isFetchingNextPage}
          onClick={() => historico.fetchNextPage()}
          type="button"
        >
          Carregar mais
        </button>
      ) : null}
    </div>
  );
}
