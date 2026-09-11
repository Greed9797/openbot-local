import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { decideApprovalMutationOptions } from "@/lib/tasks/mutations";
import type { ApprovalView } from "@/lib/tasks/queries";

const ROTULOS_APROVACAO: Record<ApprovalView["status"], string> = {
  pending: "Pendente",
  approved: "Aprovada",
  denied: "Recusada",
  expired: "Expirada",
  consumed: "Consumida",
};

/**
 * Uma aprovação e o sim/não da pessoa.
 *
 * O motivo é opcional porque a decisão comum é rápida ("pode clicar"); obrigá-lo transformaria
 * cada aprovação rotineira num formulário. O erro de decisão aparece no cartão, não na página:
 * as outras aprovações continuam decidíveis.
 */
function CartaoAprovacao({
  runId,
  approval,
}: {
  runId: string;
  approval: ApprovalView;
}) {
  const queryClient = useQueryClient();
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const decidir = useMutation(
    decideApprovalMutationOptions(queryClient, {
      onError: (thrown) => setErro(thrown.message),
      onSuccess: () => setErro(null),
    }),
  );
  const pendente = approval.status === "pending";

  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium text-sm">
          {approval.actionName ?? "Ação"}
        </span>
        <span className="text-muted-foreground text-xs">
          {ROTULOS_APROVACAO[approval.status]}
        </span>
      </div>
      {approval.destination ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Destino: </span>
          {approval.destination}
        </p>
      ) : null}
      {approval.expectedEffect ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Efeito esperado: </span>
          {approval.expectedEffect}
        </p>
      ) : null}
      <pre className="overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs leading-relaxed">
        {JSON.stringify(approval.action, null, 2)}
      </pre>
      <p className="text-muted-foreground text-xs">
        Pedida em {new Date(approval.createdAt).toLocaleString()}
        {" · "}expira em {new Date(approval.expiresAt).toLocaleString()}
      </p>
      {approval.decidedAt ? (
        <p className="text-muted-foreground text-xs">
          Decidida em {new Date(approval.decidedAt).toLocaleString()}
          {approval.decidedBy ? ` por ${approval.decidedBy}` : ""}
        </p>
      ) : null}
      {pendente ? (
        <div className="flex flex-col gap-2">
          <Input
            aria-label="Motivo (opcional)"
            disabled={decidir.isPending}
            placeholder="Motivo (opcional)"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
          />
          {erro ? (
            <p className="text-destructive text-sm" role="alert">
              {erro}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              disabled={decidir.isPending}
              onClick={() =>
                decidir.mutate({
                  runId,
                  approvalId: approval.id,
                  decision: "approve",
                  ...(motivo.trim() ? { note: motivo.trim() } : {}),
                })
              }
              type="button"
            >
              {decidir.isPending ? "Decidindo…" : "Aprovar"}
            </Button>
            <Button
              disabled={decidir.isPending}
              type="button"
              variant="destructive"
              onClick={() =>
                decidir.mutate({
                  runId,
                  approvalId: approval.id,
                  decision: "deny",
                  ...(motivo.trim() ? { note: motivo.trim() } : {}),
                })
              }
            >
              Recusar
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function TaskApprovals({
  runId,
  approvals,
}: {
  runId: string;
  approvals: ApprovalView[];
}) {
  if (approvals.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nenhuma aprovação. Quando a tarefa precisar de um sim seu, o pedido
        aparece aqui.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-3">
      {approvals.map((approval) => (
        <CartaoAprovacao
          key={approval.id}
          approval={approval}
          runId={runId}
        />
      ))}
    </ol>
  );
}
