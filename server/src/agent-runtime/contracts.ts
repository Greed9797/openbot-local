/**
 * What a model provider is, and what it gets.
 *
 * The browser never sees these types; the runtime does. They exist so a new model family is an
 * adapter and not a change to any tool: the provider receives a structured observation and a
 * catalog, and answers with a tool call or a final message. Everything else — policy, audit,
 * navigation, screenshots — is the same code for every provider.
 */

import type { RunBudget, RunUsage } from "../agent-runs/types";
import type { ActionActor } from "../computer/gateway";
import type { SnapshotElement } from "../computer/schema";

/**
 * An image the model may look at.
 *
 * `data` is base64 and exists only on the way to an adapter: it is never written to a step, an
 * event or a log. What is persisted is the artifact id and its metadata.
 */
export type ObservationImage = {
  artifactId: string;
  mime: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
  /** True when the deployment applied masks to it before it got here. */
  protected: boolean;
  data: string;
};

/**
 * What the model knows about the page right now.
 *
 * DOM/accessibility first, pixels second: the elements are what a form is filled with, and the
 * image is what a canvas-only page is read with. A provider without vision simply finds no images.
 */
export type AgentObservation = {
  observationId: string;
  runId: string;
  url: string;
  title: string;
  /** The readable text of the page, truncated as the computer returns it. */
  text: string;
  truncated: boolean;
  /** Elements a ref can be resolved against; `snapshotId` is the generation those refs belong to. */
  elements: SnapshotElement[];
  snapshotId: number;
  viewport: { width: number; height: number };
  capturedAt: string;
  /** Who is driving the browser, and whether a secret is pending — both block acting. */
  control: { holder: "bot" | "human"; secretPending: boolean };
  images: ObservationImage[];
  /**
   * Why there is no image when one was asked for.
   *
   * "The capture failed" and "the capture was withheld" are different facts and both are worth
   * telling the model, which otherwise reads an empty `images` as a page with nothing to look at.
   * Absent when an image was delivered or when none was requested.
   */
  imageNote?: string;
  /** How many spans of the page text were removed before it was given to a model. */
  redactions: number;
  /** True when the engine was the text-only one and there is no Chromium page behind this. */
  textOnly: boolean;
};

/** One entry of the catalog, as a provider sends it to a model. */
export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  /** The provider's id for this call, when it has one. */
  callId?: string;
};

/** What executing a tool reports. `refused` is policy; `stale` asks for a new observation. */
export type ToolOutcome = {
  ok: boolean;
  result?: unknown;
  refused?: {
    rule: string | null;
    reason: string;
    /**
     * Por que a recusa aconteceu, quando quem recusou sabe dizer.
     *
     * `private_network` é a única causa hoje, e é a única com saída oferecível: a permissão de
     * navegar para dentro da rede é do Bot, então a tela consegue dizer onde ligá-la. A frase do
     * motivo continua sendo o que a pessoa lê.
     */
    cause?: "private_network";
  };
  stale?: boolean;
  /** The action ran but its external effect is unknown — a submit that timed out. */
  uncertain?: boolean;
  /** The tool asked for a person. */
  help?: { reason: string };
  error?: { code: string; message: string };
};

export type ToolCallContext = {
  /** Ausente numa ação humana via HTTP: pessoa não tem run. O runtime sempre passa o id real. */
  runId?: string;
  /** O computador em que a ferramenta age. Vem do run, nunca do modelo. */
  botId: string;
  stepSeq: number;
  actor: ActionActor;
  signal: AbortSignal;
};

/**
 * O que uma tentativa de modelo consumiu, quando o provedor disse.
 *
 * Desconhecido é null, nunca zero: zero afirmaria que nada foi gasto, e nenhum adaptador tem como
 * saber isso quando o provedor não reporta. Custo é null até existir tarifa explícita no contrato
 * local — nenhuma tabela de preços é inventada aqui. Só identidade e contadores viajam: nenhum
 * prompt, cookie ou credencial entra na telemetria.
 */
export type ModelAttemptUsage = {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cost: number | null;
};

/** Um número não-negativo finito, ou desconhecido. Texto, NaN e negativo viram null. */
export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * A condição que fecha a tarefa, declarada pelo host na criação — nunca pelo modelo.
 *
 * Três formas, sem JavaScript nem expressão arbitrária: um texto que precisa estar na página
 * atual, a URL onde a página precisa estar, ou um artefato que precisa pertencer ao run. A
 * verificação é host-side, contra observação fresca ou artefato real; prosa do modelo nunca
 * prova efeito externo.
 */
