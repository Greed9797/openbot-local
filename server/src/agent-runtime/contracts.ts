/**
 * What a model provider is, and what it gets.
 *
 * The browser never sees these types; the runtime does. They exist so a new model family is an
 * adapter and not a change to any tool: the provider receives a structured observation and a
 * catalog, and answers with a tool call or a final message. Everything else — policy, audit,
 * navigation, screenshots — is the same code for every provider.
 */
import type { ActionActor } from "../computer/gateway";
import type { SnapshotElement } from "../computer/schema";
import type { RunBudget, RunUsage } from "../agent-runs/types";

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
  refused?: { rule: string | null; reason: string };
  stale?: boolean;
  /** The action ran but its external effect is unknown — a submit that timed out. */
  uncertain?: boolean;
  /** The tool asked for a person. */
  help?: { reason: string };
  error?: { code: string; message: string };
};

export type ToolCallContext = {
  runId: string;
  /** O computador em que a ferramenta age. Vem do run, nunca do modelo. */
  botId: string;
  stepSeq: number;
  actor: ActionActor;
  signal: AbortSignal;
};

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
  objective: string;
  /** Present unless the provider is expected to act blind on its first step. */
  observation: AgentObservation | null;
  /** Older steps, oldest first. */
  history: AgentStepSummary[];
  tools: ToolDefinition[];
  budget: RunBudget;
  usage: RunUsage;
  /** A person approved something and the run is resuming: the model should know why. */
  resumeNote?: string;
  /** The provider's own capabilities, repeated here so an adapter can refuse without a lookup. */
  capabilities: ModelCapabilities;
};

export type AgentRunContext = {
  signal: AbortSignal;
  /** Streaming text out, for the surfaces that show progress. */
  onDelta?: (text: string) => void;
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
  | { kind: "tool_call"; call: ToolCall; text?: string }
  | { kind: "final"; message: string; evidence?: Record<string, unknown> }
  | { kind: "help"; reason: string }
  | { kind: "invalid"; raw: string; error: string }
  | { kind: "delegated"; message: string; toolCalls: number; evidence?: Record<string, unknown> };

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
   * `approved` means the gate already holds a consumed-once yes for exactly this action.
   */
  review(
    call: { name: string; arguments: Record<string, unknown> },
    observation: AgentObservation,
  ): Promise<
    | { decision: "run" }
    | { decision: "approved"; approvalId: string }
    | { decision: "requested"; approvalId: string }
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
};
