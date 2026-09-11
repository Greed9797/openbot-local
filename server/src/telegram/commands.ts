/**
 * De uma frase para uma intenção.
 *
 * Comando e linguagem natural caem no mesmo lugar de propósito: o PRD quer as duas portas, e a
 * diferença entre "/tela" e "me manda a tela" não deveria ser a diferença entre funcionar e virar
 * uma tarefa que abre o navegador para descobrir o que fazer. O que separa uma coisa da outra é o que
 * a frase pede, não como ela começa.
 *
 * O que não é reconhecido vira tarefa — é o caso em que a pessoa está pedindo trabalho, e a resposta
 * certa é aceitar e executar. Frases reconhecidas são as que não devem virar tarefa nenhuma:
 * pedir a tela não gasta modelo, e aprovar não é uma ordem nova.
 *
 * Módulo puro. Nada aqui sabe o que é um banco, um chat ou uma tarefa — entra texto, sai intenção.
 */
import type { TelegramMessage } from "./types";

export type TelegramIntent =
  | { kind: "pair"; code: string }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "tasks" }
  | { kind: "screen"; runId?: string }
  | { kind: "analyze"; runId?: string; question?: string }
  | { kind: "pause"; runId?: string }
  | { kind: "resume"; runId?: string; note?: string }
  | { kind: "cancel"; runId?: string }
  | { kind: "approve"; runId: string; approvalId: string }
  | { kind: "deny"; runId: string; approvalId: string; reason?: string }
  | { kind: "task"; objective: string };

/** "me manda a tela da 153" → o id 153, sem confundir com outros números da frase. */
function runIdIn(text: string): string | undefined {
  const id = /\b(?:tarefa|task|#)\s*([0-9a-fA-F-]{8,36})\b/.exec(text);
  if (id?.[1]) return id[1];
  const bare = /\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/.exec(
    text,
  );
  return bare?.[1];
}

/** As formas de pedir a tela sem gastar um modelo para isso. */
const SCREEN = /\b(tela|screenshot|captura|print|imagem da pagina|imagem da página)\b/i;
const SCREEN_VERB = /\b(manda|mande|envia|envie|mostra|mostre|quero|ver|ve)\b/i;
/**
 * As formas de pedir uma leitura da tela, sem gastar um modelo para isso.
 *
 * O fim de cada alternativa é um lookahead, e não `\b`: `\b` em JavaScript é ASCII, então a fronteira
 * depois de "está" não existe — "á" e o espaço seguinte são os dois não-letra, e o padrão nunca casa
 * com a frase que a pessoa escreveu.
 */
const ANALYZE =
  /\b(analisa|analise|analisar|descreve|descreva|o que (?:está|esta|aparece)|explica a tela|o que voce ve|o que você vê|interpreta)(?=\s|$|[,.!?])/i;

export function intentOf(message: TelegramMessage): TelegramIntent {
  const text = message.text.trim();
  const command = message.command;

  if (command) {
    switch (command.name) {
      case "start":
        return command.argument ? { kind: "pair", code: command.argument } : { kind: "help" };
      case "ajuda":
      case "help":
        return { kind: "help" };
      case "status":
        return { kind: "status" };
      case "tarefas":
      case "tasks":
        return { kind: "tasks" };
      case "tela":
        return { kind: "screen", ...(runIdIn(command.argument) ? { runId: runIdIn(command.argument) } : {}) };
      case "analisar":
      case "analise":
        return {
          kind: "analyze",
          ...(runIdIn(command.argument) ? { runId: runIdIn(command.argument) } : {}),
        };
      case "pausar":
      case "pause":
        return { kind: "pause", ...(runIdIn(command.argument) ? { runId: runIdIn(command.argument) } : {}) };
      case "continuar":
      case "resume": {
        const id = runIdIn(command.argument);
        const note = id ? command.argument.replace(id, "").trim() : command.argument;
        return {
          kind: "resume",
          ...(id ? { runId: id } : {}),
          ...(note ? { note } : {}),
        };
      }
      case "cancelar":
      case "cancel":
        return { kind: "cancel", ...(runIdIn(command.argument) ? { runId: runIdIn(command.argument) } : {}) };
      case "aprovar":
      case "approve": {
        const parsed = approvalArgument(command.argument);
        if (parsed) return { kind: "approve", ...parsed };
        return { kind: "tasks" };
      }
      case "recusar":
      case "deny": {
        const parsed = approvalArgument(command.argument);
        if (!parsed) return { kind: "tasks" };
        const reason = command.argument
          .replace(parsed.runId, "")
          .replace(parsed.approvalId, "")
          .trim();
        return { kind: "deny", ...parsed, ...(reason ? { reason } : {}) };
      }
      default:
        return { kind: "task", objective: text };
    }
  }

  if (SCREEN.test(text)) {
    if (ANALYZE.test(text)) {
      return {
        kind: "analyze",
        ...(runIdIn(text) ? { runId: runIdIn(text) } : {}),
        question: text,
      };
    }
    if (SCREEN_VERB.test(text) || /^(a )?tela\b/i.test(text)) {
      return { kind: "screen", ...(runIdIn(text) ? { runId: runIdIn(text) } : {}) };
    }
  }
  if (ANALYZE.test(text) && /tela|captura|imagem/i.test(text)) {
    return {
      kind: "analyze",
      ...(runIdIn(text) ? { runId: runIdIn(text) } : {}),
      question: text,
    };
  }

  return { kind: "task", objective: text };
}

/** Os dois argumentos de um pedido de aprovação: a tarefa e a aprovação. */
function approvalArgument(
  argument: string,
): { runId: string; approvalId: string } | undefined {
  const parts = argument.split(/\s+/).filter(Boolean);
  const runId = parts.find((part) => /^[0-9a-fA-F-]{8,36}$/.test(part));
  const approvalId = parts.find(
    (part) => part !== runId && /^[0-9a-fA-F-]{8,36}$/.test(part),
  );
  if (!runId || !approvalId) return undefined;
  return { runId, approvalId };
}

export type CallbackIntent =
  | { kind: "screen"; runId: string }
  | { kind: "approve"; runId: string; approvalId: string }
  | { kind: "deny"; runId: string; approvalId: string };

/**
 * O que um botão carrega.
 *
 * `data` tem limite de 64 bytes na plataforma, então o que vai é o essencial: a ação e dois ids. O
 * servidor revalida tudo depois — um botão não é uma autorização, é um atalho para pedir uma.
 */
export function callbackIntent(data: string): CallbackIntent | undefined {
  const [kind, runId, approvalId] = data.split(":");
  if (!runId) return undefined;
  if (kind === "screen") return { kind: "screen", runId };
  if ((kind === "approve" || kind === "deny") && approvalId) {
    return { kind, runId, approvalId };
  }
  return undefined;
}