export type CompletionCondition =
  | { kind: "page_text"; text: string }
  | { kind: "page_url"; url: string }
  | { kind: "artifact"; artifactId?: string };

const COMPLETION_TEXT_LIMIT = 2_000;
const COMPLETION_URL_LIMIT = 2_000;
const COMPLETION_ARTIFACT_ID_LIMIT = 200;

/**
 * Valida a condição na fronteira de criação. Ausente é tarefa puramente textual, que conclui
 * sem prova externa. Devolve a condição normalizada, ou undefined quando ausente. Lança um
 * Error com a causa quando malformada — quem chama converte para o erro de fronteira dele.
 */
export function parseCompletionCondition(
  value: unknown,
): CompletionCondition | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A completion condition must be an object.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "page_text") {
    if (typeof raw.text !== "string" || !raw.text.trim()) {
      throw new Error('A "page_text" condition needs a non-empty "text".');
    }
    if (raw.text.trim().length > COMPLETION_TEXT_LIMIT) {
      throw new Error('A "page_text" condition holds at most 2000 characters.');
    }
    return { kind: "page_text", text: raw.text.trim() };
  }
  if (raw.kind === "page_url") {
    if (typeof raw.url !== "string" || !raw.url.trim()) {
      throw new Error('A "page_url" condition needs a non-empty "url".');
    }
    const url = raw.url.trim();
    if (url.length > COMPLETION_URL_LIMIT) {
      throw new Error('A "page_url" condition holds at most 2000 characters.');
    }
    const parsed = URL.parse(url);
    if (
      !parsed ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    ) {
      throw new Error('A "page_url" condition needs an http(s) URL.');
    }
    return { kind: "page_url", url };
  }
  if (raw.kind === "artifact") {
    if (raw.artifactId === undefined) return { kind: "artifact" };
    if (typeof raw.artifactId !== "string" || !raw.artifactId.trim()) {
      throw new Error(
        'An "artifact" condition needs a non-empty "artifactId".',
      );
    }
    const artifactId = raw.artifactId.trim();
    if (artifactId.length > COMPLETION_ARTIFACT_ID_LIMIT) {
      throw new Error('An "artifact" condition holds at most 200 characters.');
    }
    return { kind: "artifact", artifactId };
  }
  throw new Error(
    'A completion condition is one of "page_text", "page_url" or "artifact".',
  );
}

/**
 * Só identidade e contadores entram na telemetria; linha estranha ou sem identidade sai.
 * O provedor e o modelo reportados são preservados — um wrapper roteado relata a tentativa
 * subjacente, nunca o próprio id. Custo é sempre null: nenhuma tarifa é inventada aqui.
 */
export function sanitizeAttempt(value: unknown): ModelAttemptUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.provider !== "string" || !raw.provider) return null;
  if (typeof raw.model !== "string" || !raw.model) return null;
  return {
    provider: raw.provider,
    model: raw.model,
    inputTokens: tokenCount(raw.inputTokens),
    outputTokens: tokenCount(raw.outputTokens),
    cachedTokens: tokenCount(raw.cachedTokens),
    cost: null,
  };
}

/** Higieniza a lista persistida: só identidade e contadores sobrevivem — nunca texto. */
export function sanitizeAttempts(value: unknown): ModelAttemptUsage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const clean = sanitizeAttempt(entry);
    return clean ? [clean] : [];
  });
}

/**
 * A chave reservada onde a condição mora no JSON de metadata existente — sem coluna nova.
 * `verified` e `verification` são reservadas no mesmo gesto: metadata arbitrário nunca forja
 * resultado verificado, porque a verificação lê só esta chave, escrita aqui, e ignora o resto.
 */
export const COMPLETION_METADATA_KEY = "completion";
const FORGED_METADATA_KEYS: Record<string, true> = {
  completion: true,
  verified: true,
  verification: true,
};

/**
 * Junta o metadata arbitrário com a condição declarada, sem deixar o corpo forjar a prova:
 * chaves reservadas vindas de fora são descartadas; só o campo tipado escreve `completion`.
 */
