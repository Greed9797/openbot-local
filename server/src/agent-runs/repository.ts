/**
 * Every read and write a durable task needs, in one place.
 *
 * The service decides; this file only moves rows. The two rules that live here because only SQL can
 * enforce them: a claim is conditional (so two workers cannot both win the same run) and a lease
 * update carries its generation (so an old worker cannot act after losing its lease).
 */
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentRunEvents,
  agentRunSteps,
  agentRuns,
  browserProfileLeases,
  runApprovals,
  runArtifacts,
} from "../db/schema";
import type { RunError, RunStatus, RunUsage } from "./types";

export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentRunStepRow = typeof agentRunSteps.$inferSelect;
export type AgentRunEventRow = typeof agentRunEvents.$inferSelect;
export type RunArtifactRow = typeof runArtifacts.$inferSelect;
export type RunApprovalRow = typeof runApprovals.$inferSelect;
export type ProfileLeaseRow = typeof browserProfileLeases.$inferSelect;

export type NewRunRow = {
  botId: string;
  userId: string | null;
  threadId: string | null;
  origin: "web" | "telegram" | "api";
  sourceMessageId: string | null;
  idempotencyKey: string | null;
  provider: string;
  model: string;
  objective: string;
  budget: Record<string, unknown>;
  usage: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status?: RunStatus;
};

export type RunPatch = Partial<{
  status: RunStatus;
  currentStep: number;
  checkpoint: Record<string, unknown> | null;
  error: RunError | null;
  usage: RunUsage;
  metadata: Record<string, unknown>;
  heartbeatAt: Date;
  finishedAt: Date | null;
  startedAt: Date | null;
}>;

export type NewStepInput = {
  runId: string;
  seq: number;
  kind: AgentRunStepRow["kind"];
  status: string;
  observation?: Record<string, unknown> | null;
  modelDecision?: Record<string, unknown> | null;
  proposedAction?: Record<string, unknown> | null;
  policyDecision?: Record<string, unknown> | null;
  executionResult?: Record<string, unknown> | null;
  artifactId?: string | null;
  startedAt: Date;
};

export type StepPatch = Partial<{
  status: string;
  modelDecision: Record<string, unknown> | null;
  proposedAction: Record<string, unknown> | null;
  executionResult: Record<string, unknown> | null;
  policyDecision: Record<string, unknown> | null;
  artifactId: string | null;
}>;

export type NewArtifactInput = {
  runId: string;
  stepId: string | null;
  kind: string;
  mime: string;
  width: number | null;
  height: number | null;
  hash: string;
  bytes: number;
  storagePath: string;
  classification: RunArtifactRow["classification"];
  protection: RunArtifactRow["protection"];
  retentionUntil: Date | null;
  allowedDestinations: string[];
  metadata: Record<string, unknown>;
};

export type AcquireProfileLeaseInput = {
  profileId: string;
  runId: string;
  owner: string;
  ttlMs: number;
};

export type RenewProfileLeaseInput = {
  profileId: string;
  owner: string;
  generation: number;
  ttlMs: number;
};

export type NewApprovalInput = {
  runId: string;
  stepId: string | null;
  actorUserId: string | null;
  actionHash: string;
  action: Record<string, unknown>;
  destination: string | null;
  expectedEffect: string | null;
  expiresAt: Date;
};

