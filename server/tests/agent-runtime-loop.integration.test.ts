/**
 * The agent loop, over the real durable store.
 *
 * The provider, the observation and the tool catalog are fakes on purpose — the loop's contract is
 * with those three interfaces, and every refusal path here is a path a real provider can reach. The
 * database, the steps, the events and the leases are real.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createAgentRunRepository } from "../src/agent-runs/repository";
import { createAgentRunService } from "../src/agent-runs/service";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agentRuns, browserProfileLeases } from "../src/db/schema";
import type {
  AgentModelProvider,
  AgentObservation,
  AgentRunInput,
  AgentRunResult,
  ObservationSource,
  ToolCall,
  ToolCatalog,
  ToolOutcome,
} from "../src/agent-runtime/contracts";
import { createAgentRunExecutor } from "../src/agent-runtime/loop";
import { createProviderRegistry } from "../src/agent-runtime/registry";
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
    budget: { maxSteps: 10, maxMs: 60_000, maxCorrections: 1 },
    leaseTtlMs: 30_000,
  },
});

const created: string[] = [];

async function newRun(objective = "Abrir a página e relatar o que há nela.") {
  const { run } = await service.createRun(
    { id: "loop-user" },
    {
      botId: `bot-${crypto.randomUUID().slice(0, 8)}`,
      userId: "loop-user",
      origin: "web",
      objective,
    },
    "loop-user",
  );
  created.push(run.id);
  return run;
}

afterEach(async () => {
  if (!created.length) return;
  await database
    .update(agentRuns)
    .set({ status: "paused" })
    .where(and(inArray(agentRuns.id, created), eq(agentRuns.status, "queued")));
  await database
    .delete(browserProfileLeases)
    .where(inArray(browserProfileLeases.owner, ["loop-worker"]));
});

afterAll(async () => {
  if (created.length) {
    await database.delete(agentRuns).where(inArray(agentRuns.id, created));
  }
});

/** A provider that reads from a script, so every branch of the loop is reachable. */
function scriptedProvider(
  script: AgentRunResult[] | ((input: AgentRunInput) => AgentRunResult),
  capabilities: Partial<AgentModelProvider["capabilities"]> = {},
): AgentModelProvider & { inputs: AgentRunInput[] } {
  const inputs: AgentRunInput[] = [];
  let index = 0;
  return {
    id: "scripted",
    capabilities: {
      vision: false,
      tools: true,
      streaming: false,
      mode: "step",
      ...capabilities,
    },
    inputs,
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      inputs.push(input);
      if (typeof script === "function") return script(input);
      const result = script[Math.min(index, script.length - 1)];
      index += 1;
      if (!result) throw new Error("The script has no decisions.");
      return result;
    },
  };
}

function observationSource(): ObservationSource & { calls: number } {
  const source = {
    calls: 0,
    async observe(): Promise<AgentObservation> {
      source.calls += 1;
      return {
        observationId: crypto.randomUUID(),
        runId: "the-run",
        url: "https://example.test/form",
        title: "Formulário",
        text: "Preencha o formulário.",
        truncated: false,
        elements: [
          { ref: "e1", role: "textbox", name: "Nome" },
          { ref: "e2", role: "button", name: "Enviar" },
        ],
        snapshotId: source.calls,
        viewport: { width: 1280, height: 800 },
        capturedAt: new Date().toISOString(),
        control: { holder: "bot", secretPending: false },
        images: [],
        textOnly: false,
      };
    },
  };
  return source;
}

function toolCatalog(
  outcome: (call: ToolCall) => ToolOutcome | Promise<ToolOutcome> = () => ({
    ok: true,
    result: { url: "https://example.test/form" },
  }),
): ToolCatalog & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    definitions: () => [
      {
        name: "read_page",
        description: "Read the current page.",
        parameters: { type: "object", properties: {} },
      },
    ],
    async execute(call: ToolCall): Promise<ToolOutcome> {
      calls.push(call);
      return outcome(call);
    },
  };
}

function executorFor(options: {
  provider: AgentModelProvider;
  observations?: ObservationSource;
  tools?: ToolCatalog;
  maxRefusals?: number;
  maxCorrections?: number;
  maxProviderRetries?: number;
  notifier?: { events: { to: string }[] };
}) {
  return createAgentRunExecutor({
    repository,
    auditStore: createAuditStore(database),
    providers: createProviderRegistry([options.provider]),
    observations: options.observations ?? observationSource(),
    tools: options.tools ?? toolCatalog(),
    leaseTtlMs: 30_000,
    maxCorrections: options.maxCorrections ?? 1,
    maxRefusals: options.maxRefusals ?? 1,
    maxProviderRetries: options.maxProviderRetries ?? 1,
    ...(options.notifier
      ? {
          notifier: {
            async statusChanged(event: { to: string }) {
              options.notifier?.events.push(event);
            },
          },
        }
      : {}),
  });
}