export function metadataWithCompletion(
  metadata: Record<string, unknown> | undefined,
  completion: CompletionCondition | undefined,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(metadata ?? {})) {
    if (!FORGED_METADATA_KEYS[key]) clean[key] = entry;
  }
  if (completion) clean[COMPLETION_METADATA_KEY] = { ...completion };
  return clean;
}

/** Lê a condição que o host declarou na criação; corpo estranho ou ausente é "sem condição". */
export function completionOf(metadata: unknown): CompletionCondition | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  try {
    return (
      parseCompletionCondition(
        (metadata as Record<string, unknown>)[COMPLETION_METADATA_KEY],
      ) ?? null
    );
  } catch {
    return null;
  }
}

export interface ToolCatalog {
  definitions(): ToolDefinition[];
  execute(call: ToolCall, context: ToolCallContext): Promise<ToolOutcome>;
}

/** A condensation of earlier steps, so a provider does not need the whole table. */
export type AgentStepSummary = {
  seq: number;
  kind: string;
  summary: string;
};

export type AgentRunInput = {
  runId: string;
  botId: string;
  /**
   * A pessoa dona da tarefa.
   *
   * Só interessa ao provedor que delega: a declaração de execução que ele apresenta em nome desta
   * tarefa diz de quem ela é, e é daí que a auditoria tira o nome — não do corpo do pedido. Ausente
   * numa tarefa sem dono (um agendamento, por exemplo), e aí não há o que assinar.
   */
  actorId?: string;
  objective: string;
  /** Present unless the provider is expected to act blind on its first step. */
  observation: AgentObservation | null;
  /** Older steps, oldest first. */
  history: AgentStepSummary[];
  /**
   * O que uma pessoa disse desde o último passo, na ordem, e ainda não tinha sido levado ao modelo.
   *
   * Entregue uma única vez: quem conserva a restrição nos passos seguintes é `restrictions`.
   */
  messages?: { author: "person" | "system"; text: string; kind: string }[];
  /**
   * Restrições vigentes de mensagens anteriores da pessoa, as mais recentes por último.
   *
   * `messages` é entregue uma vez; isto aqui é o que continua valendo nos passos seguintes, até
   * substituição explícita ou o fim do run. Vem de `repository.messages` (só pessoa, já entregues,
   * limitadas e truncadas no loop) e chega ao modelo marcada como instrução da pessoa — nunca como
   * dado de página ou de ferramenta.
   */
  restrictions?: { text: string; kind: string }[];
  tools: ToolDefinition[];
  budget: RunBudget;
  usage: RunUsage;
  /**
   * O modelo que esta tarefa escolheu, quando escolheu um.
   *
   * Ausente é o caso comum e não é lacuna: o padrão vive no deployment (o ambiente) ou no serviço
   * que conduz o turno, e mandá-lo de volta como se fosse escolha apagaria essa distinção. Quem
   * escolheu é o Bot, ou a pessoa na tarefa — ver `agent_runs.model`.
   */
  model?: string;
  /** A person approved something and the run is resuming: the model should know why. */
  resumeNote?: string;
  /** The provider's own capabilities, repeated here so an adapter can refuse without a lookup. */
  capabilities: ModelCapabilities;
  /**
   * Quando presente, substitui o papel padrão do sistema.
   *
   * Existe para a pergunta que não é um passo de tarefa — "o que está nesta captura?" —, onde não há
   * ferramenta, histórico nem próximo passo, e sim uma imagem e uma frase. Os adaptadores continuam
   * montando o prompt do mesmo jeito; o que muda é quem escreve as instruções.
   */
  instructions?: string;
};

export type AgentRunContext = {
  signal: AbortSignal;
  /** Streaming text out, for the surfaces that show progress. */
  onDelta?: (text: string) => void;
  /** Routed providers report each underlying attempt, including failures. */
  onAttempt?: (usage: ModelAttemptUsage) => void;
};

/**
 * What the model decided.
 *
 * `tool_call` asks for one action; `final` says the task is done and why; `help` stops for a
 * person; `invalid` is a malformed answer, which the loop may ask to be corrected a bounded number
 * of times. `delegated` is the Codex-shaped result: the CLI drove its own loop and the runtime is
 * being told how it went.
 */
