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
import { ProviderRejectedError } from "./http";

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
      // O serviço do Codex tem visão pelo MCP e ferramentas próprias, mas quem as executa é ele.
      vision: true,
      tools: false,
      streaming: true,
      mode: "delegated",
    },

    async run(input: AgentRunInput, context): Promise<AgentRunResult> {
      if (!options.endpoint) {
        throw new ProviderRejectedError(
          "O provedor codex não está configurado: falta o endereço AG-UI do serviço.",
        );
      }

      const agent = new HttpAgent({
        url: options.endpoint,
        agentId: "codex",
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
            forwardedProps: { objective: input.objective, botId: input.botId },
            abortController: controller,
          },
          {
            onTextMessageContentEvent: ({ event }) => {
              if (typeof event.delta === "string") text += event.delta;
            },
            onToolCallStartEvent: () => {
              toolCalls += 1;
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
