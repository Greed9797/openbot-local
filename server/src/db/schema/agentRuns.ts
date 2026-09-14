/**
 * Durable agent tasks.
 *
 * A conversation is not execution state. A task outlives the tab that started it, the API process
 * that accepted it and the model call that stalled, so it lives here: one row for the run, one row
 * per step, one row per event a surface may read, one row per artifact it produced. The worker asks
 * this table for work; nothing about a run is only in memory.
 *
 * The tables below are additive. They reference `agents`/`users` by id and never by foreign key,
 * for the same reason `audit_events` does: a run has to survive the deletion of whoever asked for
 * it, and a cascade against an append-only record is a question nobody wants the database deciding.
 */
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Where a run is. One vocabulary for the API, the worker and the channels.
 *
 * `waiting_model` and `executing` are separate on purpose: "the model is thinking" and "we are
 * touching the browser" fail differently and are recovered differently. `needs_reconciliation` is
 * the state for an action whose external effect is unknown — a submit that timed out — where the
 * one thing nobody may do is try it again.
 */
export const agentRunStatus = pgEnum("agent_run_status", [
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
]);

/** Who asked. Telegram and the web must be distinguishable in the trail and in dedupe. */
export const agentRunOrigin = pgEnum("agent_run_origin", [
  "web",
  "telegram",
  "api",
  // A run the deployment enqueued for itself, from a sector routine. Its own origin so the trail
  // can tell scheduled work from something a person or an integration asked for.
  "schedule",
]);

export const agentRunStepKind = pgEnum("agent_run_step_kind", [
  "observation",
  "decision",
  "action",
  "execution",
  "note",
  "delegated",
]);

/** How safe an artifact is to hand to a destination. */
export const artifactClassification = pgEnum("artifact_classification", [
  "public",
  "internal",
  "sensitive",
  "secret",
]);

/** What was done to an artifact before it was stored or shared. */
export const artifactProtection = pgEnum("artifact_protection", [
  "none",
  "masked",
  "blocked",
]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
]);

export const notificationChannel = pgEnum("notification_channel", [
  "telegram",
  "web",
]);

/**
 * Quem escreveu numa tarefa.
 *
 * `person` é uma pessoa — no painel ou no Telegram. `system` é o próprio runtime dizendo o que
 * decidiu (uma aprovação negada, uma retomada). O modelo lê as duas, e nenhuma delas é confundida
 * com o que ele mesmo disse: o texto do modelo não é guardado aqui, o passo dele é.
 */
export const runMessageAuthor = pgEnum("run_message_author", [
  "person",
  "system",
]);

/**
 * One task, from receipt to result.
 *
 * `idempotencyKey` is unique when present: a retried Telegram update or a retried API call carries
 * the same key and gets the same run back instead of a second browser doing the same thing twice.
 *
 * The lease is what makes a second worker refuse to touch a run somebody else owns. `generation` is
 * monotonic, so a worker that lost its lease and woke up late is refused by generation even if it
 * still believes it acts for this run.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: text("bot_id").notNull(),
    /** Who asked. No foreign key; see the file header. Null for a run with no human behind it. */
    userId: text("user_id"),
    threadId: text("thread_id"),
    origin: agentRunOrigin("origin").notNull().default("web"),
    /** The message id at the origin, for dedupe and for pointing back at what asked. */
    sourceMessageId: text("source_message_id"),
    idempotencyKey: text("idempotency_key"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    objective: text("objective").notNull(),
    status: agentRunStatus("status").notNull().default("queued"),
    currentStep: integer("current_step").notNull().default(0),
    /** Limits this run was admitted with: steps, milliseconds, retries. */
    budget: jsonb("budget").notNull(),
    /** What it consumed, for the budget check and the operator's read. */
    usage: jsonb("usage").notNull(),
    leaseOwner: text("lease_owner"),
    leaseGeneration: bigint("lease_generation", { mode: "number" })
      .notNull()
      .default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /** Last confirmed position, so a recovery knows where the run really was. */
    checkpoint: jsonb("checkpoint"),
    /** Typed failure: a code the UI and the channels agree on, plus a readable message. */
    error: jsonb("error"),
    metadata: jsonb("metadata").notNull(),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("agent_runs_idempotency_key_idx").on(table.idempotencyKey),
    index("agent_runs_status_created_idx").on(table.status, table.createdAt),
    index("agent_runs_bot_created_idx").on(table.botId, table.createdAt),
    index("agent_runs_user_created_idx").on(table.userId, table.createdAt),
  ],
);

