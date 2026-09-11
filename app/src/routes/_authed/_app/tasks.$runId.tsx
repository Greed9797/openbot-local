import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { TaskApprovals } from "@/components/tasks/task-approval";
import { TaskConversation } from "@/components/tasks/task-conversation";
import { TaskEvents } from "@/components/tasks/task-events";
import { TaskScreenshot } from "@/components/tasks/task-screenshot";
import { TaskStatus } from "@/components/tasks/task-status";
import { TaskSteps } from "@/components/tasks/task-steps";
import { Button } from "@/components/ui/button";
import {
  cancelTaskMutationOptions,
  pauseTaskMutationOptions,
  resumeTaskMutationOptions,
} from "@/lib/tasks/mutations";
import {
  tarefaViva,
  taskApprovalsQueryOptions,
  taskEventsQueryOptions,
  taskKeys,
  taskMessagesQueryOptions,
  taskRunQueryOptions,
  taskStepsQueryOptions,
  type RunStatus,
} from "@/lib/tasks/queries";

export const Route = createFileRoute("/_authed/_app/tasks/$runId")({
  component: TaskDetailPage,
});

/** Quais botões de comando fazem sentido para cada estado — o servidor decide de verdade (409 quando não faz), a tela só não oferece o óbvio errado. */
const COMANDOS_POR_ESTADO: Record<
  RunStatus,
  { pausar: boolean; retomar: boolean; cancelar: boolean }
> = {
  queued: { pausar: true, retomar: false, cancelar: true },
  running: { pausar: true, retomar: false, cancelar: true },
  waiting_model: { pausar: true, retomar: false, cancelar: true },
  executing: { pausar: true, retomar: false, cancelar: true },
  waiting_approval: { pausar: true, retomar: false, cancelar: true },
  waiting_human: { pausar: true, retomar: false, cancelar: true },
  paused: { pausar: false, retomar: true, cancelar: true },
  needs_reconciliation: { pausar: false, retomar: false, cancelar: true },
  succeeded: { pausar: false, retomar: false, cancelar: false },
  failed: { pausar: false, retomar: false, cancelar: false },
  cancelled: { pausar: false, retomar: false, cancelar: false },
};