export interface AgentRunRepository {
  create(input: NewRunRow): Promise<{ run: AgentRunRow; created: boolean }>;
  byIdempotencyKey(key: string): Promise<AgentRunRow | undefined>;
  get(id: string): Promise<AgentRunRow | undefined>;
  list(filters: {
    botId?: string;
    userId?: string;
    status?: RunStatus[];
    limit: number;
  }): Promise<AgentRunRow[]>;
  claim(id: string, owner: string, ttlMs: number): Promise<AgentRunRow | undefined>;
  renewLease(
    id: string,
    owner: string,
    generation: number,
    ttlMs: number,
  ): Promise<boolean>;
  releaseLease(id: string, owner: string, generation: number): Promise<void>;
  updateOwned(
    id: string,
    owner: string,
    generation: number,
    patch: RunPatch,
  ): Promise<AgentRunRow | undefined>;
  updateStatus(
    id: string,
    expected: RunStatus[],
    next: RunStatus,
    patch?: RunPatch,
  ): Promise<AgentRunRow | undefined>;
  expiredLeases(now: Date): Promise<AgentRunRow[]>;
  queued(limit: number): Promise<AgentRunRow[]>;
  allocateStep(runId: string): Promise<number>;
  appendStep(input: NewStepInput): Promise<AgentRunStepRow>;
  finishStep(runId: string, seq: number, patch: StepPatch): Promise<void>;
  steps(runId: string): Promise<AgentRunStepRow[]>;
  appendEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<number>;
  events(runId: string, afterSeq: number): Promise<AgentRunEventRow[]>;
  insertArtifact(input: NewArtifactInput): Promise<RunArtifactRow>;
  artifact(id: string): Promise<RunArtifactRow | undefined>;
  artifacts(runId: string): Promise<RunArtifactRow[]>;
  expiredArtifacts(now: Date, limit: number): Promise<RunArtifactRow[]>;
  deleteArtifact(id: string): Promise<void>;
  acquireProfileLease(
    input: AcquireProfileLeaseInput,
  ): Promise<{ generation: number } | undefined>;
  renewProfileLease(input: RenewProfileLeaseInput): Promise<boolean>;
  releaseProfileLease(input: {
    profileId: string;
    owner: string;
    generation: number;
  }): Promise<void>;
  profileLease(profileId: string): Promise<ProfileLeaseRow | undefined>;
  insertApproval(input: NewApprovalInput): Promise<RunApprovalRow>;
  approval(id: string): Promise<RunApprovalRow | undefined>;
  pendingApprovals(runId: string): Promise<RunApprovalRow[]>;
  decideApproval(input: {
    id: string;
    decision: "approved" | "denied";
    decidedBy: string;
  }): Promise<RunApprovalRow | undefined>;
  consumeApproval(
    id: string,
    actionHash: string,
  ): Promise<RunApprovalRow | undefined>;
  expireApprovals(now: Date): Promise<number>;
}