/**
 * One step of the loop: what was seen, what was decided, what policy said, what happened.
 *
 * Append-only, in sequence. The unique `(run_id, seq)` is what makes a retried write harmless: the
 * second one is refused by the database rather than producing a step that never happened twice.
 */
export const agentRunSteps = pgTable(
  "agent_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: agentRunStepKind("kind").notNull(),
    /** Free-form outcome of the step: started, ok, refused, failed, skipped. */
    status: text("status").notNull(),
    observation: jsonb("observation"),
    modelDecision: jsonb("model_decision"),
    proposedAction: jsonb("proposed_action"),
    policyDecision: jsonb("policy_decision"),
    executionResult: jsonb("execution_result"),
    artifactId: uuid("artifact_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_run_steps_run_seq_idx").on(table.runId, table.seq),
    index("agent_run_steps_run_idx").on(table.runId),
  ],
);

/**
 * The run's own event log, for surfaces that watch it.
 *
 * Separate from `audit_events`, which answers "who did what under which rule" for an investigator.
 * This answers "what happened in this task" for the person watching it, and it is what a reconnecting
 * browser or Telegram notification reads instead of a stream that only exists while somebody looks.
 */
export const agentRunEvents = pgTable(
  "agent_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_run_events_run_seq_idx").on(table.runId, table.seq),
    index("agent_run_events_run_idx").on(table.runId),
  ],
);

/**
 * An image, a file or an extract the run produced.
 *
 * The bytes go to private storage; this row carries the metadata, the hash, how it was protected and
 * how long it may be kept. `allowedDestinations` is the disclosure decision: an artifact that may be
 * shown to the operator in the panel is not automatically one that may be sent to Telegram or to a
 * model, and keeping that answer on the row is what stops the two from being conflated.
 */
export const runArtifacts = pgTable(
  "run_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepId: uuid("step_id"),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    width: integer("width"),
    height: integer("height"),
    hash: text("hash").notNull(),
    bytes: integer("bytes").notNull(),
    storagePath: text("storage_path").notNull(),
    classification: artifactClassification("classification")
      .notNull()
      .default("internal"),
    protection: artifactProtection("protection").notNull().default("none"),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    allowedDestinations: text("allowed_destinations").array().notNull(),
    metadata: jsonb("metadata").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("run_artifacts_run_idx").on(table.runId),
    index("run_artifacts_retention_idx").on(table.retentionUntil),
  ],
);

/**
 * O que uma pessoa disse a uma tarefa em andamento, e o que o sistema respondeu.
 *
 * Sem isto, uma tarefa que para em `waiting_human` só pode ser retomada do zero: o modelo não tem
 * onde ler a resposta que a pessoa deu. `deliveredAt` é o que impede que a mesma instrução seja
 * entregue duas vezes quando o worker reinicia no meio — a mensagem é marcada como entregue no passo
 * que a levou ao modelo, e o passo é quem guarda o que foi feito com ela.
 */
export const agentRunMessages = pgTable(
  "agent_run_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** Posição na conversa da tarefa, começando em 1. */
    seq: integer("seq").notNull(),
    author: runMessageAuthor("author").notNull(),
    /** `instruction`, `answer`, `approval_denied`, `note` — o que o texto é, não o que ele diz. */
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    /** De onde veio: `web`, `telegram`, `api`, `runner`. */
    source: text("source").notNull(),
    actorUserId: text("actor_user_id"),
    /** O passo em que ela foi levada ao modelo, quando já foi. */
    stepSeq: integer("step_seq"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("agent_run_messages_run_seq_idx").on(table.runId, table.seq),
    index("agent_run_messages_pending_idx").on(
      table.runId,
      table.deliveredAt,
    ),
  ],
);

