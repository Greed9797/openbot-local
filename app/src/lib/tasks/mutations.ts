import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { taskKeys, type ApprovalView, type RunView } from "./queries";

function invalidateTasks(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: taskKeys.all });
}

/**
 * O que a tela acrescenta à mutação, sem tirar nada dela.
 *
 * Toda mutação deste módulo invalida as consultas de tarefas. Quem chama diz o que fazer além disso
 * — limpar o campo, navegar, mostrar o erro em linha. Espalhar as opções da fábrica e escrever um
 * `onSuccess` por cima *substituiria* a invalidação em silêncio: foi assim que uma mensagem enviada
 * não aparecia na conversa, e é o erro que este tipo existe para não deixar acontecer de novo.
 */
export type Reacoes<TData, TVariables> = {
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
};

export type CreateTaskInput = {
  botId: string;
  objective: string;
  provider?: string;
  model?: string;
};

/**
 * Abre uma tarefa nova.
 *
 * A chave de idempotência vai no corpo (o contrato a aceita ali) para que um duplo clique não abra
 * duas tarefas: a segunda chamada devolve a tarefa que já existe em vez de criar outra.
 */
export function createTaskMutationOptions(
  queryClient: QueryClient,
  reacoes?: Reacoes<RunView, CreateTaskInput>,
) {
  return mutationOptions({
    mutationFn: async (input: CreateTaskInput): Promise<RunView> => {
      const body: Record<string, string> = {
        botId: input.botId,
        objective: input.objective,
        idempotencyKey: crypto.randomUUID(),
      };
      if (input.provider?.trim()) body.provider = input.provider.trim();
      if (input.model?.trim()) body.model = input.model.trim();
      return client("/api/agent-runs", "run", {
        method: "POST",
        body,
        fallback: "Não foi possível criar a tarefa.",
      });
    },
    onSuccess: (run, input) => {
      void invalidateTasks(queryClient);
      reacoes?.onSuccess?.(run, input);
    },
    onError: (error, input) => reacoes?.onError?.(error, input),
  });
}

/**
 * Pausar, retomar e cancelar são três rotas com o mesmo formato (POST que devolve `{ run }`), então
 * uma fábrica só — três cópias da mesma mutação divergiriam na primeira mensagem de erro.
 */
function runControlMutationOptions(
  queryClient: QueryClient,
  action: "pause" | "resume" | "cancel",
  fallback: string,
  reacoes?: Reacoes<RunView, string>,
) {
  return mutationOptions({
    mutationFn: (runId: string): Promise<RunView> =>
      client(`/api/agent-runs/${encodeURIComponent(runId)}/${action}`, "run", {
        method: "POST",
        fallback,
      }),
    onSuccess: (run, runId) => {
      void invalidateTasks(queryClient);
      reacoes?.onSuccess?.(run, runId);
    },
    onError: (error, runId) => reacoes?.onError?.(error, runId),
  });
}

export function pauseTaskMutationOptions(
  queryClient: QueryClient,
  reacoes?: Reacoes<RunView, string>,
) {
  return runControlMutationOptions(
    queryClient,
    "pause",
    "Não foi possível pausar a tarefa.",
    reacoes,
  );
}

export function resumeTaskMutationOptions(
  queryClient: QueryClient,
  reacoes?: Reacoes<RunView, string>,
) {
  return runControlMutationOptions(
    queryClient,
    "resume",
    "Não foi possível retomar a tarefa.",
    reacoes,
  );
}

export function cancelTaskMutationOptions(
  queryClient: QueryClient,
  reacoes?: Reacoes<RunView, string>,
) {
  return runControlMutationOptions(
    queryClient,
    "cancel",
    "Não foi possível cancelar a tarefa.",
    reacoes,
  );
}

export type SendMessageInput = { runId: string; text: string };

export function sendTaskMessageMutationOptions(
  queryClient: QueryClient,
  reacoes?: Reacoes<RunView, SendMessageInput>,
) {
  return mutationOptions({
    mutationFn: (variables: SendMessageInput): Promise<RunView> =>
      client(
        `/api/agent-runs/${encodeURIComponent(variables.runId)}/messages`,
        "run",
        {
          method: "POST",
          body: { text: variables.text },
          fallback: "Não foi possível enviar a mensagem.",
        },
      ),
    onSuccess: (run, variables) => {
      void invalidateTasks(queryClient);
      reacoes?.onSuccess?.(run, variables);
    },
    onError: (error, variables) => reacoes?.onError?.(error, variables),
  });
}

export type ApprovalDecision = "approve" | "deny";

export type ApprovalDecisionInput = {
  runId: string;
  approvalId: string;
  decision: ApprovalDecision;
  note?: string;
};

export type ApprovalDecisionResult = { run: RunView; approval: ApprovalView };

export function decideApprovalMutationOptions(
  queryClient: QueryClient,
  reacoes?: Reacoes<ApprovalDecisionResult, ApprovalDecisionInput>,
) {
  return mutationOptions({
    /*
     * Sem chave de envelope: a resposta traz `{ run, approval }`, duas cargas, e desembrulhar uma
     * só descartaria a outra. O `Response` volta para o chamador ler o JSON inteiro.
     */
    mutationFn: async (
      variables: ApprovalDecisionInput,
    ): Promise<ApprovalDecisionResult> => {
      const response = await client(
        `/api/agent-runs/${encodeURIComponent(variables.runId)}/approvals/${encodeURIComponent(variables.approvalId)}`,
        {
          method: "POST",
          body: {
            decision: variables.decision,
            ...(variables.note?.trim() ? { note: variables.note.trim() } : {}),
          },
          fallback: "Não foi possível decidir a aprovação.",
        },
      );
      return response.json();
    },
    onSuccess: (result, variables) => {
      void invalidateTasks(queryClient);
      reacoes?.onSuccess?.(result, variables);
    },
    onError: (error, variables) => reacoes?.onError?.(error, variables),
  });
}
