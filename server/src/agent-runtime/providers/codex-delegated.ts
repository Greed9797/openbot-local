/**
 * O Codex como provedor, no modo delegado.
 *
 * Este é o outro jeito que o PRD prevê (D-05): em vez de o runtime conduzir observar→decidir→agir, a
 * tarefa inteira é entregue ao serviço do Codex, que conduz o próprio ciclo com as ferramentas de
 * navegador que já existem — as mesmas, pelo mesmo gateway. Empilhar dois planejadores sobre a mesma
 * página não é uma arquitetura, é uma corrida.
 *
 * O que este adaptador NÃO faz: reimplementar o `codex exec`, as sessões ou o servidor MCP. Ele fala
 * AG-UI com o serviço que já é dono disso. Sem o serviço configurado, ele diz isso e a tarefa falha
 * com `PROVIDER_UNAVAILABLE` em vez de fingir que executou.
 */
import { HttpAgent } from "@ag-ui/client";
import type { AgentModelProvider, AgentRunInput, AgentRunResult } from "../contracts";
import { historyBlock } from "../prompt";
import { ProviderRejectedError, ProviderUnavailableError } from "./http";

export type CodexDelegatedOptions = {
  id?: string;
  /** O endereço AG-UI do serviço do Codex (`.../ag-ui`, tipicamente). */
  endpoint: string;
  /** Só informativo: quem escolhe o modelo é o serviço do Codex. Fica registrado no run. */
  model: string;
  /**
   * O token que este deployment apresenta ao Bot gerenciado.
   *
   * O serviço do Codex recusa quem chega sem ele (`x-openbot-agent-token`, o mesmo contrato do
   * `hasManagedAgentToken`). Sem isto o runtime levava 401 do próprio serviço que ele deveria estar
   * conduzindo — descoberto no primeiro deploy real, porque este adaptador não tinha teste de fio.
   */
  token?: string;
  /**
   * Assina a declaração de execução desta tarefa — ver `server/src/agents/callback-token.ts`.
   *
   * O serviço do Codex repassa o resultado ao servidor MCP, que o devolve em cada chamada de
   * ferramenta; é assim que o deployment sabe qual Bot e qual pessoa estão agindo. Sem isso o
   * servidor MCP sai no boot, o `codex exec` termina em erro e a tarefa morre sem nunca tocar a
   * página — descoberto no primeiro run delegado de verdade, com o log do serviço dizendo
   * "declaração de execução AUSENTE".
   *
   * Vive aqui como função, e não como chave: quem tem a chave é o processo que monta o provedor, e
   * este módulo não guarda segredo nenhum.
   */
  signRun?: (run: {
    botId: string;
    runId: string;
    actorId: string;
  }) => string;
  /**
   * Se o modelo que roda dentro do CLI enxerga a página.
   *
   * Vem do deployment (`AGENT_CODEX_VISION`, `AGENT_OPENCODE_VISION`, `AGENT_MIMO_VISION`), e não
   * daqui, porque é a única parte das capacidades que este arquivo não pode saber: o CLI é dado de
   * configuração, e o modelo dele também. Presumido verdadeiro, que é o caso da maioria.
   *
   * O que fica sendo decisão deste adaptador é o resto: `tools: false` porque o runtime não entrega
   * catálogo de ferramentas a quem conduz o próprio ciclo, e `streaming: true` porque o transporte
   * AG-UI responde em fluxo.
   */
  vision?: boolean;
  /** Para o teste de fio: o `fetch` que o transporte HTTP usa por baixo. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createCodexDelegatedProvider(
  options: CodexDelegatedOptions,
): AgentModelProvider {
  return {
    id: options.id ?? "codex",
    capabilities: {
      // O serviço tem visão pelo MCP e ferramentas próprias; quem as executa é ele. Se o modelo dele
      // enxerga imagem é o deployment que diz — ver `vision` nas opções.
      vision: options.vision ?? true,
      tools: false,
      streaming: true,
      mode: "delegated",
    },

    async run(input: AgentRunInput, context): Promise<AgentRunResult> {
      if (!options.endpoint) {
        throw new ProviderRejectedError(
          `O provedor ${options.id ?? "codex"} não está configurado: falta o endereço AG-UI do serviço.`,
        );
      }

      const agent = new HttpAgent({
        url: options.endpoint,
        agentId: options.id ?? "codex",
        // O serviço do Codex é um Bot gerenciado: ele valida o token do deployment antes de aceitar
        // qualquer coisa. Sem este cabeçalho a resposta é 401, e o erro aparece como
        // PROVIDER_UNAVAILABLE na tarefa — que é honesto, mas aponta para o lugar errado.
        ...(options.token
          ? { headers: { "x-openbot-agent-token": options.token } }
          : {}),
        ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
        // Uma thread por tarefa: é assim que o serviço do Codex retoma a sessão dele em vez de
        // começar de novo a cada run.
        threadId: input.runId,
        initialMessages: [
          {
            id: `${input.runId}-objective`,
            role: "user",
            content: delegatedObjective(input),
          },
        ],
      });

      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal.addEventListener("abort", abort, { once: true });

      let text = "";
      let toolCalls = 0;
      /**
       * O motivo que o serviço deu para o turno ter falhado, quando deu algum.
       *
       * O cliente AG-UI trata `RUN_ERROR` como fim normal do fluxo: sem esta assinatura, uma recusa
       * do Codex — cota esgotada, por exemplo — chegava aqui como um run que "terminou sem texto", e
       * a tarefa morria em `INVALID_ACTION` sem dizer o que aconteceu. O motivo do fornecedor é a
       * única explicação que a pessoa tem; ele vai para o erro do run.
       */
      let failure = "";
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? 900_000,
      );

      try {
        await agent.runAgent(
          {
            runId: input.runId,
            // Ferramentas vazias de propósito: o Codex usa as dele, via MCP, e não as deste runtime.
            tools: [],
            context: [],
            /*
             * `openbotRun` é o que faz o servidor MCP subir do outro lado: ele autentica cada
             * chamada de ferramenta contra este deployment, e é de dentro dele que saem o Bot e a
             * pessoa da linha de auditoria. Sem a assinatura, o ciclo do Codex roda sem ferramenta
             * nenhuma e a tarefa "termina" sem ter aberto página alguma.
             */
            forwardedProps: {
              objective: input.objective,
              botId: input.botId,
              ...(options.signRun && input.actorId
                ? {
                    openbotRun: options.signRun({
                      botId: input.botId,
                      runId: input.runId,
                      actorId: input.actorId,
                    }),
                  }
                : {}),
            },
            abortController: controller,
          },
          {
            onTextMessageContentEvent: ({ event }) => {
              if (typeof event.delta === "string") text += event.delta;
            },
            onRunErrorEvent: ({ event }) => {
              failure = event.message;
            },
            onToolCallStartEvent: () => {
              toolCalls += 1;
            },
            /*
             * O serviço conta as ferramentas dele e as declara aqui.
             *
             * Um CLI de agente conduz o próprio laço: o navegador dele passa pelo MCP do outro
             * lado, e este processo não vê chamada nenhuma. Sem esta linha, um turno que abriu
             * página, clicou e leu chegava ao run com zero ferramentas — e a resposta para "o Bot
             * usou mesmo as ferramentas?", que é a pergunta deste fork inteiro, voltava a ser o que
             * o modelo disse de si mesmo. Vale o maior dos dois números: quem conta é quem viu.
             */
            onCustomEvent: ({ event }) => {
              if (event.name !== "openbot.tools") return;
              const declared = (event.value as { count?: unknown } | null)?.count;
              if (typeof declared === "number" && declared > toolCalls) {
                toolCalls = declared;
              }
            },
          },
        );
      } catch (error) {
        if (context.signal.aborted) {
          throw new ProviderRejectedError(
            "A tarefa foi interrompida antes de o Codex terminar.",
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        context.signal.removeEventListener("abort", abort);
      }

      const message = text.trim();
      if (failure && !message) {
        throw new ProviderUnavailableError(
          `O serviço do Codex não completou a tarefa: ${failure}`,
        );
      }
      if (!message) {
        return {
          kind: "invalid",
          raw: "",
          error:
            "O Codex terminou sem texto: não é possível dizer o que aconteceu com a página.",
        };
      }
      return {
        kind: "delegated",
        message,
        toolCalls,
        evidence: { tools: toolCalls },
      };
    },
  };
}

/**
 * A tarefa, com o que já aconteceu.
 *
 * Um run delegado que foi retomado precisa saber o que a tentativa anterior fez, e o histórico é o
 * único lugar onde isso está. A observação não vai: o Codex faz a dele quando abrir a página, e uma
 * observação deste processo seria uma fotografia de outro momento.
 */
export function delegatedObjective(input: AgentRunInput): string {
  const history = historyBlock(input.history);
  return history ? `${input.objective}\n\n${history}` : input.objective;
}
