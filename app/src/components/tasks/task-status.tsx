import { cn } from "@/lib/utils";
import type { RunStatus } from "@/lib/tasks/queries";

/** O estado da tarefa em português, porque sigla de executor não é texto de interface. */
export const ROTULOS_STATUS: Record<RunStatus, string> = {
  queued: "Na fila",
  running: "Rodando",
  waiting_model: "Aguardando o modelo",
  executing: "Executando",
  waiting_approval: "Aguardando aprovação",
  waiting_human: "Aguardando você",
  paused: "Pausada",
  needs_reconciliation: "Precisa de conferência",
  succeeded: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
};

/*
 * Uma cor por destino, não por estado: o que anda é neutro, o que espera a pessoa chama atenção,
 * o que terminou bem confirma e o que quebrou avisa. Onze cores diferentes seriam onze prioridades
 * iguais.
 */
const CLASSE_POR_DESTINO: Record<RunStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-primary/10 text-primary",
  waiting_model: "bg-primary/10 text-primary",
  executing: "bg-primary/10 text-primary",
  waiting_approval: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  waiting_human: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  paused: "bg-muted text-muted-foreground",
  needs_reconciliation: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  succeeded: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

export function TaskStatus({ status }: { status: RunStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-medium text-xs",
        CLASSE_POR_DESTINO[status],
      )}
    >
      {ROTULOS_STATUS[status]}
    </span>
  );
}