/** Claim the run the way the worker would, then run the executor by hand. */
async function drive(runId: string, executor: ReturnType<typeof executorFor>) {
  const claimed = await repository.claim(runId, "loop-worker", 30_000);
  if (!claimed) throw new Error("The run could not be claimed for the test.");
  await executor({
    runId,
    owner: "loop-worker",
    generation: Number(claimed.leaseGeneration),
    signal: new AbortController().signal,
  });
  return claimed;
}

describe("the agent loop", () => {
  test("runs observe→decide→act until the model finishes", async () => {
    const run = await newRun();
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "click", arguments: { ref: "e2" } } },
      { kind: "final", message: "O formulário tem dois campos." },
    ]);
    const tools = toolCatalog();
    await drive(run.id, executorFor({ provider, tools }));

    const row = await repository.get(run.id);
    expect(row?.status).toBe("succeeded");
    expect(row?.finishedAt).not.toBeNull();

    const steps = await service.steps(run.id);
    expect(steps.length).toBe(2);
    expect(steps[0]?.kind).toBe("observation");
    expect(steps[0]?.status).toBe("ok");
    expect(steps[0]?.proposedAction).toMatchObject({ name: "click" });
    expect(steps[1]?.status).toBe("succeeded");

    const events = await service.events(run.id, 0);
    expect(events.map((event) => event.type)).toContain("run.final");

    const usage = row?.usage as { steps: number; modelCalls: number; toolCalls: number };
    expect(usage.steps).toBe(2);
    expect(usage.modelCalls).toBe(2);
    expect(usage.toolCalls).toBe(1);
    // The tool was told who it acts for, and which step it belongs to.
    expect(tools.calls[0]?.arguments).toEqual({ ref: "e2" });
  });

  test("a policy refusal is retried by the model, then fails the run", async () => {
    const run = await newRun();
    const provider = scriptedProvider(() => ({
      kind: "tool_call",
      call: { name: "click", arguments: { ref: "e2" } },
    }));
    const tools = toolCatalog(() => ({
      ok: false,
      refused: { rule: 'page.host == "blocked.test"', reason: "A regra recusou." },
    }));
    await drive(run.id, executorFor({ provider, tools, maxRefusals: 1 }));

    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    expect((row?.error as { code?: string } | null)?.code).toBe("POLICY_DENIED");
    const steps = await service.steps(run.id);
    expect(steps.filter((step) => step.status === "refused").length).toBe(2);
  });

  test("a request for help parks the run and notifies", async () => {
    const run = await newRun();
    const notifier = { events: [] as { to: string }[] };
    const provider = scriptedProvider([
      { kind: "help", reason: "Há um CAPTCHA na tela." },
    ]);
    await drive(run.id, executorFor({ provider, notifier }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("waiting_human");
    expect(notifier.events.some((event) => event.to === "waiting_human")).toBe(
      true,
    );
  });

  test("an uncertain effect stops for reconciliation instead of repeating", async () => {
    const run = await newRun();
    const provider = scriptedProvider([
      {
        kind: "tool_call",
        call: { name: "click", arguments: { ref: "e2" } },
      },
    ]);
    const tools = toolCatalog(() => ({
      ok: false,
      uncertain: true,
      error: { code: "EFFECT_UNCERTAIN", message: "O envio expirou." },
    }));
    await drive(run.id, executorFor({ provider, tools }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("needs_reconciliation");
    expect(row?.checkpoint).toMatchObject({ effect: "uncertain" });
    // And a fresh worker does not pick it up on its own.
    expect(await repository.claim(run.id, "loop-worker", 30_000)).toBeUndefined();
  });

  test("malformed decisions are corrected a bounded number of times", async () => {
    const run = await newRun();
    const provider = scriptedProvider([
      { kind: "invalid", raw: "{{{", error: "JSON inválido." },
    ]);
    await drive(run.id, executorFor({ provider, maxCorrections: 1 }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    expect((row?.error as { code?: string } | null)?.code).toBe("INVALID_ACTION");
    const events = await service.events(run.id, 0);
    expect(events.filter((event) => event.type === "run.note").length).toBe(2);
  });

  test("an unavailable provider fails the run with its own code", async () => {
    const run = await newRun();
    const provider = scriptedProvider(() => {
      throw new Error("connection refused");
    });
    await drive(
      run.id,
      executorFor({ provider, maxProviderRetries: 1 }),
    );
    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    expect((row?.error as { code?: string } | null)?.code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });

  test("step budget stops the loop with the limit named", async () => {
    const run = await newRun();
    await database
      .update(agentRuns)
      .set({ budget: { maxSteps: 1, maxMs: 60_000, maxCorrections: 1 } })
      .where(eq(agentRuns.id, run.id));
    const provider = scriptedProvider(() => ({
      kind: "tool_call",
      call: { name: "read_page", arguments: {} },
    }));
    await drive(run.id, executorFor({ provider }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    const error = row?.error as { code?: string; message?: string } | null;
    expect(error?.code).toBe("BUDGET_EXCEEDED");
    expect(error?.message).toContain("1");
  });

  test("a browser already in use sends the run back to the queue", async () => {
    const run = await newRun();
    await repository.acquireProfileLease({
      profileId: run.botId,
      runId: crypto.randomUUID(),
      owner: "somebody-else",
      ttlMs: 30_000,
    });
    const provider = scriptedProvider([
      { kind: "final", message: "Não deveria rodar." },
    ]);
    const claimed = await repository.claim(run.id, "loop-worker", 30_000);
    await executorFor({ provider })({
      runId: run.id,
      owner: "loop-worker",
      generation: Number(claimed?.leaseGeneration),
      signal: new AbortController().signal,
    });
    const row = await repository.get(run.id);
    expect(row?.status).toBe("queued");
    const events = await service.events(run.id, 0);
    expect(events.map((event) => event.type)).toContain(
      "run.queued_for_profile",
    );
    await database
      .delete(browserProfileLeases)
      .where(eq(browserProfileLeases.profileId, run.botId));
  });

  test("a pause during the model call costs no action", async () => {
    const run = await newRun();
    const tools = toolCatalog();
    const provider = scriptedProvider(async () => {
      await service.pause(run.id, { id: "loop-user" });
      return {
        kind: "tool_call",
        call: { name: "click", arguments: { ref: "e2" } },
      };
    });
    await drive(run.id, executorFor({ provider, tools }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("paused");
    expect(tools.calls.length).toBe(0);
  });

  test("a cancelled run is never executed", async () => {
    const run = await newRun();
    await service.cancel(run.id, { id: "loop-user" });
    const provider = scriptedProvider([
      { kind: "final", message: "Não deveria rodar." },
    ]);
    await executorFor({ provider })({
      runId: run.id,
      owner: "loop-worker",
      generation: 1,
      signal: new AbortController().signal,
    });
    expect(provider.inputs.length).toBe(0);
    expect((await repository.get(run.id))?.status).toBe("cancelled");
  });

  test("a resposta que uma pessoa deu chega ao modelo no passo seguinte", async () => {
    const run = await newRun();
    await repository.updateStatus(run.id, ["queued"], "waiting_human");
    await service.appendMessage(
      run.id,
      { id: "loop-user" },
      { text: "O código é 4821.", source: "telegram" },
    );

    const provider = scriptedProvider([
      { kind: "final", message: "Pronto." },
    ]);
    await drive(run.id, executorFor({ provider }));

    expect(provider.inputs[0]?.messages?.map((message) => message.text)).toEqual([
      "O código é 4821.",
    ]);
    // Entregue uma vez: a segunda decisão não a repete.
    expect(provider.inputs[1]?.messages).toBeUndefined();
  });

  test("uma negação é informação: o modelo decide outra coisa", async () => {
    const run = await newRun();
    let asked = 0;
    const provider = scriptedProvider(() => {
      asked += 1;
      return asked === 1
        ? {
            kind: "tool_call",
            call: { name: "click", arguments: { ref: "e2" } },
          }
        : { kind: "final", message: "Entendi, não publiquei." };
    });
    const tools = toolCatalog();
    const executor = createAgentRunExecutor({
      repository,
      auditStore: createAuditStore(database),
      providers: createProviderRegistry([provider]),
      observations: observationSource(),
      tools,
      leaseTtlMs: 30_000,
      maxCorrections: 1,
      maxRefusals: 1,
      maxProviderRetries: 1,
      approvals: {
        async review() {
          return {
            decision: "denied" as const,
            approvalId: crypto.randomUUID(),
            reason: "O rótulo contém 'enviar'.",
          };
        },
        async consume() {
          return true;
        },
      },
    });
    await drive(run.id, executor);

    const row = await repository.get(run.id);
    expect(row?.status).toBe("succeeded");
    // A ação negada nunca chegou ao navegador.
    expect(tools.calls.length).toBe(0);
    const steps = await service.steps(run.id);
    expect(steps[0]?.status).toBe("refused");
    expect(steps[0]?.policyDecision).toMatchObject({ rule: "approval" });
  });

  test("insistir numa ação negada gasta a paciência do loop", async () => {
    const run = await newRun();
    const provider = scriptedProvider(() => ({
      kind: "tool_call",
      call: { name: "click", arguments: { ref: "e2" } },
    }));
    const executor = createAgentRunExecutor({
      repository,
      auditStore: createAuditStore(database),
      providers: createProviderRegistry([provider]),
      observations: observationSource(),
      tools: toolCatalog(),
      leaseTtlMs: 30_000,
      maxCorrections: 1,
      maxRefusals: 1,
      maxProviderRetries: 1,
      approvals: {
        async review() {
          return {
            decision: "denied" as const,
            approvalId: crypto.randomUUID(),
            reason: "O rótulo contém 'enviar'.",
          };
        },
        async consume() {
          return true;
        },
      },
    });
    await drive(run.id, executor);
    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    expect((row?.error as { code?: string } | null)?.code).toBe(
      "POLICY_DENIED",
    );
  });
});
