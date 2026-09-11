/**
 * `/v1/chat/completions`: o dialeto que quase tudo fala.
 *
 * Ollama, vLLM, llama.cpp, um gateway interno, OpenRouter, e a própria OpenAI. É o adaptador que faz
 * "modelos intercambiáveis" significar alguma coisa em uma VPS pequena: um modelo local entra por
 * aqui sem que ninguém precise de um provedor novo.
 *
 * Um modelo local recusando o campo de ferramentas não é um erro tratado aqui: a lista vai vazia
 * quando o modelo não tem ferramentas nativas, e a resposta em texto é lida por `decisionFromText`.
 * O mesmo caminho cobre o modelo que tem ferramentas mas devolve JSON em texto.
 */
import type {
  AgentModelProvider,
  AgentRunInput,
  AgentRunResult,
  ModelCapabilities,
  ToolCall,
} from "../contracts";
import { systemPrompt, toolsAsText, userPrompt } from "../prompt";
import { decisionFromText } from "./decision";
import { postJson } from "./http";

export type OpenAICompatibleOptions = {
  id?: string;
  model: string;
  /** Absent for a local server that wants none. Sent as a bearer header when present. */
  apiKey?: string;
  baseUrl: string;
  capabilities: ModelCapabilities;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function createOpenAICompatibleProvider(
  options: OpenAICompatibleOptions,
): AgentModelProvider {
  const base = options.baseUrl.replace(/\/$/, "");
  const id = options.id ?? "openai-compatible";
  /** Ferramentas nativas, quando o modelo tem; caso contrário, o catálogo vai no próprio texto. */
  const nativeTools = options.capabilities.tools;

  return {
    id,
    capabilities: options.capabilities,

    async run(input: AgentRunInput, context): Promise<AgentRunResult> {
      const content: unknown[] = [
        {
          type: "text",
          text: nativeTools
            ? userPrompt(input)
            : `${userPrompt(input)}\n\n${toolsAsText(input.tools)}`,
        },
      ];
      if (input.capabilities.vision) {
        for (const image of input.observation?.images ?? []) {
          content.push({
            type: "image_url",
            image_url: { url: `data:${image.mime};base64,${image.data}` },
          });
        }
      }

      const body: Record<string, unknown> = {
        model: options.model,
        messages: [
          { role: "system", content: systemPrompt(input) },
          { role: "user", content },
        ],
        ...(nativeTools && input.tools.length
          ? {
              tools: input.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
      };

      const response = await postJson({
        url: `${base}/chat/completions`,
        headers: options.apiKey
          ? { authorization: `Bearer ${options.apiKey}` }
          : {},
        body,
        signal: context.signal,
        timeoutMs: options.timeoutMs ?? 300_000,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

      return nativeTools && input.tools.length
        ? readNativeResponse(response)
        : readTextResponse(response, input);
    },
  };
}

/** A resposta no formato de ferramentas: `tool_calls` na mensagem. */
function readNativeResponse(response: Record<string, unknown>): AgentRunResult {
  const message = firstMessage(response);
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const raw of calls) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const fn = entry.function;
    if (!fn || typeof fn !== "object") continue;
    const call = fn as Record<string, unknown>;
    if (typeof call.name !== "string") continue;
    let args: Record<string, unknown> = {};
    if (typeof call.arguments === "string") {
      try {
        const parsed = JSON.parse(call.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Argumentos ilegíveis: fica com os vazios e a validação do catálogo recusa no lugar certo.
      }
    }
    const toolCall: ToolCall = {
      name: call.name,
      arguments: args,
      ...(typeof entry.id === "string" ? { callId: entry.id } : {}),
    };
    return { kind: "tool_call", call: toolCall };
  }

  const text = typeof message?.content === "string" ? message.content.trim() : "";
  if (!text) {
    return {
      kind: "invalid",
      raw: JSON.stringify(response).slice(0, 500),
      error: "A resposta não trouxe chamada de ferramenta nem texto.",
    };
  }
  return { kind: "final", message: text };
}

/** A resposta em texto puro: o JSON proposto é validado contra o mesmo catálogo. */
function readTextResponse(
  response: Record<string, unknown>,
  input: AgentRunInput,
): AgentRunResult {
  const message = firstMessage(response);
  const text = typeof message?.content === "string" ? message.content : "";
  if (!text.trim()) {
    return {
      kind: "invalid",
      raw: JSON.stringify(response).slice(0, 500),
      error: "A resposta veio sem texto.",
    };
  }
  return decisionFromText(text, input.tools);
}

function firstMessage(
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const message = (first as Record<string, unknown>).message;
  return message && typeof message === "object"
    ? (message as Record<string, unknown>)
    : undefined;
}
