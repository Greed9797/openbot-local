import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * Uma tarefa durável como o navegador a vê.
 *
 * Os nomes seguem o contrato de `/api/agent-runs` (RunView, StepView, ...), e os campos são os
 * mesmos do servidor — este módulo não inventa vocabulário, só o replica para que a tela compile
 * sem importar de `server/`, que a superfície web não pode tocar.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_model"
  | "executing"
  | "waiting_approval"
  | "waiting_human"
  | "paused"
  | "needs_reconciliation"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RunOrigin = "web" | "telegram" | "api";

export type StepKind =
  | "observation"
  | "decision"
  | "action"
  | "execution"
  | "note"
  | "delegated";

export type RunView = {
  id: string;
  botId: string;
  userId: string | null;
  threadId: string | null;
  origin: RunOrigin;
  provider: string;
  model: string;
  objective: string;
  status: RunStatus;
  currentStep: number;
  budget: { maxSteps: number; maxMs: number; maxCorrections: number };
  usage: {
    steps: number;
    activeMs: number;
    modelCalls: number;
    toolCalls: number;
    startedAt?: string;
  };
  checkpoint: unknown | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  metadata: Record<string, unknown>;
};

export type StepView = {
  id: string;
  seq: number;
  kind: StepKind;
  status: string;
  observation: Record<string, unknown> | null;
  modelDecision: Record<string, unknown> | null;
  proposedAction: Record<string, unknown> | null;
  policyDecision: Record<string, unknown> | null;
  executionResult: Record<string, unknown> | null;
  artifactId: string | null;
  startedAt: string;
  finishedAt: string | null;
};

// Os estados em que a tarefa ainda pode mudar sozinha, como tabela estática: só pertencer aqui
// liga o polling, e acrescentar um estado novo numa ponta sem a outra é o erro que isto evita.
const TAREFAS_VIVAS: Partial<Record<RunStatus, true>> = {
  queued: true,
  running: true,
  waiting_model: true,
  executing: true,
  waiting_approval: true,
  waiting_human: true,
};

/** Se a tarefa ainda anda sozinha e vale a pena perguntar ao servidor de novo. */
export function tarefaViva(status: RunStatus | undefined): boolean {
  return status !== undefined && TAREFAS_VIVAS[status] === true;
}

export type EventView = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type MessageView = {
  seq: number;
  author: "person" | "system";
  kind: string;
  text: string;
  source: string;
  deliveredAt: string | null;
  stepSeq: number | null;
  createdAt: string;
};


export type ApprovalView = {
  id: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  actionName: string | null;
  action: Record<string, unknown>;
  destination: string | null;
  expectedEffect: string | null;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
};

/** O que a captura devolve: metadados, nunca os bytes (esses saem por `<img>`). */
export type ScreenshotArtifact = {
  id: string;
  mime: string;
};


export const taskKeys = {
  all: ["tasks"] as const,
  list: (filters?: { botId?: string; status?: RunStatus[] }) =>
    ["tasks", "list", filters ?? {}] as const,
  run: (runId: string) => ["tasks", "run", runId] as const,
  steps: (runId: string) => ["tasks", "run", runId, "steps"] as const,
  events: (runId: string) => ["tasks", "run", runId, "events"] as const,
  messages: (runId: string) => ["tasks", "run", runId, "messages"] as const,
  approvals: (runId: string) => ["tasks", "run", runId, "approvals"] as const,
};

export type TaskListFilters = {
  botId?: string;
  status?: RunStatus[];
  limit?: number;
};

