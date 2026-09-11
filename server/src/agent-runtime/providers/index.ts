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
import { createCodexDelegatedProvider } from "./codex-delegated";
import { createOpenAICompatibleProvider } from "./openai-compatible";
import { createOpenAIResponsesProvider } from "./openai-responses";

export function createProviderFor(
  config: AgentModelConfig,
  options: { fetchImpl?: typeof fetch } = {},
): AgentModelProvider | undefined {
  const capabilities: ModelCapabilities = {
    vision: config.vision,
    tools: config.tools,
    streaming: false,
    mode: config.transport === "codex" ? "delegated" : "step",
  };
  const common = {
    id: config.id,
    model: config.model,
    capabilities,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  switch (config.transport) {
    case "codex":
      return createCodexDelegatedProvider({
        id: config.id,
        endpoint: config.baseUrl ?? "",
        model: config.model,
        // O token do Bot gerenciado, não a chave de um fornecedor: quem valida é o outro lado, e o
        // que ele aceita é este cabeçalho.
        ...(config.agentToken ? { token: config.agentToken } : {}),
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
  options: { fetchImpl?: typeof fetch } = {},
): AgentModelProvider[] {
  return configs
    .map((config) => createProviderFor(config, options))
    .filter((provider): provider is AgentModelProvider => Boolean(provider));
}

export {
  createAnthropicProvider,
  createCodexDelegatedProvider,
  createOpenAICompatibleProvider,
  createOpenAIResponsesProvider,
};
