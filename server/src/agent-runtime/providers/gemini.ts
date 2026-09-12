/**
 * Google Gemini, pela API nativa.
 *
 * Nativa e não pelo endpoint compatível com OpenAI porque as duas coisas que este runtime precisa
 * são de primeira classe aqui: a imagem viaja como `inlineData` — bloco de bytes, nunca texto —, e a
 * chamada de ferramenta volta como `functionCall` dentro das partes, com os argumentos já em JSON,
 * sem uma camada de tradução no meio para inventar formato.
 *
 * Sem estado: cada passo é um pedido completo. O que o modelo sabe da tarefa está na tabela de
 * passos, e é isso que permite trocar de modelo no meio de uma tarefa sem perder o fio.
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
import { postJson, ProviderRejectedError } from "./http";

export type GeminiOptions = {
  id?: string;
  model: string;
  apiKey: string;
  /** `https://generativelanguage.googleapis.com/v1beta` a menos que um proxy diga outra coisa. */
  baseUrl?: string;
  capabilities: ModelCapabilities;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function createGeminiProvider(
  options: GeminiOptions,
): AgentModelProvider {
  const base = (
    options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/$/, "");
  const id = options.id ?? "gemini";

  return {
    id,
    capabilities: options.capabilities,

    async run(input: AgentRunInput, context): Promise<AgentRunResult> {
      if (!options.apiKey) {
        throw new ProviderRejectedError(
          `O provedor ${id} não tem credencial configurada neste deployment.`,
        );
      }

      // O modelo escolhido pela tarefa vence o do deployment: mandar o padrão quando a tarefa
      // escolheu outro trocaria o modelo sem dizer nada.
      const model = input.model ?? options.model;
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: systemPrompt(input) }] },
        contents: [{ role: "user", parts: userParts(input) }],
        ...(input.capabilities.tools && input.tools.length
          ? {
              tools: [
                {
                  functionDeclarations: input.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  })),
                },
              ],
            }
          : {}),
      };

      const response = await postJson({
        url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "x-goog-api-key": options.apiKey },
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
 * As partes da mensagem do passo.
 *
 * Tudo o que o modelo precisa em uma mensagem só — tarefa, histórico, observação —, porque as três
 * são a mesma pergunta: "o que fazer agora". As imagens vão como bytes ao lado do texto, e nunca
 * como descrição: um modelo que lê um retrato alheio do pixel responde sobre o retrato, não sobre a
 * tela.
 */
function userParts(input: AgentRunInput): unknown[] {
  const parts: unknown[] = [{ text: userPrompt(input) }];
  if (input.capabilities.vision) {
    for (const image of input.observation?.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mime, data: image.data } });
    }
  }
  return parts;
}

/** Uma parte que é função decide o passo; texto solto é a resposta final. */
function readResponse(
  response: Record<string, unknown>,
  usage?: ModelAttemptUsage,
): AgentRunResult {
  const candidates = Array.isArray(response.candidates)
    ? response.candidates
    : [];
  const candidate = candidates.find(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object",
  );

  if (!candidate) {
    /*
     * Sem candidato quase sempre é bloqueio: o texto de entrada ou o pedido não passou por um dos
     * filtros. Dizer qual é a única informação útil que existe aqui — "a resposta não veio" sozinho
     * manda quem lê procurar erro de rede onde não tem.
     */
    const feedback = response.promptFeedback as
      | { blockReason?: unknown; blockReasonMessage?: unknown }
      | undefined;
    const reason =
      typeof feedback?.blockReason === "string"
        ? `${feedback.blockReason}${
            typeof feedback.blockReasonMessage === "string"
              ? `: ${feedback.blockReasonMessage}`
              : ""
          }`
        : "resposta sem candidato";
    return {
      kind: "invalid",
      raw: JSON.stringify(response).slice(0, 500),
      error: `O Gemini não devolveu resposta (${reason}).`,
      ...(usage ? { usage } : {}),
    };
  }

  const content = candidate.content as { parts?: unknown } | undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const entry = part as Record<string, unknown>;
    const call = entry.functionCall;
    if (!call || typeof call !== "object") continue;
    const parsed = toCall(call as Record<string, unknown>);
    if (!parsed) {
      return {
        kind: "invalid",
        raw: JSON.stringify(entry).slice(0, 500),
        error: "A chamada de ferramenta veio sem nome.",
        ...(usage ? { usage } : {}),
      };
    }
    return { kind: "tool_call", call: parsed, ...(usage ? { usage } : {}) };
  }

  const text = parts
    .map((part) =>
      part &&
      typeof part === "object" &&
      typeof (part as Record<string, unknown>).text === "string"
        ? String((part as Record<string, unknown>).text)
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    const finish = candidate.finishReason;
    return {
      kind: "invalid",
      raw: JSON.stringify(candidate).slice(0, 500),
      error:
        typeof finish === "string" && finish !== "STOP"
          ? `A resposta terminou em ${finish}, sem texto nem chamada de ferramenta.`
          : "A resposta não trouxe nem chamada de ferramenta nem texto.",
      ...(usage ? { usage } : {}),
    };
  }

  // Com ferramentas, texto livre é a tarefa dada por concluída — o loop confere o resto.
  return { kind: "final", message: text, ...(usage ? { usage } : {}) };
}

function toCall(call: Record<string, unknown>): ToolCall | undefined {
  if (typeof call.name !== "string" || !call.name) return undefined;
  const args = call.args;
  return {
    name: call.name,
    arguments:
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {},
    ...(typeof call.id === "string" ? { callId: call.id } : {}),
  };
}

/**
 * O `usageMetadata` do generateContent, quando o provedor mandou um.
 *
 * Sem o bloco, o resultado sai sem `usage` e o loop registra a tentativa com nulls — nunca zeros.
 * Só contadores e identidade; nada do prompt.
 */
function responseUsage(
  provider: string,
  model: string,
  response: Record<string, unknown>,
): ModelAttemptUsage | undefined {
  const raw = response.usageMetadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const meta = raw as Record<string, unknown>;
  const input = tokenCount(meta.promptTokenCount);
  const output = tokenCount(meta.candidatesTokenCount);
  const cached = tokenCount(meta.cachedContentTokenCount);
  if (input === null && output === null && cached === null) return undefined;
  const version = response.modelVersion;
  const effective = typeof version === "string" && version ? version : model;
  return {
    provider,
    model: effective,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    cost: null,
  };
}