/**
 * Who owns a browser profile, and until when.
 *
 * One row per profile is one owner per profile: the primary key is the whole lock. A second run for
 * the same Bot waits here rather than typing into a browser somebody else is driving. `generation`
 * is monotonic per acquisition, and an operation that presents a stale generation is refused, which
 * is how an old worker that lost the lease is stopped even after it wakes up. Releasing expires the
 * row instead of deleting it, so the generation stays monotonic across owners.
 */
export const browserProfileLeases = pgTable(
  "browser_profile_leases",
  {
    profileId: text("profile_id").primaryKey(),
    runId: uuid("run_id"),
    owner: text("owner").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("browser_profile_leases_run_idx").on(table.runId)],
);

/**
 * Permission to do one sensitive thing, once.
 *
 * `actionHash` covers the action and the data it would submit, so an approval for "send this form"
 * is refused when the form changed after the approval was written. Single use: `consumedAt` is set
 * when the action runs, and an expired or already-consumed row authorizes nothing.
 */
export const runApprovals = pgTable(
  "run_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepId: uuid("step_id"),
    actorUserId: text("actor_user_id"),
    actionHash: text("action_hash").notNull(),
    action: jsonb("action").notNull(),
    destination: text("destination"),
    expectedEffect: text("expected_effect"),
    status: approvalStatus("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("run_approvals_run_status_idx").on(table.runId, table.status),
  ],
);

/**
 * A model this deployment may run, and what it was actually verified to do.
 *
 * `capabilities` is verified, not declared: a provider without vision is not given a task that
 * requires vision. The credential is a reference into the existing vault, never a value.
 */
export const modelConfigurations = pgTable(
  "model_configurations",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    transport: text("transport").notNull(),
    modelId: text("model_id").notNull(),
    baseUrl: text("base_url"),
    credentialId: uuid("credential_id"),
    capabilities: jsonb("capabilities").notNull(),
    limits: jsonb("limits"),
    enabled: boolean("enabled").notNull().default(true),
    testedAt: timestamp("tested_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("model_configurations_provider_idx").on(table.provider)],
);

/**
 * A Telegram chat authorized to act as a person in this deployment.
 *
 * The numeric ids are stored as text: a JSON number would lose the low digits of a large chat id,
 * and the platform's ids are the only handle there is. A username is not an authorization and never
 * appears here as one.
 */
export const telegramBindings = pgTable(
  "telegram_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramUserId: text("telegram_user_id").notNull(),
    chatId: text("chat_id").notNull(),
    userId: text("user_id").notNull(),
    botId: text("bot_id").notNull(),
    permissions: jsonb("permissions").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("telegram_bindings_user_chat_idx").on(
      table.telegramUserId,
      table.chatId,
    ),
    index("telegram_bindings_user_idx").on(table.userId),
  ],
);

/** A one-time code that turns one private chat into one binding, and then is spent. */
export const telegramPairingCodes = pgTable("telegram_pairing_codes", {
  code: text("code").primaryKey(),
  userId: text("user_id").notNull(),
  botId: text("bot_id"),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

/**
 * Every update the platform handed us, recorded before it is acted on.
 *
 * The platform redelivers. Recording the update and its id first means the second delivery finds the
 * row and stops, instead of creating a second task for the same sentence.
 */
export const telegramInbox = pgTable(
  "telegram_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramBotId: text("telegram_bot_id").notNull(),
    updateId: bigint("update_id", { mode: "number" }).notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("telegram_inbox_bot_update_idx").on(
      table.telegramBotId,
      table.updateId,
    ),
    index("telegram_inbox_pending_idx").on(table.processedAt),
  ],
);

/**
 * Notifications waiting to be delivered, separate from the run that caused them.
 *
 * A Telegram outage is not a task failure. The run writes what it wants to say, a delivery loop
 * retries on its own clock, and `dedupeKey` keeps a retry from sending the same message twice.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id"),
    channel: notificationChannel("channel").notNull(),
    destination: jsonb("destination").notNull(),
    eventType: text("event_type").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("notification_outbox_channel_dedupe_idx").on(
      table.channel,
      table.dedupeKey,
    ),
    index("notification_outbox_delivery_idx").on(
      table.deliveredAt,
      table.nextAttemptAt,
    ),
  ],
);
