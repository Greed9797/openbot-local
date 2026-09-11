import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { TaskStatus } from "@/components/tasks/task-status";
import { TelegramPairing } from "@/components/tasks/telegram-pairing";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { createTaskMutationOptions } from "@/lib/tasks/mutations";
import { taskListQueryOptions } from "@/lib/tasks/queries";

export const Route = createFileRoute("/_authed/_app/tasks/")({
  component: TasksPage,
});

/**
 * O formulário cria de verdade (POST em `/api/agent-runs`) e leva ao detalhe da tarefa nascida;
 * a lista lê de verdade (GET em `/api/agent-runs`) e diz com honestidade quando está vazia, em vez
 * de fingir movimento com esqueleto infinito.
 */
function TasksPage() {
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const tarefas = useQuery(taskListQueryOptions());
  const colegas = useQuery(agentListQueryOptions());

  const [botId, setBotId] = useState("");
  const [objetivo, setObjetivo] = useState("");
  const [provedor, setProvedor] = useState("");
  const [modelo, setModelo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const criar = useMutation(
    createTaskMutationOptions(queryClient, {
      onError: (thrown) => setErro(thrown.message),
      onSuccess: (run) => {
        setErro(null);
        setObjetivo("");
        navigate({ to: "/tasks/$runId", params: { runId: run.id } });
      },
    }),
  );

  // O Bot escolhido sobrevive à lista carregar depois: fixa o primeiro colega uma vez só.
  const botEscolhido = botId || colegas.data?.[0]?.id || "";

  return (
    <PageShell
      description="Dê um objetivo a um Bot e acompanhe o navegador trabalhando: passos, conversa, aprovações e capturas."
      title="Tarefas"
      width="wide"
    >
      <PageSection
        description="A tarefa nasce na fila e anda sozinha até precisar de você."
        title="Nova tarefa"
      >
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!objetivo.trim() || !botEscolhido || criar.isPending) return;
            criar.mutate({
              botId: botEscolhido,
              objective: objetivo.trim(),
              ...(provedor.trim() ? { provider: provedor.trim() } : {}),
              ...(modelo.trim() ? { model: modelo.trim() } : {}),
            });
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="tarefa-bot">Bot</FieldLabel>
              <Select
                disabled={!colegas.data?.length}
                onValueChange={(value) => setBotId(value ?? "")}
                value={botEscolhido}
              >
                <SelectTrigger id="tarefa-bot">
                  <SelectValue placeholder="Escolha o Bot" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(colegas.data ?? []).map((colega) => (
                      <SelectItem key={colega.id} value={colega.id}>
                        {colega.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="tarefa-objetivo">Objetivo</FieldLabel>
              <Textarea
                id="tarefa-objetivo"
                placeholder="Ex.: abra a página de extratos e confira os lançamentos de hoje"
                rows={3}
                value={objetivo}
                onChange={(event) => setObjetivo(event.target.value)}
              />
            </Field>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Field className="flex-1">
                <FieldLabel htmlFor="tarefa-provedor">
                  Provedor (opcional)
                </FieldLabel>
                <Input
                  id="tarefa-provedor"
                  placeholder="Padrão do Bot"
                  value={provedor}
                  onChange={(event) => setProvedor(event.target.value)}
                />
              </Field>
              <Field className="flex-1">
                <FieldLabel htmlFor="tarefa-modelo">Modelo (opcional)</FieldLabel>
                <Input
                  id="tarefa-modelo"
                  placeholder="Padrão do Bot"
                  value={modelo}
                  onChange={(event) => setModelo(event.target.value)}
                />
              </Field>
            </div>
          </FieldGroup>
          {erro ? (
            <p className="text-destructive text-sm" role="alert">
              {erro}
            </p>
          ) : null}
          <div>
            <Button
              disabled={
                !objetivo.trim() || !botEscolhido || criar.isPending
              }
              type="submit"
            >
              {criar.isPending ? "Criando…" : "Criar tarefa"}
            </Button>
          </div>
        </form>
      </PageSection>

      <PageSection
        description="Um chat do Telegram opera o mesmo runtime: mesmas tarefas, mesma política, mesma auditoria."
        title="Telegram"
      >
        <TelegramPairing />
      </PageSection>

      <PageSection title="Suas tarefas">
        {tarefas.isPending ? (
          <p className="mt-4 text-muted-foreground text-sm">Carregando…</p>
        ) : tarefas.isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {tarefas.error instanceof Error
              ? tarefas.error.message
              : "Não foi possível listar as tarefas."}
          </p>
        ) : (tarefas.data ?? []).length === 0 ? (
          <Empty className="mt-4 border border-dashed">
            <EmptyHeader>
              <EmptyTitle>Nenhuma tarefa ainda</EmptyTitle>
              <EmptyDescription className="text-pretty">
                Descreva um objetivo acima e o Bot começa a trabalhar nele.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ol className="mt-4 flex flex-col gap-2">
            {(tarefas.data ?? []).map((run) => (
              <li key={run.id}>
                <Link
                  className="flex flex-col gap-1.5 rounded-lg border p-3 transition-colors hover:bg-muted/50"
                  params={{ runId: run.id }}
                  to="/tasks/$runId"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-sm">
                      {run.objective}
                    </span>
                    <TaskStatus status={run.status} />
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {run.botId}
                    {" · "}
                    {run.provider}/{run.model}
                    {" · "}
                    passo {run.currentStep} ({run.usage.steps} usados)
                    {" · "}
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </PageSection>
    </PageShell>
  );
}
