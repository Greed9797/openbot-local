/**
 * O portão de aprovação, sobre o banco de verdade.
 *
 * O que se fixa aqui é o vínculo entre o sim e a ação: uma aprovação vale para a ação exata que a
 * pediu, uma vez, e por um tempo. Sem isso, "aprovei publicar este produto" vira "aprovei o que vier
 * depois", que é o erro que esta camada existe para tornar impossível.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createApprovalGate } from "../src/agent-runs/approvals";
import { createAgentRunRepository } from "../src/agent-runs/repository";
import { createAgentRunService } from "../src/agent-runs/service";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agentRuns } from "../src/db/schema";
import { actionHashOf } from "../src/agent-runtime/loop";
import type { AgentObservation } from "../src/agent-runtime/contracts";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  TEST_POOL,
);
const repository = createAgentRunRepository(database);
const service = createAgentRunService({
  repository,
  auditStore: createAuditStore(database),
  defaults: {
    provider: "scripted",
    model: "scripted-1",
    budget: { maxSteps: 5, maxMs: 30_000, maxCorrections: 0 },
    leaseTtlMs: 30_000,
  },
});

const created: string[] = [];

async function newRun() {
  const { run } = await service.createRun(
    { id: "approval-user" },
    {
      botId: `bot-${crypto.randomUUID().slice(0, 8)}`,
      userId: "approval-user",
      origin: "web",
      objective: "Publicar o produto.",
    },
    "approval-user",
  );
  created.push(run.id);
  return run;
}

afterAll(async () => {
  if (created.length) {
    await database.delete(agentRuns).where(inArray(agentRuns.id, created));
  }
});

const observation: AgentObservation = {
  observationId: "obs-1",
  runId: "the-run",
  url: "https://loja.test/produtos/novo",
  title: "Novo produto",
  text: "",
  truncated: false,
  elements: [
    { ref: "e9", role: "button", name: "Publicar produto" },
    { ref: "e1", role: "textbox", name: "Nome" },
  ],
  snapshotId: 1,
  viewport: { width: 1280, height: 800 },
  capturedAt: "2026-09-11T10:00:00.000Z",
  control: { holder: "bot", secretPending: false },
  images: [],
  textOnly: false,
};

const publish = {
  name: "click",
  arguments: { ref: "e9", snapshotId: 1 },
};

describe("o portão de aprovação", () => {
  test("uma ação comum passa direto", async () => {
    const run = await newRun();
    const gate = createApprovalGate({ repository, ttlMs: 60_000 });
    const verdict = await gate.review(
      { name: "click", arguments: { ref: "e1", snapshotId: 1 } },
      observation,
      { runId: run.id, stepSeq: 1, actorUserId: run.userId },
    );
    expect(verdict.decision).toBe("run");
  });

  test("a mesma ação perguntou uma vez só, e o sim vale para ela", async () => {
    const run = await newRun();
    const gate = createApprovalGate({ repository, ttlMs: 60_000 });
    const request = { runId: run.id, stepSeq: 1, actorUserId: run.userId };

    const first = await gate.review(publish, observation, request);
    expect(first.decision).toBe("requested");

    // Retomada sem decisão: a pergunta continua de pé, e não vira uma segunda.
    const again = await gate.review(publish, observation, request);
    expect(again.decision).toBe("requested");
    if (first.decision !== "requested" || again.decision !== "requested") return;
    expect(again.approvalId).toBe(first.approvalId);

    const decided = await service.decideApproval(
      run.id,
      first.approvalId,
      { id: "approval-user" },
      "approved",
    );
    expect(decided.approval.status).toBe("approved");

    const afterYes = await gate.review(publish, observation, request);
    expect(afterYes.decision).toBe("approved");
    if (afterYes.decision !== "approved") return;
    expect(afterYes.approvalId).toBe(first.approvalId);

    // O sim é gasto uma vez, na ação exata.
    const hash = actionHashOf(publish);
    expect(await gate.consume(first.approvalId, hash)).toBe(true);
    expect(await gate.consume(first.approvalId, hash)).toBe(false);
    const other = await gate.consume(first.approvalId, actionHashOf({
      name: "click",
      arguments: { ref: "e1", snapshotId: 1 },
    }));
    expect(other).toBe(false);

    // E depois de gasto, a mesma ação pergunta de novo.
    const secondTime = await gate.review(publish, observation, request);
    expect(secondTime.decision).toBe("requested");
    if (secondTime.decision !== "requested") return;
    expect(secondTime.approvalId).not.toBe(first.approvalId);
  });

  test("um não chega ao modelo como informação, e não como nova pergunta", async () => {
    const run = await newRun();
    const gate = createApprovalGate({ repository, ttlMs: 60_000 });
    const request = { runId: run.id, stepSeq: 1, actorUserId: run.userId };
    const first = await gate.review(publish, observation, request);
    if (first.decision !== "requested") throw new Error("esperava um pedido");

    await service.decideApproval(
      run.id,
      first.approvalId,
      { id: "approval-user" },
      "denied",
      "Não é este produto.",
    );

    const afterNo = await gate.review(publish, observation, request);
    expect(afterNo.decision).toBe("denied");
    if (afterNo.decision !== "denied") return;
    expect(afterNo.reason).toContain("publicar");
    expect(afterNo.approvalId).toBe(first.approvalId);

    // E a recusa ficou escrita na conversa da tarefa, com a nota da pessoa.
    const messages = await service.messages(run.id);
    expect(messages.some((m) => m.kind === "approval_denied" && m.text.includes("Não é este produto."))).toBe(
      true,
    );
  });

  test("uma aprovação vencida não autoriza nada, e a pergunta seguinte é nova", async () => {
    const run = await newRun();
    // O relógio do portão é injetado: o vencimento é uma conta, não uma espera.
    let clock = Date.now();
    const gate = createApprovalGate({
      repository,
      ttlMs: 1_000,
      now: () => clock,
    });
    const request = { runId: run.id, stepSeq: 1, actorUserId: run.userId };
    const first = await gate.review(publish, observation, request);
    if (first.decision !== "requested") throw new Error("esperava um pedido");

    clock += 60_000;
    expect(await repository.expireApprovals(new Date(clock))).toBeGreaterThan(0);

    const afterExpiry = await gate.review(publish, observation, request);
    expect(afterExpiry.decision).toBe("requested");
    if (afterExpiry.decision !== "requested") return;
    expect(afterExpiry.approvalId).not.toBe(first.approvalId);
  });

  test("o deployment pode marcar os próprios termos como sensíveis", async () => {
    const run = await newRun();
    const gate = createApprovalGate({
      repository,
      ttlMs: 60_000,
      extraPatterns: ["fechar competência"],
    });
    const verdict = await gate.review(
      { name: "click", arguments: { ref: "e9", snapshotId: 1 } },
      {
        ...observation,
        elements: [{ ref: "e9", role: "button", name: "Fechar competência" }],
      },
      { runId: run.id, stepSeq: 1, actorUserId: run.userId },
    );
    expect(verdict.decision).toBe("requested");

    const rows = await service.approvals(run.id);
    expect(rows[0]?.actionName).toBe("click");
    expect(rows[0]?.expectedEffect).toContain("Executar click");
  });
});