export function createAgentRunRepository(
  database: Database,
): AgentRunRepository {
  /**
   * Insert, unless the same idempotency key already produced a run.
   *
   * `onConflictDoNothing` plus a read is the whole idempotency story: the second delivery of the
   * same Telegram message loses the insert and is handed the first run instead of creating another
   * browser. The unique index is on the key, so a null key never collides.
   */
  async function create(
    input: NewRunRow,
  ): Promise<{ run: AgentRunRow; created: boolean }> {
    const [inserted] = await database
      .insert(agentRuns)
      .values(input)
      .onConflictDoNothing({ target: agentRuns.idempotencyKey })
      .returning();
    if (inserted) return { run: inserted, created: true };
    const existing = input.idempotencyKey
      ? await byIdempotencyKey(input.idempotencyKey)
      : undefined;
    if (!existing) {
      throw new Error("The run could not be created and no stored run owns its key.");
    }
    return { run: existing, created: false };
  }

  async function byIdempotencyKey(key: string): Promise<AgentRunRow | undefined> {
    const [row] = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.idempotencyKey, key))
      .limit(1);
    return row;
  }

  async function get(id: string): Promise<AgentRunRow | undefined> {
    const [row] = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, id))
      .limit(1);
    return row;
  }

  async function list(filters: {
    botId?: string;
    userId?: string;
    status?: RunStatus[];
    limit: number;
  }): Promise<AgentRunRow[]> {
    const conditions = [
      ...(filters.botId ? [eq(agentRuns.botId, filters.botId)] : []),
      ...(filters.userId ? [eq(agentRuns.userId, filters.userId)] : []),
      ...(filters.status?.length
        ? [inArray(agentRuns.status, filters.status)]
        : []),
    ];
    return database
      .select()
      .from(agentRuns)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(agentRuns.createdAt))
      .limit(filters.limit);
  }

  /** The run this worker now owns, or undefined because somebody else got there first. */
  async function claim(
    id: string,
    owner: string,
    ttlMs: number,
  ): Promise<AgentRunRow | undefined> {
    const now = new Date();
    const [row] = await database
      .update(agentRuns)
      .set({
        status: "running",
        leaseOwner: owner,
        leaseGeneration: sql`${agentRuns.leaseGeneration} + 1`,
        leaseExpiresAt: new Date(now.getTime() + ttlMs),
        heartbeatAt: now,
        startedAt: sql`coalesce(${agentRuns.startedAt}, now())`,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, id),
          eq(agentRuns.status, "queued"),
          or(
            isNull(agentRuns.leaseExpiresAt),
            lt(agentRuns.leaseExpiresAt, now),
          ),
        ),
      )
      .returning();
    return row;
  }

  async function renewLease(
    id: string,
    owner: string,
    generation: number,
    ttlMs: number,
  ): Promise<boolean> {
    const now = new Date();
    const rows = await database
      .update(agentRuns)
      .set({
        leaseExpiresAt: new Date(now.getTime() + ttlMs),
        heartbeatAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, id),
          eq(agentRuns.leaseOwner, owner),
          eq(agentRuns.leaseGeneration, generation),
          sql`${agentRuns.leaseExpiresAt} > now()`,
        ),
      )
      .returning({ id: agentRuns.id });
    return rows.length > 0;
  }

  async function releaseLease(
    id: string,
    owner: string,
    generation: number,
  ): Promise<void> {
    await database
      .update(agentRuns)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentRuns.id, id),
          eq(agentRuns.leaseOwner, owner),
          eq(agentRuns.leaseGeneration, generation),
        ),
      );
  }

  /** A write the owner of record is allowed to make. Refused, quietly, for anybody else. */
  async function updateOwned(
    id: string,
    owner: string,
    generation: number,
    patch: RunPatch,
  ): Promise<AgentRunRow | undefined> {
    const [row] = await database
      .update(agentRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(agentRuns.id, id),
          eq(agentRuns.leaseOwner, owner),
          eq(agentRuns.leaseGeneration, generation),
        ),
      )
      .returning();
    return row;
  }

  /**
   * A control-plane write: pause, cancel, resume.
   *
   * Deliberately not lease-bound. Who owns the run is not who is allowed to stop it, and requiring
   * a lease here would make "cancel" fail exactly when the worker is wedged, which is when somebody
   * reaches for it.
   */
  async function updateStatus(
    id: string,
    expected: RunStatus[],
    next: RunStatus,
    patch: RunPatch = {},
  ): Promise<AgentRunRow | undefined> {
    const [row] = await database
      .update(agentRuns)
      .set({ ...patch, status: next, updatedAt: new Date() })
      .where(and(eq(agentRuns.id, id), inArray(agentRuns.status, expected)))
      .returning();
    return row;
  }

  /** Where a recovery finds work that stopped without saying so. */
  async function expiredLeases(now: Date): Promise<AgentRunRow[]> {
    return database
      .select()
      .from(agentRuns)
      .where(
        and(
          inArray(agentRuns.status, ["running", "waiting_model", "executing"]),
          lt(agentRuns.leaseExpiresAt, now),
        ),
      )
      .orderBy(asc(agentRuns.createdAt))
      .limit(50);
  }

  async function queued(limit: number): Promise<AgentRunRow[]> {
    return database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.status, "queued"))
      .orderBy(asc(agentRuns.createdAt))
      .limit(limit);
  }

  /**
   * Claim the next step number for a run.
   *
   * The counter lives on the run and is bumped in the same statement, so two writers cannot be
   * handed the same seq; the unique index underneath refuses it if they somehow are.
   */
  async function allocateStep(runId: string): Promise<number> {
    const [row] = await database
      .update(agentRuns)
      .set({
        currentStep: sql`${agentRuns.currentStep} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))
      .returning({ seq: agentRuns.currentStep });
    if (!row) throw new Error("The run disappeared while a step was being written.");
    return row.seq;
  }

  async function appendStep(input: NewStepInput): Promise<AgentRunStepRow> {
    const [row] = await database
      .insert(agentRunSteps)
      .values({
        runId: input.runId,
        seq: input.seq,
        kind: input.kind,
        status: input.status,
        observation: input.observation ?? null,
        modelDecision: input.modelDecision ?? null,
        proposedAction: input.proposedAction ?? null,
        policyDecision: input.policyDecision ?? null,
        executionResult: input.executionResult ?? null,
        artifactId: input.artifactId ?? null,
        startedAt: input.startedAt,
      })
      .returning();
    return row;
  }

  async function finishStep(
    runId: string,
    seq: number,
    patch: StepPatch,
  ): Promise<void> {
    await database
      .update(agentRunSteps)
      .set({ ...patch, finishedAt: new Date() })
      .where(and(eq(agentRunSteps.runId, runId), eq(agentRunSteps.seq, seq)));
  }

  async function steps(runId: string): Promise<AgentRunStepRow[]> {
    return database
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, runId))
      .orderBy(asc(agentRunSteps.seq));
  }

  /**
   * Append an event, numbering it inside a transaction.
   *
   * Surfaces read this instead of a live stream, so a gap or a duplicate here is a person seeing a
   * step that did not happen, or missing one that did. The transaction makes max-plus-one safe.
   */
  async function appendEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    return database.transaction(async (tx) => {
      const [last] = await tx
        .select({ seq: sql<number>`coalesce(max(${agentRunEvents.seq}), 0)` })
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, runId));
      const seq = Number(last?.seq ?? 0) + 1;
      await tx.insert(agentRunEvents).values({ runId, seq, type, payload });
      return seq;
    });
  }

  async function events(
    runId: string,
    afterSeq: number,
  ): Promise<AgentRunEventRow[]> {
    return database
      .select()
      .from(agentRunEvents)
      .where(
        and(
          eq(agentRunEvents.runId, runId),
          sql`${agentRunEvents.seq} > ${afterSeq}`,
        ),
      )
      .orderBy(asc(agentRunEvents.seq));
  }

  async function insertArtifact(
    input: NewArtifactInput,
  ): Promise<RunArtifactRow> {
    const [row] = await database.insert(runArtifacts).values(input).returning();
    return row;
  }

  async function artifact(id: string): Promise<RunArtifactRow | undefined> {
    const [row] = await database
      .select()
      .from(runArtifacts)
      .where(eq(runArtifacts.id, id))
      .limit(1);
    return row;
  }

  async function artifacts(runId: string): Promise<RunArtifactRow[]> {
    return database
      .select()
      .from(runArtifacts)
      .where(eq(runArtifacts.runId, runId))
      .orderBy(asc(runArtifacts.createdAt));
  }

  /**
   * Artefatos que passaram do prazo de retenção, mais antigos primeiro.
   *
   * Com limite porque uma implantação parada por semanas volta com uma pilha de imagens vencidas: sem
   * ele, o primeiro tick depois da parada carregaria todas na memória para apagar uma por uma.
   */
  async function expiredArtifacts(
    now: Date,
    limit: number,
  ): Promise<RunArtifactRow[]> {
    return database
      .select()
      .from(runArtifacts)
      .where(lt(runArtifacts.retentionUntil, now))
      .orderBy(asc(runArtifacts.retentionUntil))
      .limit(limit);
  }

  async function deleteArtifact(id: string): Promise<void> {
    await database.delete(runArtifacts).where(eq(runArtifacts.id, id));
  }

  /**
   * Take the profile lock, or fail because somebody holds it.
   *
   * The upsert's `WHERE` is the lock: it may take a row that is free or expired, or one this same
   * run already holds, and nothing else. A caller that cannot take it gets `undefined` and waits.
   */
  async function acquireProfileLease(
    input: AcquireProfileLeaseInput,
  ): Promise<{ generation: number } | undefined> {
    const now = new Date();
    const [row] = await database
      .insert(browserProfileLeases)
      .values({
        profileId: input.profileId,
        runId: input.runId,
        owner: input.owner,
        generation: 1,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + input.ttlMs),
      })
      .onConflictDoUpdate({
        target: browserProfileLeases.profileId,
        set: {
          runId: input.runId,
          owner: input.owner,
          generation: sql`${browserProfileLeases.generation} + 1`,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt: new Date(now.getTime() + input.ttlMs),
        },
        setWhere: or(
          lt(browserProfileLeases.expiresAt, now),
          eq(browserProfileLeases.runId, input.runId),
        ),
      })
      .returning({ generation: browserProfileLeases.generation });
    return row ? { generation: Number(row.generation) } : undefined;
  }

  async function renewProfileLease(
    input: RenewProfileLeaseInput,
  ): Promise<boolean> {
    const now = new Date();
    const rows = await database
      .update(browserProfileLeases)
      .set({
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + input.ttlMs),
      })
      .where(
        and(
          eq(browserProfileLeases.profileId, input.profileId),
          eq(browserProfileLeases.owner, input.owner),
          eq(browserProfileLeases.generation, input.generation),
          sql`${browserProfileLeases.expiresAt} > now()`,
        ),
      )
      .returning({ profileId: browserProfileLeases.profileId });
    return rows.length > 0;
  }

  /**
   * Give up the profile, without forgetting that it was held.
   *
   * The row is expired rather than deleted, so the generation keeps counting across owners. A
   * deleted row would restart at one, and generation one then means both "the newest owner" and
   * "the first one ever" — which is exactly the confusion the generation exists to prevent.
   */
  async function releaseProfileLease(input: {
    profileId: string;
    owner: string;
    generation: number;
  }): Promise<void> {
    const now = new Date();
    await database
      .update(browserProfileLeases)
      .set({ expiresAt: now, heartbeatAt: now })
      .where(
        and(
          eq(browserProfileLeases.profileId, input.profileId),
          eq(browserProfileLeases.owner, input.owner),
          eq(browserProfileLeases.generation, input.generation),
        ),
      );
  }

  async function profileLease(
    profileId: string,
  ): Promise<ProfileLeaseRow | undefined> {
    const [row] = await database
      .select()
      .from(browserProfileLeases)
      .where(eq(browserProfileLeases.profileId, profileId))
      .limit(1);
    return row;
  }

  async function insertApproval(
    input: NewApprovalInput,
  ): Promise<RunApprovalRow> {
    const [row] = await database.insert(runApprovals).values(input).returning();
    return row;
  }

  async function approval(id: string): Promise<RunApprovalRow | undefined> {
    const [row] = await database
      .select()
      .from(runApprovals)
      .where(eq(runApprovals.id, id))
      .limit(1);
    return row;
  }

  async function pendingApprovals(runId: string): Promise<RunApprovalRow[]> {
    return database
      .select()
      .from(runApprovals)
      .where(
        and(eq(runApprovals.runId, runId), eq(runApprovals.status, "pending")),
      )
      .orderBy(asc(runApprovals.createdAt));
  }

  /** Approve or deny, once. A row that was already decided is not decided again. */
  async function decideApproval(input: {
    id: string;
    decision: "approved" | "denied";
    decidedBy: string;
  }): Promise<RunApprovalRow | undefined> {
    const [row] = await database
      .update(runApprovals)
      .set({
        status: input.decision,
        decidedBy: input.decidedBy,
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(runApprovals.id, input.id),
          eq(runApprovals.status, "pending"),
          sql`${runApprovals.expiresAt} > now()`,
        ),
      )
      .returning();
    return row;
  }

  /** Spend an approval on exactly the action it was written for. */
  async function consumeApproval(
    id: string,
    actionHash: string,
  ): Promise<RunApprovalRow | undefined> {
    const [row] = await database
      .update(runApprovals)
      .set({ status: "consumed", consumedAt: new Date() })
      .where(
        and(
          eq(runApprovals.id, id),
          eq(runApprovals.status, "approved"),
          eq(runApprovals.actionHash, actionHash),
          sql`${runApprovals.expiresAt} > now()`,
        ),
      )
      .returning();
    return row;
  }

  async function expireApprovals(now: Date): Promise<number> {
    const rows = await database
      .update(runApprovals)
      .set({ status: "expired" })
      .where(
        and(
          eq(runApprovals.status, "pending"),
          lt(runApprovals.expiresAt, now),
        ),
      )
      .returning({ id: runApprovals.id });
    return rows.length;
  }

  return {
    create,
    byIdempotencyKey,
    get,
    list,
    claim,
    renewLease,
    releaseLease,
    updateOwned,
    updateStatus,
    expiredLeases,
    queued,
    allocateStep,
    appendStep,
    finishStep,
    steps,
    appendEvent,
    events,
    insertArtifact,
    artifact,
    artifacts,
    expiredArtifacts,
    deleteArtifact,
    acquireProfileLease,
    renewProfileLease,
    releaseProfileLease,
    profileLease,
    insertApproval,
    approval,
    pendingApprovals,
    decideApproval,
    consumeApproval,
    expireApprovals,
  };
}
