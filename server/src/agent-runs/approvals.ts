/**
 * O portão entre o que o modelo quer fazer e o que o navegador faz.
 *
 * A decisão de sensibilidade é do classificador; o que este arquivo acrescenta é o registro. Toda
 * pergunta vira uma linha em `run_approvals` com o hash exato da ação proposta, e o sim de uma pessoa
 * é gasto uma vez, naquela ação e em nenhuma outra. É o que impede que "aprovei publicar este
 * produto" se torne "aprovei qualquer coisa que o modelo pedir depois".
 *
 * Uma resposta que a pessoa já deu é reaproveitada em vez de perguntar de novo: o modelo, retomado,
 * tende a propor a mesma ação, e perguntar outra vez faria a pessoa aprovar o mesmo clique duas
 * vezes. O que já foi negado também é lembrado — a recusa chega ao modelo como informação, e ele
 * decide outra coisa.
 */
import type { ApprovalGate, AgentObservation } from "../agent-runtime/contracts";
import { actionHashOf } from "../agent-runtime/loop";
import {
  classifyAction,
  type ProposedAction,
} from "../agent-runtime/sensitive-actions";
import type { AgentRunRepository, RunApprovalRow } from "./repository";

export type ApprovalGateOptions = {
  repository: AgentRunRepository;
  /** Quanto tempo um pedido espera antes de expirar. Depois disso, é preciso pedir de novo. */
  ttlMs: number;
  /** Padrões extras que o deployment considera sensíveis, além dos verbos conhecidos. */
  extraPatterns?: string[];
  now?: () => number;
};

/** O nome do elemento que a ação aciona, quando a observação o conhece. */
function targetOf(
  call: ProposedAction,
  observation: AgentObservation,
): { name: string | null; role: string | null } {
  const ref = call.arguments?.ref;
  if (typeof ref !== "string") return { name: null, role: null };
  const element = observation.elements.find((item) => item.ref === ref);
  if (!element) return { name: null, role: null };
  return { name: element.name, role: element.role };
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const now = options.now ?? (() => Date.now());
  const extra = (options.extraPatterns ?? []).map((pattern) =>
    pattern.toLowerCase(),
  );

  function extraHit(call: ProposedAction, targetName: string | null): string | undefined {
    const text =
      `${call.name} ${targetName ?? ""} ${JSON.stringify(call.arguments ?? {})}`.toLowerCase();
    return extra.find((pattern) => pattern && text.includes(pattern));
  }

  return {
    async review(call, observation, request) {
      const target = targetOf(call, observation);
      const hash = actionHashOf(call);
      const verdict = classifyAction(call, {
        url: observation.url,
        targetName: target.name,
        targetRole: target.role,
      });
      const extraPattern = extraHit(call, target.name);
      if (!verdict.sensitive && !extraPattern) return { decision: "run" };

      const reason = verdict.sensitive
        ? verdict.reason
        : `O deployment marcou "${extraPattern}" como sensível.`;
      const expectedEffect = verdict.sensitive
        ? verdict.expectedEffect
        : `Executar ${call.name}.`;

      const existing = await options.repository.approvalForAction(
        request.runId,
        hash,
      );
      if (existing) {
        const alive = existing.expiresAt.getTime() > now();
        if (existing.status === "approved" && alive) {
          return { decision: "approved", approvalId: existing.id };
        }
        if (existing.status === "pending" && alive) {
          /*
           * A tarefa voltou a andar sem que ninguém decidisse (uma mensagem, uma retomada). A
           * pergunta continua de pé: reapresentá-la é a resposta certa, e criar uma segunda
           * aprovação para o mesmo clique faria a pessoa decidir duas vezes sobre a mesma coisa.
           */
          return { decision: "requested", approvalId: existing.id };
        }
        if (existing.status === "denied") {
          return {
            decision: "denied",
            approvalId: existing.id,
            reason,
          };
        }
      }

      const approval = await options.repository.insertApproval({
        runId: request.runId,
        stepId: null,
        actorUserId: request.actorUserId,
        actionHash: hash,
        action: { name: call.name, arguments: call.arguments },
        destination: request.destination ?? observation.url ?? null,
        expectedEffect,
        expiresAt: new Date(now() + options.ttlMs),
      });
      return { decision: "requested", approvalId: approval.id };
    },

    async consume(approvalId, actionHash) {
      const spent = await options.repository.consumeApproval(
        approvalId,
        actionHash,
      );
      return spent !== undefined;
    },
  };
}

/** A linha, do jeito que uma notificação precisa dela. */
export function approvalPrompt(row: RunApprovalRow): {
  action: string;
  expectedEffect: string;
  destination: string | null;
} {
  const action = (row.action as { name?: string } | null)?.name ?? "ação";
  return {
    action,
    expectedEffect: row.expectedEffect ?? "Executar a ação proposta.",
    destination: row.destination,
  };
}