export type AgentRunResult =
  | {
      kind: "tool_call";
      call: ToolCall;
      text?: string;
      usage?: ModelAttemptUsage;
    }
  | {
      kind: "final";
      message: string;
      evidence?: Record<string, unknown>;
      usage?: ModelAttemptUsage;
    }
  | { kind: "help"; reason: string; usage?: ModelAttemptUsage }
  | { kind: "invalid"; raw: string; error: string; usage?: ModelAttemptUsage }
  | {
      kind: "delegated";
      message: string;
      toolCalls: number;
      evidence?: Record<string, unknown>;
      usage?: ModelAttemptUsage;
    };

export type ModelCapabilities = {
  vision: boolean;
  tools: boolean;
  streaming: boolean;
  /**
   * `step`: the runtime drives observe→decide→act and calls `run` once per step.
   * `delegated`: the provider drives its own loop and `run` returns once per task.
   */
  mode: "step" | "delegated";
};

export interface AgentModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  run(input: AgentRunInput, context: AgentRunContext): Promise<AgentRunResult>;
}

export interface ProviderRegistry {
  get(id: string): AgentModelProvider | undefined;
  /** The provider a run with no explicit choice uses. */
  default(): AgentModelProvider | undefined;
  list(): { id: string; capabilities: ModelCapabilities }[];
}

/**
 * Where observations come from.
 *
 * The loop does not know whether that is a browser, a test fixture or the text-only engine. It asks
 * for the current state and gets one, with the refs and the generation that make acting possible.
 */
export type ObservationRequest = {
  runId: string;
  botId: string;
  actor: ActionActor;
  /** Whether an image is wanted this time. A provider without vision never asks. */
  wantImage: boolean;
  signal: AbortSignal;
};

export interface ObservationSource {
  observe(request: ObservationRequest): Promise<AgentObservation>;
}

/**
 * Whether a proposed action must wait for a person, and how that yes is recorded.
 *
 * Absent means nothing requires approval, which is correct for a deployment that has not configured
 * it. The loop calls this before every acting tool.
 */
export type ApprovalRequest = {
  runId: string;
  stepSeq: number;
  actorUserId: string | null;
  actionHash: string;
  action: Record<string, unknown>;
  destination: string | null;
  expectedEffect: string | null;
};

export interface ApprovalGate {
  /**
   * Decide whether the call needs a person, and if so, record the request.
   *
   * `approved` means the gate already holds a consumed-once yes for exactly this action. `denied`
   * means a person said no to this exact action: the loop tells the model so and carries on, because
   * a refusal is information, not the end of the task.
   */
  review(
    call: { name: string; arguments: Record<string, unknown> },
    observation: AgentObservation,
    request: {
      runId: string;
      stepSeq: number;
      actorUserId: string | null;
      destination?: string | null;
    },
  ): Promise<
    | { decision: "run" }
    | { decision: "approved"; approvalId: string }
    | { decision: "requested"; approvalId: string }
    | { decision: "denied"; approvalId: string; reason: string }
  >;
  /** Spend the yes on this exact action. False means it is no longer valid. */
  consume(approvalId: string, actionHash: string): Promise<boolean>;
}

/** Where a run announces what happened, for surfaces that are not watching. */
export interface RunNotifier {
  statusChanged(input: {
    runId: string;
    botId: string;
    userId: string | null;
    from: string;
    to: string;
    reason?: string;
    message?: string;
  }): Promise<void>;
}

export type RunExecutorOptions = {
  providers: ProviderRegistry;
  observations: ObservationSource;
  tools: ToolCatalog;
  approvals?: ApprovalGate;
  notifier?: RunNotifier;
  /** How long the profile lock this run holds lasts without a heartbeat. */
  leaseTtlMs: number;
  /** How many invalid model answers are corrected before the run asks for help. */
  maxCorrections: number;
  /** How many consecutive policy refusals are tolerated before the run fails. */
  maxRefusals: number;
  /** How many times a provider error is retried before the run fails. */
  maxProviderRetries: number;
  /**
   * O modelo que este deployment usa quando ninguém escolheu.
   *
   * Existe para o loop saber distinguir uma escolha de um padrão: `agent_runs.model` é `NOT NULL` e
   * sempre traz alguma coisa, então é a comparação com este valor que diz se a tarefa pediu um
   * modelo ou só herdou o de sempre. Ver `AgentRunInput.model`.
   */
  defaultModel?: string;
};
