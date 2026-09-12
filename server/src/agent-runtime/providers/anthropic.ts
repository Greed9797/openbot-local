/**
 * Anthropic Messages API.
 *
 * Duas diferenças de forma em relação à Responses, e as duas estão no que o PRD cobra: a imagem é
 * um bloco `image` com a fonte em base64 (não uma URL, nem texto), e a chamada de ferramenta é um
 * bloco `tool_use` dentro do conteúdo da mensagem. O adaptador existe para que essa diferença fique
 * aqui, e nenhuma outra parte do sistema precise saber que ela existe.
 */
import type {
  AgentModelProvider,
  AgentRunInput,
  AgentRunResult,
  ModelAttemptUsage,
  ModelCapabilities,
  ToolCall,
} from "../contracts";
import { tokenCount } from "../contracts";
import { systemPrompt, userPrompt } from "../prompt";
import { postJson } from "./http";

export type AnthropicOptions = {
  id?: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  capabilities: ModelCapabilities;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function createAnthropicProvider(
  options: AnthropicOptions,
): AgentModelProvider {
  const base = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(
    /\/$/,
    "",
  );
  const id = options.id ?? "anthropic";

  return {
    id,
    capabilities: options.capabilities,

    async run(input: AgentRunInput, context): Promise<AgentRunResult> {
      const content: unknown[] = [{ type: "text", text: userPrompt(input) }];
      if (input.capabilities.vision) {
        for (const image of input.observation?.images ?? []) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: image.mime,
              data: image.data,
            },
          });
        }
      }

      const model = input.model ?? options.model;
      const body: Record<string, unknown> = {
        model,
        max_tokens: options.maxTokens ?? 4_096,
        system: systemPrompt(input),
        messages: [{ role: "user", content }],
        ...(input.capabilities.tools && input.tools.length
          ? {
              tools: input.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
            }
          : {}),
      };

      const response = await postJson({
        url: `${base}/messages`,
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
        signal: context.signal,
        timeoutMs: options.timeoutMs ?? 300_000,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

      return readResponse(response, responseUsage(id, model, response));
    },
  };
}

/**
 * O conteúdo é uma lista de blocos. A primeira chamada de ferramenta decide o passo; sem ela, o
 * texto vira a conclusão — que é como um modelo de ferramentas nativas termina.
 */
function readResponse(
  response: Record<string, unknown>,
  usage?: ModelAttemptUsage,
): AgentRunResult {
  const blocks = Array.isArray(response.content) ? response.content : [];
  const text = blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const entry = block as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string"
        ? entry.text
        : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const entry = block as Record<string, unknown>;
    if (entry.type !== "tool_use" || typeof entry.name !== "string") continue;
    const args =
      entry.input &&
      typeof entry.input === "object" &&
      !Array.isArray(entry.input)
        ? (entry.input as Record<string, unknown>)
        : {};
    const call: ToolCall = {
      name: entry.name,
      arguments: args,
      ...(typeof entry.id === "string" ? { callId: entry.id } : {}),
    };
    return {
      kind: "tool_call",
      call,
      ...(text ? { text } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  if (!text) {
    return {
      kind: "invalid",
      raw: JSON.stringify(response).slice(0, 500),
      error: "A resposta não trouxe nem bloco de ferramenta nem texto.",
      ...(usage ? { usage } : {}),
    };
  }
  return { kind: "final", message: text, ...(usage ? { usage } : {}) };
}

/**
 * O `usage` do Messages API, quando o provedor mandou um.
 *
 * Cache de leitura é o reaproveitamento que barateia a chamada; criação de cache também é token de
 * cache quando só ela foi reportada. Sem o bloco, o resultado sai sem `usage` e o loop registra
 * nulls. Só contadores e identidade; nada do prompt.
 */
function responseUsage(
  provider: string,
  model: string,
  response: Record<string, unknown>,
): ModelAttemptUsage | undefined {
  const raw = response.usage;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const usage = raw as Record<string, unknown>;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cached = tokenCount(
    usage.cache_read_input_tokens ?? usage.cache_creation_input_tokens,
  );
  if (input === null && output === null && cached === null) return undefined;
  const effective =
    typeof response.model === "string" && response.model
      ? response.model
      : model;
  return {
    provider,
    model: effective,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    cost: null,
  };
}