export function taskListQueryOptions(filters: TaskListFilters = {}) {
  const params = new URLSearchParams();
  if (filters.botId) params.set("botId", filters.botId);
  // O servidor lê `status` separado por vírgula num parâmetro só.
  if (filters.status?.length) params.set("status", filters.status.join(","));
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  const query = params.size ? `?${params.toString()}` : "";
  return queryOptions({
    queryKey: taskKeys.list({
      ...(filters.botId ? { botId: filters.botId } : {}),
      ...(filters.status?.length ? { status: filters.status } : {}),
    }),
    queryFn: (): Promise<RunView[]> =>
      client(`/api/agent-runs${query}`, "runs", {
        fallback: "Não foi possível listar as tarefas.",
      }),
    // A lista só precisa piscar enquanto alguma tarefa nela ainda anda.
    refetchInterval: (query) => {
      const runs = query.state.data as RunView[] | undefined;
      return runs?.some((run) => tarefaViva(run.status)) ? 3000 : false;
    },
  });
}

export function taskRunQueryOptions(runId: string) {
  return queryOptions({
    queryKey: taskKeys.run(runId),
    queryFn: (): Promise<RunView> =>
      client(`/api/agent-runs/${encodeURIComponent(runId)}`, "run", {
        fallback: "Não foi possível carregar a tarefa.",
      }),
    refetchInterval: (query) => {
      const run = query.state.data as RunView | undefined;
      return tarefaViva(run?.status) ? 2000 : false;
    },
  });
}

/*
 * Os recursos abaixo não carregam o estado da tarefa no corpo, então quem chama diz se ela está
 * viva (lendo o `taskRunQueryOptions` da mesma tela). Sem isso o polling não saberia quando parar.
 */
export function taskStepsQueryOptions(runId: string, viva = false) {
  return queryOptions({
    queryKey: taskKeys.steps(runId),
    queryFn: (): Promise<StepView[]> =>
      client(`/api/agent-runs/${encodeURIComponent(runId)}/steps`, "steps", {
        fallback: "Não foi possível carregar os passos.",
      }),
    refetchInterval: viva ? 2000 : false,
  });
}

export function taskEventsQueryOptions(runId: string, viva = false) {
  return queryOptions({
    queryKey: taskKeys.events(runId),
    queryFn: (): Promise<EventView[]> =>
      client(`/api/agent-runs/${encodeURIComponent(runId)}/events`, "events", {
        fallback: "Não foi possível carregar os eventos.",
      }),
    refetchInterval: viva ? 3000 : false,
  });
}

export function taskMessagesQueryOptions(runId: string, viva = false) {
  return queryOptions({
    queryKey: taskKeys.messages(runId),
    queryFn: (): Promise<MessageView[]> =>
      client(
        `/api/agent-runs/${encodeURIComponent(runId)}/messages`,
        "messages",
        { fallback: "Não foi possível carregar a conversa." },
      ),
    refetchInterval: viva ? 3000 : false,
  });
}

export function taskApprovalsQueryOptions(runId: string, viva = false) {
  return queryOptions({
    queryKey: taskKeys.approvals(runId),
    queryFn: (): Promise<ApprovalView[]> =>
      client(
        `/api/agent-runs/${encodeURIComponent(runId)}/approvals`,
        "approvals",
        { fallback: "Não foi possível carregar as aprovações." },
      ),
    refetchInterval: viva ? 3000 : false,
  });
}

/**
 * Pede uma captura da tela do navegador da tarefa.
 *
 * Não é query porque o resultado não vai para o cache: o chamador guarda o `id` e mostra os bytes
 * com `<img src="/api/agent-runs/:id/artifacts/:artifactId">`, que viaja com os cookies da sessão.
 * O 502 (navegador não respondeu) e o 503 (deployment sem navegador) chegam como `Error` com a
 * frase do servidor, para a tela mostrar como mensagem.
 */
export async function requestTaskScreenshot(
  runId: string,
): Promise<ScreenshotArtifact> {
  return client(
    `/api/agent-runs/${encodeURIComponent(runId)}/screenshot`,
    "artifact",
    {
      method: "POST",
      fallback: "Não foi possível capturar a tela.",
    },
  );
}

/** Os bytes de uma captura, para usar direto como `src` de `<img>`. */
export function taskArtifactUrl(runId: string, artifactId: string): string {
  return `/api/agent-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}
