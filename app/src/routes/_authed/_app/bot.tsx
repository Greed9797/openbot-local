import {
  CopilotChat,
  CopilotChatConfigurationProvider,
} from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BotTabs } from "@/components/bot/bot-tabs";
import { BotHistoryDetail } from "@/components/channels/bot-history-detail";
import { BotHistoryList } from "@/components/channels/bot-history-list";
import { ChannelChat } from "@/components/channels/channel-chat";
import { agentQueryOptions } from "@/lib/agents/queries";
import type { AgentChannel, ChannelSummary } from "@/lib/channels/queries";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useBotThread } from "@/lib/copilot/bot-thread";
import { RÓTULOS_DO_CHAT } from "@/lib/copilot/chat-labels";
import { useStoppedTurn } from "@/lib/copilot/stopped-turn";

export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  return <BotPage agentId={agent ?? "general-assistant"} />;
}

/**
 * One Bot's fixed page: the conversation on one tab, everything said before on the other.
 */
export function BotPage({ agentId }: { agentId: string }) {
  // Tool calls here act on this Bot's own computer.
  useActiveBot(agentId);
  const perfil = useQuery(agentQueryOptions(agentId));

  /*
   * Unknown `?agent=`: the dito state, not an empty chat. The profile query is the lookup, so a
   * profile that will not load is a Bot that is not there for us.
   *
   * Nothing renders while it is in flight, and the chat lives in a child rather than here, so the
   * runtime is never bound for a Bot that turns out not to exist.
   */
  if (perfil.isPending) return null;
  if (perfil.error || !perfil.data) {
    return (
      <div className="flex h-screen flex-col">
        <header className="border-b px-6 py-3">
          <h1 className="text-lg font-semibold">Bot de navegador</h1>
        </header>
        <p className="p-8 text-sm text-destructive" role="alert">
          Não foi possível carregar este colega.
        </p>
      </div>
    );
  }

  return <BotChat agentId={agentId} />;
}

function BotChat({ agentId }: { agentId: string }) {
  const [aba, setAba] = useState<"conversa" | "historico">("conversa");
  const [aberto, setAberto] = useState<ChannelSummary | null>(null);
  /*
   * Null until a conversation of this Bot's own is opened, which is what Continue and Nova conversa
   * do. Until then the tab holds the direct chat, on the thread this deployment mints for the Bot.
   */
  const [ativa, setAtiva] = useState<AgentChannel | null>(null);

  /**
   * Bring a conversation to the Conversa tab and go there.
   *
   * Switching the tab is part of it: continuing a conversation and then having to find the tab by
   * hand would be the same as not having continued it.
   */
  function abrirNaConversa(canal: AgentChannel) {
    setAtiva(canal);
    setAberto(null);
    setAba("conversa");
  }

  const conversa = ativa ? (
    <ChannelChat channel={ativa} key={ativa.id} runtimeAgentId={agentId} />
  ) : (
    <BotDirectChat agentId={agentId} />
  );

  const historico = aberto ? (
    <BotHistoryDetail
      botId={agentId}
      channel={aberto}
      onContinuar={abrirNaConversa}
      onVoltar={() => setAberto(null)}
    />
  ) : (
    <BotHistoryList
      botId={agentId}
      onAbrir={(canal) => setAberto(canal)}
      onNovaConversa={abrirNaConversa}
    />
  );

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Bot de navegador</h1>
        <p className="text-sm text-muted-foreground">
          Peça para ele abrir uma página e acompanhe o trabalho.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <BotTabs
          conversa={conversa}
          historico={historico}
          onValueChange={setAba}
          value={aba}
        />
      </div>
    </div>
  );
}

function BotDirectChat({ agentId }: { agentId: string }) {
  // Minted by this deployment rather than by the chat, and the same one on the next visit.
  const threadId = useBotThread(agentId);
  /*
   * A turn that ends without an answer has to be said out loud here, because the packaged chat says
   * nothing. It reports a failed run to an `onError` prop and otherwise carries on as though the
   * turn simply finished: the composer unlocks, the spinner goes, and the transcript keeps the
   * person's own message with nothing under it. The banner that would have explained it belongs to
   * a provider this app does not mount.
   */
  const stopped = useStoppedTurn(agentId);

  return (
    <div className="flex h-full flex-col">
      {stopped ? (
        <p
          className="border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
          data-testid="bot-chat-stopped"
          role="alert"
        >
          {stopped}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {threadId ? (
          <CopilotChatConfigurationProvider
            agentId={agentId}
            labels={RÓTULOS_DO_CHAT}
            threadId={threadId}
          >
            <CopilotChat agentId={agentId} key={agentId} threadId={threadId} />
          </CopilotChatConfigurationProvider>
        ) : null}
      </div>
    </div>
  );
}
