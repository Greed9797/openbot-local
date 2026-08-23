import {
  CopilotChat,
  CopilotChatConfigurationProvider,
} from "@copilotkit/react-core/v2";
import { createFileRoute } from "@tanstack/react-router";
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
  /*
   * O Assistente, e não o analista de risco.
   *
   * Esta tela se chama "Bot de navegador" e abria no Bot cujo papel é investigar políticas e
   * monitoramento de transações — e o papel aparece na resposta: perguntado de forma vaga, ele
   * ofereceu avaliar evidências de controle em vez de perguntar qual era a página. Quem abre esta
   * tela quer o colega de uso geral.
   */
  const agentId = agent ?? "general-assistant";

  // Tool calls here act on this Bot's own computer.
  useActiveBot(agentId);
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
    <div className="flex h-screen flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Bot de navegador</h1>
        <p className="text-sm text-muted-foreground">
          Peça para ele abrir uma página e acompanhe o trabalho.
        </p>
      </header>
      {/*
       * Under the header rather than at the end of the transcript, which is where the missing answer
       * was going to be and where the channel draws its own version of this. The packaged chat owns
       * that list and virtualises it, so reaching into it means replacing the whole message view and
       * taking on its scrolling. The cost of putting the sentence here instead is that it is not
       * beside the gap it explains; what it buys is that it is always on screen, whatever the
       * transcript has been scrolled to, and that it survives the next release of the chat.
       */}
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
        {/* Remount when switching Bots so chat state stays bound to the selected agent. */}
        {threadId ? (
          /*
           * O provedor existe aqui só para os rótulos. O `CopilotChat` monta um por conta própria
           * quando não encontra nenhum, e é o dele que traz os textos em inglês; montar este por
           * fora é o caminho que a biblioteca oferece para trocá-los.
           */
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
