/**
 * O que uma pessoa diz a uma tarefa, e o que uma decisão dela faz com ela.
 *
 * A regra que se fixa aqui é a da retomada: uma tarefa que parou pedindo gente volta a andar com a
 * resposta; uma que espera aprovação não volta por uma frase — o sim é uma decisão sobre uma ação, e
 * uma mensagem no meio dela não é esse sim.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createAgentRunRepository } from "../src/agent-runs/repository";
import { AgentRunError, createAgentRunService } from "../src/agent-runs/service";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agentRuns } from "../src/db/schema";
import { actionHashOf } from "../src/agent-runtime/loop";
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

async function newRun(status?: "waiting_human" | "waiting_approval" | "paused") {
  const { run } = await service.createRun(
    { id: "message-user" },
    {
      botId: `bot-${crypto.randomUUID().slice(0, 8)}`,
      userId: "message-user",
      origin: "web",
      objective: "Preencher o formulário.",
    },
    "message-user",
  );
  created.push(run.id);
  if (status) {
    const moved = await repository.updateStatus(run.id, ["queued"], status);
    if (!moved) throw new Error(`A tarefa não chegou a ${status}.`);
    return moved;
  }
  return run;
}

afterAll(async () => {
  if (created.length) {
    await database.delete(agentRuns).where(inArray(agentRuns.id, created));
  }
});

describe("mensagens de uma pessoa", () => {
  test("uma resposta solta uma tarefa que parou pedindo gente", async () => {
    const run = await newRun("waiting_human");
    const { run: after, message } = await service.appendMessage(
      run.id,
      { id: "message-user" },
      { text: " O código é 4821. ", source: "telegram" },
    );
    expect(after.status).toBe("queued");
    expect(message.text).toBe("O código é 4821.");
    expect(message.author).toBe("person");

    const events = await service.events(run.id, 0);
    const types = events.map((event) => event.type);
    expect(types).toContain("run.message");
    expect(types).toContain("run.status_changed");

    const views = await service.messages(run.id);
    expect(views[0]?.source).toBe("telegram");
    expect(views[0]?.deliveredAt).toBeNull();
  });

  test("uma frase durante uma aprovação não é o sim", async () => {
    const run = await newRun("waiting_approval");
    const { run: after } = await service.appendMessage(
      run.id,
      { id: "message-user" },
      { text: "Calma, ainda estou conferindo.", source: "web" },
    );
    expect(after.status).toBe("waiting_approval");
  });

  test("uma mensagem vazia é recusada", async () => {
    const run = await newRun();
    expect(
      service.appendMessage(
        run.id,
        { id: "message-user" },
        { text: "   ", source: "web" },
      ),
    ).rejects.toThrow(AgentRunError);
  });

  test("cada mensagem é entregue uma vez", async () => {
    const run = await newRun();
    await service.appendMessage(
      run.id,
      { id: "message-user" },
      { text: "Primeira.", source: "web" },
    );
    await service.appendMessage(
      run.id,
      { id: "message-user" },
      { text: "Segunda.", source: "web" },
    );

    const pending = await repository.undeliveredMessages(run.id, 10);
    expect(pending.map((row) => row.text)).toEqual(["Primeira.", "Segunda."]);
    expect(pending.map((row) => row.seq)).toEqual([1, 2]);

    const delivered = await repository.markMessagesDelivered(
      run.id,
      pending.map((row) => row.id),
      4,
    );
    expect(delivered).toBe(2);
    expect(await repository.undeliveredMessages(run.id, 10)).toEqual([]);

    // A marcação não é refeita por um segundo passo.
    expect(
      await repository.markMessagesDelivered(
        run.id,
        pending.map((row) => row.id),
        5,
      ),
    ).toBe(0);
    const after = await service.messages(run.id);
    expect(after[0]?.stepSeq).toBe(4);
  });
});

describe("decisões de aprovação", () => {
  async function approvalRun() {
    const run = await newRun("waiting_approval");
    const call = { name: "click", arguments: { ref: "e9", snapshotId: 1 } };
    const approval = await repository.insertApproval({
      runId: run.id,
      stepId: null,
      actorUserId: run.userId,
      actionHash: actionHashOf(call),
      action: call,
      destination: "https://loja.test/produtos/novo",
      expectedEffect: "Publicar o produto na loja.",
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { run, approval };
  }

  test("aprovar solta a tarefa e escreve o motivo na conversa", async () => {
    const { run, approval } = await approvalRun();
    const decided = await service.decideApproval(
      run.id,
      approval.id,
      { id: "message-user" },
      "approved",
    );
    expect(decided.approval.status).toBe("approved");
    expect(decided.run.status).toBe("queued");

    const views = await service.approvals(run.id);
    expect(views[0]?.status).toBe("approved");
    expect(views[0]?.actionName).toBe("click");
    expect(views[0]?.expectedEffect).toBe("Publicar o produto na loja.");
    expect(views[0]?.decidedBy).toBe("message-user");
  });

  test("uma decisão não é tomada duas vezes", async () => {
    const { run, approval } = await approvalRun();
    await service.decideApproval(
      run.id,
      approval.id,
      { id: "message-user" },
      "denied",
      "Produto errado.",
    );
    expect(
      service.decideApproval(
        run.id,
        approval.id,
        { id: "message-user" },
        "approved",
      ),
    ).rejects.toThrow(AgentRunError);
  });

  test("uma aprovação de outra tarefa não é decidida por engano", async () => {
    const mine = await approvalRun();
    const other = await newRun("waiting_approval");
    expect(
      service.decideApproval(
        other.id,
        mine.approval.id,
        { id: "message-user" },
        "approved",
      ),
    ).rejects.toThrow(AgentRunError);
  });
});
