/**
 * A resposta do modelo, para provedores que respondem em texto.
 *
 * Um modelo sem ferramentas nativas propõe a ação em JSON. O servidor valida contra o catálogo:
 * ferramenta que não existe, argumento que falta e JSON quebrado são a mesma resposta — inválida — e
 * o loop tem um número limitado de correções antes de desistir. Nada do que está aqui é executado às
 * cegas: quem executa é o catálogo, com o mesmo `ref` resolvido contra o mesmo snapshot.
 */
import { z } from "zod";
import type { AgentRunResult, ToolCall, ToolDefinition } from "../contracts";

/**
 * A forma da resposta. Tudo opcional porque a validação de verdade é qual dos três campos veio —
 * e um objeto que não traz nenhum deles é uma resposta inválida, não uma resposta vazia.
 */
const Decision = z.object({
  tool: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  final: z.string().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  help: z.string().optional(),
});

export function decisionFromText(
  raw: string,
  tools: ToolDefinition[],
): AgentRunResult {
  const cleaned = stripFences(raw).trim();
  if (!cleaned) {
    return {
      kind: "invalid",
      raw,
      error: "A resposta veio vazia. Responda com o JSON da próxima ação.",
    };
  }

  const parsed = parseJsonObject(cleaned);
  if (!parsed) {
    return {
      kind: "invalid",
      raw,
      error:
        "A resposta não é um objeto JSON. Responda apenas com o JSON da próxima ação.",
    };
  }

  if (parsed.help !== undefined) {
    return { kind: "help", reason: parsed.help };
  }

  if (parsed.final !== undefined) {
    return {
      kind: "final",
      message: parsed.final,
      ...(parsed.evidence ? { evidence: parsed.evidence } : {}),
    };
  }

  if (parsed.tool !== undefined) {
    const known = tools.find((tool) => tool.name === parsed.tool);
    if (!known) {
      return {
        kind: "invalid",
        raw,
        error: `Não existe ferramenta chamada ${parsed.tool}. As disponíveis são: ${tools
          .map((tool) => tool.name)
          .join(", ")}.`,
      };
    }
    const call: ToolCall = {
      name: parsed.tool,
      arguments: parsed.arguments ?? {},
    };
    return { kind: "tool_call", call };
  }

  return {
    kind: "invalid",
    raw,
    error:
      'A resposta não tem "tool", "final" nem "help". Use um dos três, com JSON válido.',
  };
}

/** O JSON, e a última tentativa: o objeto dentro de uma frase, quando o modelo escreveu em volta. */
function parseJsonObject(text: string): z.infer<typeof Decision> | undefined {
  const direct = attempt(text);
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  return attempt(text.slice(start, end + 1));
}

function attempt(text: string): z.infer<typeof Decision> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = Decision.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function stripFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fence?.[1] ?? text;
}