function TaskDetailPage() {
  const { runId } = Route.useParams();
  const queryClient = useQueryClient();
  const [erroComando, setErroComando] = useState<string | null>(null);

  const tarefa = useQuery(taskRunQueryOptions(runId));
  const viva = tarefaViva(tarefa.data?.status);
  const passos = useQuery(taskStepsQueryOptions(runId, viva));
  const eventos = useQuery(taskEventsQueryOptions(runId, viva));
  const conversa = useQuery(taskMessagesQueryOptions(runId, viva));
  const aprovacoes = useQuery(taskApprovalsQueryOptions(runId, viva));

  /*
   * Última olhada em cada mudança de estado.
   *
   * O passo e o evento finais são gravados no servidor no mesmo instante em que o estado vira
   * terminal — e é justamente aí que o polling dos recursos filhos desliga. Sem esta releitura, uma
   * tarefa que termina entre dois tiques aparece como "nenhum passo ainda" para sempre. O custo é
   * uma releitura por transição (a do primeiro render é deduplicada com a do próprio mount).
   */
  const estadoDaTarefa = tarefa.data?.status;
  useEffect(() => {
    if (!estadoDaTarefa) return;
    for (const chave of [
      taskKeys.steps(runId),
      taskKeys.events(runId),
      taskKeys.messages(runId),
      taskKeys.approvals(runId),
    ]) {
      void queryClient.invalidateQueries({ queryKey: chave });
    }
  }, [estadoDaTarefa, runId, queryClient]);

  /*
   * Três mutações, um erro só: pausar, retomar e cancelar são o mesmo gesto ("mude o estado da
   * tarefa"), e três parágrafos de erro empilhados diriam menos que um. A invalidação das consultas
   * vem da própria fábrica; aqui só se diz o que fazer além dela.
   */
  const reacoesDeComando = {
    onError: (thrown: Error) => setErroComando(thrown.message),
    onSuccess: () => setErroComando(null),
  };
  const pausar = useMutation(
    pauseTaskMutationOptions(queryClient, reacoesDeComando),
  );
  const retomar = useMutation(
    resumeTaskMutationOptions(queryClient, reacoesDeComando),
  );
  const cancelar = useMutation(
    cancelTaskMutationOptions(queryClient, reacoesDeComando),
  );
  const comandando =
    pausar.isPending || retomar.isPending || cancelar.isPending;

  if (tarefa.isPending) {
    return (
      <PageShell
        backButton={{ linkProps: { to: "/tasks" }, label: "Tarefas" }}
        title="Carregando tarefa…"
      >
        <p className="mt-4 text-muted-foreground text-sm">
          Buscando os dados da tarefa.
        </p>
      </PageShell>
    );
  }

  if (tarefa.isError || !tarefa.data) {
    return (
      <PageShell
        backButton={{ linkProps: { to: "/tasks" }, label: "Tarefas" }}
        title="Tarefa não encontrada"
      >
        <p className="mt-4 text-destructive text-sm" role="alert">
          {tarefa.error instanceof Error
            ? tarefa.error.message
            : "Não foi possível carregar a tarefa."}
        </p>
      </PageShell>
    );
  }

  const run = tarefa.data;
  const comandos = COMANDOS_POR_ESTADO[run.status];

  return (
    <PageShell
      backButton={{ linkProps: { to: "/tasks" }, label: "Tarefas" }}
      description={`${run.botId} · ${run.provider}/${run.model} · passo ${run.currentStep} (${run.usage.steps} usados)`}
      title={run.objective}
      width="wide"
    >
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <TaskStatus status={run.status} />
        {comandos.pausar ? (
          <Button
            disabled={comandando}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => pausar.mutate(runId)}
          >
            Pausar
          </Button>
        ) : null}
        {comandos.retomar ? (
          <Button
            disabled={comandando}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => retomar.mutate(runId)}
          >
            Retomar
          </Button>
        ) : null}
        {comandos.cancelar ? (
          <Button
            disabled={comandando}
            size="sm"
            type="button"
            variant="destructive"
            onClick={() => cancelar.mutate(runId)}
          >
            Cancelar
          </Button>
        ) : null}
      </div>
      {erroComando ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {erroComando}
        </p>
      ) : null}
      {run.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {run.error.code}: {run.error.message}
        </p>
      ) : null}

      <PageSection title="Passos">
        <div className="mt-4">
          {passos.isPending ? (
            <p className="text-muted-foreground text-sm">Carregando passos…</p>
          ) : passos.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {passos.error instanceof Error
                ? passos.error.message
                : "Não foi possível carregar os passos."}
            </p>
          ) : (
            <TaskSteps runId={runId} steps={passos.data ?? []} />
          )}
        </div>
      </PageSection>

      <PageSection title="Conversa">
        <div className="mt-4">
          {conversa.isPending ? (
            <p className="text-muted-foreground text-sm">
              Carregando conversa…
            </p>
          ) : conversa.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {conversa.error instanceof Error
                ? conversa.error.message
                : "Não foi possível carregar a conversa."}
            </p>
          ) : (
            <TaskConversation runId={runId} messages={conversa.data ?? []} />
          )}
        </div>
      </PageSection>

      <PageSection title="Aprovações">
        <div className="mt-4">
          {aprovacoes.isPending ? (
            <p className="text-muted-foreground text-sm">
              Carregando aprovações…
            </p>
          ) : aprovacoes.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {aprovacoes.error instanceof Error
                ? aprovacoes.error.message
                : "Não foi possível carregar as aprovações."}
            </p>
          ) : (
            <TaskApprovals runId={runId} approvals={aprovacoes.data ?? []} />
          )}
        </div>
      </PageSection>

      <PageSection
        description="Uma foto do que o navegador está vendo agora."
        title="Captura de tela"
      >
        <div className="mt-4">
          <TaskScreenshot runId={runId} />
        </div>
      </PageSection>

      <PageSection title="Eventos">
        <div className="mt-4">
          {eventos.isPending ? (
            <p className="text-muted-foreground text-sm">
              Carregando eventos…
            </p>
          ) : eventos.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {eventos.error instanceof Error
                ? eventos.error.message
                : "Não foi possível carregar os eventos."}
            </p>
          ) : (
            <TaskEvents events={eventos.data ?? []} />
          )}
        </div>
      </PageSection>
    </PageShell>
  );
}
