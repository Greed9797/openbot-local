/**
 * Quais modelos este deployment tem, e como cada um é chamado.
 *
 * A lista vem do ambiente porque é onde as credenciais já estão: um deployment que tem
 * `OPENAI_API_KEY` tem o provedor, e um que não tem não tem — nada de um registro separado que pode
 * discordar do ambiente. O que a lista decide é o que o runtime pode usar, e a ordem decide qual é o
 * padrão quando a tarefa não escolhe.
 *
 * Capacidade de visão é a única que não dá para ler de uma credencial. Ela é presumida pelo nome do
 * modelo e pode ser negada explicitamente; o teste de canvas (AT-01) é o que a homologa de verdade, e
 * é por isso que a configuração gravada guarda `testedAt` nulo até alguém rodar esse teste.
 */
import type { AgentModelConfig } from "../../config";
import type { AgentModelProvider, ModelCapabilities } from "../contracts";
import { createAnthropicProvider } from "./anthropic";
import type { CodexDelegatedOptions } from "./codex-delegated";
import { createCodexDelegatedProvider } from "./codex-delegated";
import { createGeminiProvider } from "./gemini";
import { createOpenAICompatibleProvider } from "./openai-compatible";
import { createOpenAIResponsesProvider } from "./openai-responses";

export function createProviderFor(
  config: AgentModelConfig,
  options: {
    fetchImpl?: typeof fetch;
    signRun?: CodexSignRun;
    /** Ver `CodexDelegatedOptions.skills`: só o provedor delegado entrega skills ao motor. */
    skills?: CodexSkills;
  } = {},
): AgentModelProvider | undefined {
  const capabilities: ModelCapabilities = {
    vision: config.vision,
    tools: config.tools,
    streaming: false,
    mode: config.transport === "delegated" ? "delegated" : "step",
  };
  const common = {
    id: config.id,
    model: config.model,
    capabilities,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  switch (config.transport) {
    case "delegated":
      return createCodexDelegatedProvider({
        id: config.id,
        endpoint: config.baseUrl ?? "",
        model: config.model,
        // Se o modelo que roda lá dentro enxerga a página é o deployment que sabe: o CLI é dado de
        // configuração, e o modelo dele também. Sem isto o `AGENT_OPENCODE_VISION=off` seria uma
        // linha no `.env` sem efeito nenhum — o adaptador presumiria visão e todo passo pediria
        // captura a um modelo de texto.
        vision: config.vision,
        // O token do Bot gerenciado, não a chave de um fornecedor: quem valida é o outro lado, e o
        // que ele aceita é este cabeçalho.
        ...(config.agentToken ? { token: config.agentToken } : {}),
        ...(options.signRun ? { signRun: options.signRun } : {}),
        ...(options.skills ? { skills: options.skills } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    case "responses":
      return config.apiKey
        ? createOpenAIResponsesProvider({
            ...common,
            apiKey: config.apiKey,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          })
        : undefined;
    case "messages":
      return config.apiKey
        ? createAnthropicProvider({
            ...common,
            apiKey: config.apiKey,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          })
        : undefined;
    case "gemini":
      return config.apiKey
        ? createGeminiProvider({
            ...common,
            apiKey: config.apiKey,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          })
        : undefined;
    case "chat-completions":
      return createOpenAICompatibleProvider({
        ...common,
        baseUrl: config.baseUrl ?? "http://127.0.0.1:11434/v1",
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      });
    default:
      return undefined;
  }
}

export function createConfiguredProviders(
  configs: AgentModelConfig[],
  options: {
    fetchImpl?: typeof fetch;
    /** Ver `CodexDelegatedOptions.signRun`: só o provedor delegado tem o que assinar. */
    signRun?: CodexSignRun;
    /** Ver `CodexDelegatedOptions.skills`: só o provedor delegado entrega skills ao motor. */
    skills?: CodexSkills;
  } = {},
): AgentModelProvider[] {
  return configs
    .map((config) => createProviderFor(config, options))
    .filter((provider): provider is AgentModelProvider => Boolean(provider));
}

/** O que o provedor delegado assina, do lado de quem tem a chave. */
export type CodexSignRun = NonNullable<CodexDelegatedOptions["signRun"]>;

/** O que o provedor delegado entrega como skills concedidas. Ver `CodexDelegatedOptions.skills`. */
export type CodexSkills = NonNullable<CodexDelegatedOptions["skills"]>;

/**
 * Os modelos que cada serviço delegado diz ter.
 *
 * O serviço é quem tem a conta, então é ele quem sabe — o runtime pergunta em vez de manter uma
 * lista paralela no `.env`, que envelhece toda vez que a assinatura ganha um modelo.
 *
 * O endereço do catálogo é o do turno sem o `/ag-ui`: o serviço serve os dois na mesma porta, e
 * derivar em vez de exigir outra variável é o que mantém um serviço novo como uma variável só.
 * Falha é aviso, nunca erro de boot: um CLI fora do ar custa a lista dele, não o deployment.
 */
export async function serviceModels(
  configs: AgentModelConfig[],
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<Record<string, string[]>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const listados: Record<string, string[]> = {};

  await Promise.all(
    configs
      .filter(
        (config) => config.transport === "delegated" && Boolean(config.baseUrl),
      )
      .map(async (config) => {
        const endereco = new URL(config.baseUrl as string);
        endereco.pathname = "/models";
        endereco.search = "";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(endereco.toString(), {
            headers: config.agentToken
              ? { "x-openbot-agent-token": config.agentToken }
              : {},
            signal: controller.signal,
          });
          if (!response.ok) {
            console.warn(
              `${config.id}: não foi possível listar os modelos do serviço (HTTP ${response.status}).`,
            );
            return;
          }
          const body = (await response.json()) as { models?: unknown };
          const models = Array.isArray(body.models)
            ? body.models.filter(
                (model): model is string => typeof model === "string",
              )
            : [];
          if (models.length) listados[config.id] = models;
          else {
            console.warn(
              `${config.id}: o serviço não listou modelo nenhum — o seletor vai mostrar só o padrão.`,
            );
          }
        } catch (error) {
          console.warn(
            `${config.id}: não foi possível listar os modelos do serviço (${String(error)}).`,
          );
        } finally {
          clearTimeout(timer);
        }
      }),
  );

  return listados;
}

export {
  createAnthropicProvider,
  createCodexDelegatedProvider,
  createGeminiProvider,
  createOpenAICompatibleProvider,
  createOpenAIResponsesProvider,
};
