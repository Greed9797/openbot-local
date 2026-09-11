/**
 * The vocabulary of a durable task.
 *
 * Kept apart from the schema so the API, the worker and the channels can agree on the words without
 * importing Drizzle. Nothing here decides anything; it names the things that are decided.
 */

/**
 * Where a run is.
 *
 * `uncertain` is the word the product brief uses for an action whose external effect is unknown;
 * here it is `needs_reconciliation`, which says what has to happen next instead of how it feels.
 * `completed` is `succeeded`, and the pair never both appear.
 */
export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_model",
  "executing",
  "waiting_approval",
  "waiting_human",
  "paused",
  "needs_reconciliation",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunOrigin = "web" | "telegram" | "api";

export type StepKind = (typeof STEP_KINDS)[number];
export const STEP_KINDS = [
  "observation",
  "decision",
  "action",
  "execution",
  "note",
  "delegated",
] as const;

/**
 * Why a run stopped.
 *
 * These are the codes the brief asks for; a refusal is never retried forever, and a caller can tell
 * `POLICY_DENIED` from `PROVIDER_UNAVAILABLE` without reading prose.
 */
export const RUN_ERROR_CODES = [
  "MODEL_UNSUPPORTED",
  "INVALID_ACTION",
  "STALE_OBSERVATION",
  "POLICY_DENIED",
  "HUMAN_REQUIRED",
  "BUDGET_EXCEEDED",
  "PROVIDER_UNAVAILABLE",
  "EFFECT_UNCERTAIN",
  "ARTIFACT_NOT_SHAREABLE",
  "CANCELLED",
  "INTERNAL",
] as const;

export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

export type RunError = {
  code: RunErrorCode;
  message: string;
  /** The policy rule that refused it, when the refusal came from policy. */
  rule?: string;
};

/** What the run was admitted with. Persisted, because a limit is part of the task's contract. */
export type RunBudget = {
  maxSteps: number;
  maxMs: number;
  /** Model retries after an invalid decision, before the run asks for help. */
  maxCorrections: number;
};

/** What it consumed. `activeMs` excludes waiting on a person. */
export type RunUsage = {
  steps: number;
  activeMs: number;
  /** Model calls and tool calls, for the operator's read. */
  modelCalls: number;
  toolCalls: number;
  startedAt?: string;
};

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
  budget: RunBudget;
  usage: RunUsage;
  checkpoint: Record<string, unknown> | null;
  error: RunError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  metadata: Record<string, unknown>;
};

export type RunStepView = {
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

export type RunEventView = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

/** O que uma pessoa (ou o sistema) disse à tarefa, e quando isso chegou ao modelo. */
export type RunMessageView = {
  seq: number;
  author: "person" | "system";
  kind: string;
  text: string;
  source: string;
  deliveredAt: string | null;
  stepSeq: number | null;
  createdAt: string;
};

/**
 * Uma ação que esperou por uma pessoa.
 *
 * O que a superfície precisa mostrar é o que foi proposto e o que se espera que aconteça, não o
 * hash: ele existe para prender o sim à ação exata, e quem lê a tela não decide por hash.
 */
export type RunApprovalView = {
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

export type CreateRunInput = {
  botId: string;
  userId: string | null;
  threadId?: string | null;
  origin: RunOrigin;
  provider?: string;
  model?: string;
  objective: string;
  /** The message at the origin, when there is one. */
  sourceMessageId?: string | null;
  /** Unique when present: the same key returns the run that already exists. */
  idempotencyKey?: string | null;
  budget?: Partial<RunBudget>;
  metadata?: Record<string, unknown>;
};

/** What a worker is asked to execute. The executor is injected; this module never calls a model. */
export type RunExecutionRequest = {
  runId: string;
  owner: string;
  generation: number;
  signal: AbortSignal;
};
