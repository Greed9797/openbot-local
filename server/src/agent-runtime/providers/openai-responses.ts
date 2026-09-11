/**
 * OpenAI Responses API.
 *
 * A API que aceita ferramentas e imagens no mesmo pedido. Duas coisas são específicas dela e estão
 * explícitas aqui porque são exatamente o que a auditoria encontrou quebrado no agente de exemplo: a
 * imagem viaja como bloco `input_image` — nunca como texto —, e a chamada de ferramenta volta como
 * um item do `output`, não como uma escolha de mensagem.
 *
 * Sem estado: cada passo é um pedido completo. O servidor do provedor não guarda a conversa, e é isso
 * que permite trocar de modelo no meio de uma tarefa sem perder o fio, que está na tabela de passos.
 */
import type {
  AgentModelProvider,
  AgentRunInput,
  AgentRunResult,
  ModelCapabilities,
  ToolCall,
} from "../contracts";
import { systemPrompt, userPrompt } from "../prompt";
import { postJson, ProviderRejectedError } from "./http";

export type OpenAIResponsesOptions = {
  id?: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  capabilities: ModelCapabilities;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function createOpenAIResponsesProvider(
  options: OpenAIResponsesOptions,
): AgentModelProvider {
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const id = options.id ?? "openai-responses";

  return {
    id,
    capabilities: options.capabilities,

    async run(input: AgentRunInput, context): Promise<AgentRunResult> {
      const body: Record<string, unknown> = {
        model: options.model,
        instructions: systemPrompt(input),
        input: [userMessage(input)],
        // Sem armazenamento no provedor: o estado da tarefa é o banco deste servidor.
        store: false,
        ...(input.capabilities.tools && input.tools.length
          ? {
              tools: input.tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: false,
              })),
              tool_choice: "auto",
            }
          : {}),
      };

      const response = await postJson({
        url: `${base}/responses`,
        headers: { authorization: `Bearer ${options.apiKey}` },
        body,
        signal: context.signal,
        timeoutMs: options.timeoutMs ?? 300_000,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

      return readResponse(response, input);
    },
  };
}

/**
 * A mensagem do passo.
 *
 * Tudo o que o modelo precisa em uma mensagem de usuário: tarefa, histórico, observação. Uma
 * mensagem só porque as três são a mesma pergunta — "o que fazer agora" — e separá-las em turnos
 * faria o modelo ler uma conversa que nunca aconteceu.
 */
function userMessage(input: AgentRunInput): Record<string, unknown> {
  const content: unknown[] = [{ type: "input_text", text: userPrompt(input) }];
  if (input.capabilities.vision) {
    for (const image of input.observation?.images ?? []) {
      content.push({
        type: "input_image",
        image_url: `data:${image.mime};base64,${image.data}`,
        detail: "high",
      });
    }
  }
  return { role: "user", content };
}

/** O `output` é uma lista de itens; a primeira chamada de função ou o texto decidem o passo. */
function readResponse(
  response: Record<string, unknown>,
  input: AgentRunInput,
): AgentRunResult {
  const items = Array.isArray(response.output) ? response.output : [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "function_call" && typeof entry.name === "string") {
      const call = toCall(entry);
      if (!call) {
        return {
          kind: "invalid",
          raw: JSON.stringify(entry),
          error: "A chamada de ferramenta veio sem argumentos utilizáveis.",
        };
      }
      return { kind: "tool_call", call };
    }
  }

  const text = items
    .flatMap((item) => {
      const entry = item as Record<string, unknown>;
      if (entry.type !== "message" || !Array.isArray(entry.content)) return [];
      return entry.content
        .map((part) =>
          part &&
          typeof part === "object" &&
          (part as Record<string, unknown>).type === "output_text" &&
          typeof (part as Record<string, unknown>).text === "string"
            ? String((part as Record<string, unknown>).text)
            : "",
        )
        .filter(Boolean);
    })
    .join("\n")
    .trim();

  if (!text) {
    return {
      kind: "invalid",
      raw: JSON.stringify(response).slice(0, 500),
      error: "A resposta não trouxe nem chamada de ferramenta nem texto.",
    };
  }

  // Um provedor nativo com ferramentas responde em texto livre quando considera a tarefa concluída.
  if (!input.tools.length) {
    return { kind: "final", message: text };
  }
  return { kind: "final", message: text };
}

function toCall(entry: Record<string, unknown>): ToolCall | undefined {
  const name = String(entry.name);
  const raw = entry.arguments;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { name, arguments: {} };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { name, arguments: {} };
  }
  return {
    name,
    arguments: parsed as Record<string, unknown>,
    ...(typeof entry.call_id === "string" ? { callId: entry.call_id } : {}),
  };
}

/** O mesmo erro para uma configuração sem credencial, em qualquer adaptador. */
export function missingCredential(provider: string): ProviderRejectedError {
  return new ProviderRejectedError(
    `O provedor ${provider} não tem credencial configurada neste deployment.`,
  );
}
