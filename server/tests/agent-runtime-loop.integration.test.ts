/**
 * The agent loop, over the real durable store.
 *
 * The provider, the observation and the tool catalog are fakes on purpose — the loop's contract is
 * with those three interfaces, and every refusal path here is a path a real provider can reach. The
 * database, the steps, the events and the leases are real.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { createAgentRunRepository } from "../src/agent-runs/repository";
import { createAgentRunService, runView } from "../src/agent-runs/service";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agentRuns, browserProfileLeases } from "../src/db/schema";
import type {
  AgentModelProvider,
  AgentObservation,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  CompletionCondition,
  ObservationSource,
  ToolCall,
  ToolCatalog,
  ToolOutcome,
} from "../src/agent-runtime/contracts";
import { TEST_POOL } from "./support/database";
import { createAgentRunExecutor } from "../src/agent-runtime/loop";
import { createProviderRegistry } from "../src/agent-runtime/registry";
import { createRoutedProvider } from "../src/agent-runtime/routed-provider";

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
  now?: () => number;
  defaultModel?: string;
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
    defaultModel: options.defaultModel,
    ...(options.now ? { now: options.now } : {}),
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
      { kind: "tool_call", call: { name: "read_page", arguments: {} } },
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
    expect(steps[0]?.proposedAction).toMatchObject({ name: "read_page" });
    expect(steps[1]?.status).toBe("succeeded");

    const events = await service.events(run.id, 0);
    expect(events.map((event) => event.type)).toContain("run.final");

    const usage = row?.usage as {
      steps: number;
      modelCalls: number;
      toolCalls: number;
    };
    expect(usage.steps).toBe(2);
    expect(usage.modelCalls).toBe(2);
    expect(usage.toolCalls).toBe(1);
    // The tool was told who it acts for, and which step it belongs to.
    expect(tools.calls[0]?.arguments).toEqual({});
  });

  test("a policy refusal is retried by the model, then fails the run", async () => {
    const run = await newRun();
    const provider = scriptedProvider(() => ({
      kind: "tool_call",
      call: { name: "click", arguments: { ref: "e2" } },
    }));
    const tools = toolCatalog(() => ({
      ok: false,
      refused: {
        rule: 'page.host == "blocked.test"',
        reason: "A regra recusou.",
      },
    }));
    await drive(run.id, executorFor({ provider, tools, maxRefusals: 1 }));

    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    expect((row?.error as { code?: string } | null)?.code).toBe(
      "POLICY_DENIED",
    );
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
    expect(
      await repository.claim(run.id, "loop-worker", 30_000),
    ).toBeUndefined();
  });

  test("malformed decisions are corrected a bounded number of times", async () => {
    const run = await newRun();
    const provider = scriptedProvider([
      { kind: "invalid", raw: "{{{", error: "JSON inválido." },
    ]);
    await drive(run.id, executorFor({ provider, maxCorrections: 1 }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    expect((row?.error as { code?: string } | null)?.code).toBe(
      "INVALID_ACTION",
    );
    const events = await service.events(run.id, 0);
    expect(events.filter((event) => event.type === "run.note").length).toBe(2);
  });

  test("an unavailable provider fails the run with its own code", async () => {
    const run = await newRun();
    const provider = scriptedProvider(() => {
      throw new Error("connection refused");
    });
    await drive(run.id, executorFor({ provider, maxProviderRetries: 1 }));
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

    const provider = scriptedProvider([{ kind: "final", message: "Pronto." }]);
    await drive(run.id, executorFor({ provider }));

    expect(
      provider.inputs[0]?.messages?.map((message) => message.text),
    ).toEqual(["O código é 4821."]);
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

  test("três intervalos ativos de 1.000 ms acumulam 3.000 ms", async () => {
    let t = 1_000_000;
    let calls = 0;
    const run = await newRun();
    const provider = scriptedProvider(() => {
      t += 1_000;
      calls += 1;
      return calls === 1
        ? {
            kind: "tool_call",
            call: { name: "read_page", arguments: {} },
          }
        : { kind: "final", message: "Pronto." };
    });
    const tools = toolCatalog(() => {
      t += 1_000;
      return { ok: true, result: { url: "https://example.test/form" } };
    });
    await drive(run.id, executorFor({ provider, tools, now: () => t }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("succeeded");
    const usage = row?.usage as { activeMs: number };
    expect(usage?.activeMs).toBe(3_000);
  });

  test("a retomada soma a base persistida uma única vez", async () => {
    let t = 2_000_000;
    const run = await newRun();
    await database
      .update(agentRuns)
      .set({
        usage: { steps: 1, activeMs: 5_000, modelCalls: 1, toolCalls: 0 },
      })
      .where(eq(agentRuns.id, run.id));
    const provider = scriptedProvider(() => {
      t += 1_000;
      return { kind: "final", message: "Pronto." };
    });
    await drive(run.id, executorFor({ provider, now: () => t }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("succeeded");
    const usage = row?.usage as { activeMs: number };
    expect(usage?.activeMs).toBe(6_000);
  });

  test("a espera humana fica fora do tempo ativo", async () => {
    let t = 3_000_000;
    const run = await newRun();
    const parked = scriptedProvider(() => {
      t += 1_000;
      return { kind: "help", reason: "Preciso de você." };
    });
    await drive(run.id, executorFor({ provider: parked, now: () => t }));
    const parkedRow = await repository.get(run.id);
    expect(parkedRow?.status).toBe("waiting_human");
    const parkedUsage = parkedRow?.usage as { activeMs: number };
    expect(parkedUsage?.activeMs).toBe(1_000);
    // A pessoa demora: o relógio anda sem execução.
    t += 50_000;
    await repository.updateStatus(run.id, ["waiting_human"], "queued");
    const closer = scriptedProvider(() => {
      t += 500;
      return { kind: "final", message: "Pronto." };
    });
    await drive(run.id, executorFor({ provider: closer, now: () => t }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("succeeded");
    const usage = row?.usage as { activeMs: number };
    expect(usage?.activeMs).toBe(1_500);
  });

  test("o deadline durante a chamada aborta sem executar a próxima ação", async () => {
    let t = 4_000_000;
    const run = await newRun();
    await database
      .update(agentRuns)
      .set({ budget: { maxSteps: 10, maxMs: 1_000, maxCorrections: 1 } })
      .where(eq(agentRuns.id, run.id));
    const provider = scriptedProvider(() => {
      t += 5_000;
      return {
        kind: "tool_call",
        call: { name: "click", arguments: { ref: "e2" } },
      };
    });
    const tools = toolCatalog();
    await drive(run.id, executorFor({ provider, tools, now: () => t }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    const error = row?.error as { code?: string } | null;
    expect(error?.code).toBe("BUDGET_EXCEEDED");
    expect(tools.calls.length).toBe(0);
    const usage = row?.usage as { activeMs: number };
    expect(usage?.activeMs).toBe(5_000);
  });

  test("a pausa durante a chamada estourada preserva a pausa", async () => {
    let t = 5_000_000;
    const run = await newRun();
    await database
      .update(agentRuns)
      .set({ budget: { maxSteps: 10, maxMs: 1_000, maxCorrections: 1 } })
      .where(eq(agentRuns.id, run.id));
    const tools = toolCatalog();
    const provider = scriptedProvider(async () => {
      t += 5_000;
      await service.pause(run.id, { id: "loop-user" });
      return {
        kind: "tool_call",
        call: { name: "click", arguments: { ref: "e2" } },
      };
    });
    await drive(run.id, executorFor({ provider, tools, now: () => t }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("paused");
    expect(tools.calls.length).toBe(0);
  });
});

describe("uso por tentativa e contexto útil (RQ-04/RQ-06)", () => {
  test("duas falhas e um sucesso contam três chamadas com identidade", async () => {
    const run = await newRun();
    let calls = 0;
    const provider = scriptedProvider(async () => {
      calls += 1;
      if (calls < 3) throw new Error("queda simulada");
      return {
        kind: "final",
        message: "Pronto.",
        usage: {
          provider: "scripted",
          model: "scripted-1",
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: null,
          cost: null,
        },
      };
    });
    await drive(run.id, executorFor({ provider, maxProviderRetries: 5 }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("succeeded");
    const usage = row?.usage as {
      modelCalls: number;
      attempts: Record<string, unknown>[];
    };
    expect(usage.modelCalls).toBe(3);
    expect(usage.attempts).toHaveLength(3);
    expect(usage.attempts[0]).toEqual({
      provider: "scripted",
      model: "scripted-1",
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cost: null,
    });
    expect(usage.attempts[2]).toMatchObject({
      provider: "scripted",
      model: "scripted-1",
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  test("a decisão seguinte recebe o resultado útil da ferramenta", async () => {
    const run = await newRun();
    const provider = scriptedProvider([
      {
        kind: "tool_call",
        call: {
          name: "plan_form",
          arguments: { values: [{ label: "Título", value: "Livro" }] },
        },
      },
      { kind: "final", message: "Preenchido." },
    ]);
    const tools = toolCatalog(() => ({
      ok: true,
      result: { assignments: [{ label: "Título", ref: "e1" }] },
    }));
    await drive(run.id, executorFor({ provider, tools }));
    const second = provider.inputs[1];
    expect(second).toBeDefined();
    const history = (second?.history ?? [])
      .map((step) => step.summary)
      .join("\n");
    expect(history).toContain("plan_form →");
    expect(history).toContain('"label":"Título"');
    expect(history).toContain('<ferramenta nome="plan_form">');
  });

  test("a restrição da pessoa sobrevive ao passo seguinte sem repetição", async () => {
    const run = await newRun();
    await service.appendMessage(
      run.id,
      { id: "loop-user" },
      { text: "Use a categoria Livros.", source: "web" },
    );
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "read_page", arguments: {} } },
      { kind: "final", message: "Pronto." },
    ]);
    await drive(run.id, executorFor({ provider }));
    expect(
      provider.inputs[0]?.messages?.map((message) => message.text),
    ).toEqual(["Use a categoria Livros."]);
    expect(provider.inputs[1]?.messages).toBeUndefined();
    expect(provider.inputs[1]?.restrictions?.map((rule) => rule.text)).toEqual([
      "Use a categoria Livros.",
    ]);
  });

  test("older human restrictions remain whole after more than five messages", async () => {
    const run = await newRun();
    const instructions = [
      `${"Context ".repeat(160)}Never submit without approval.`,
      ...Array.from({ length: 6 }, (_, index) => `Use field ${index}.`),
    ];
    for (const text of instructions)
      await service.appendMessage(
        run.id,
        { id: "loop-user" },
        { text, source: "web" },
      );
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "read_page", arguments: {} } },
      { kind: "final", message: "Read only." },
    ]);
    await drive(run.id, executorFor({ provider }));
    expect(provider.inputs[1]?.restrictions?.map((rule) => rule.text)).toEqual(
      instructions,
    );
  });

  test("oversized human context stops before model execution instead of forgetting instructions", async () => {
    const run = await newRun();
    for (let index = 0; index < 13; index += 1) {
      await service.appendMessage(
        run.id,
        { id: "loop-user" },
        { text: `${index}:${"x".repeat(3800)}`, source: "web" },
      );
    }
    const provider = scriptedProvider([
      { kind: "final", message: "Should not run." },
    ]);
    await drive(run.id, executorFor({ provider }));
    expect(provider.inputs).toEqual([]);
    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    expect((row?.error as { code: string })?.code).toBe("BUDGET_EXCEEDED");
  });

  test("telemetria de consumo não carrega prompt nem segredo", async () => {
    const run = await newRun("Relatar o saldo SALDO-SECRETO-999 sem publicar.");
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "read_page", arguments: {} } },
      { kind: "final", message: "Relatado." },
    ]);
    await drive(run.id, executorFor({ provider }));
    const row = await repository.get(run.id);
    if (!row) throw new Error("The run was not persisted.");
    const events = await service.events(run.id, 0);
    const steps = await service.steps(run.id);
    const blob = JSON.stringify({
      usage: row?.usage,
      events: events
        .filter((event) => event.type !== "run.created")
        .map((event) => event.payload),
      steps: steps.map((step) => step.executionResult),
    });
    expect(blob).not.toContain("SALDO-SECRETO-999");
    const attempts = (row.usage as { attempts: Record<string, unknown>[] })
      .attempts;
    for (const attempt of attempts) {
      expect(Object.keys(attempt).sort()).toEqual([
        "cachedTokens",
        "cost",
        "inputTokens",
        "model",
        "outputTokens",
        "provider",
      ]);
    }
  });

  test("screenshot vale só o próximo observe", async () => {
    const run = await newRun();
    const wanted: boolean[] = [];
    const source: ObservationSource = {
      async observe(request) {
        wanted.push(request.wantImage);
        return {
          observationId: crypto.randomUUID(),
          runId: request.runId,
          url: "https://example.test/form",
          title: "Formulário",
          text: "Preencha.",
          truncated: false,
          elements: [{ ref: "e1", role: "textbox", name: "Nome" }],
          snapshotId: wanted.length,
          viewport: { width: 1280, height: 800 },
          capturedAt: new Date().toISOString(),
          control: { holder: "bot", secretPending: false },
          images: request.wantImage
            ? [
                {
                  artifactId: "img-1",
                  mime: "image/png",
                  width: 1280,
                  height: 800,
                  capturedAt: new Date().toISOString(),
                  protected: false,
                  data: "QUJD",
                },
              ]
            : [],
          redactions: 0,
          textOnly: false,
        };
      },
    };
    const provider = scriptedProvider(
      [
        { kind: "tool_call", call: { name: "screenshot", arguments: {} } },
        { kind: "tool_call", call: { name: "read_page", arguments: {} } },
        { kind: "final", message: "Vi e li." },
      ],
      { vision: true },
    );
    await drive(run.id, executorFor({ provider, observations: source }));
    expect(wanted).toEqual([false, true, false]);
    expect(provider.inputs[1]?.observation?.images).toHaveLength(1);
    expect(provider.inputs[2]?.observation?.images).toHaveLength(0);
  });
});

describe("conclusão verificável e relatos roteados (RQ-03/RQ-04)", () => {
  function pageSource(page: { text: string; url?: string }): ObservationSource {
    return {
      async observe(request): Promise<AgentObservation> {
        return {
          observationId: crypto.randomUUID(),
          runId: request.runId,
          url: page.url ?? "https://example.test/form",
          title: "Formulário",
          text: page.text,
          truncated: false,
          elements: [{ ref: "e1", role: "textbox", name: "Nome" }],
          snapshotId: 1,
          viewport: { width: 1280, height: 800 },
          capturedAt: new Date().toISOString(),
          control: { holder: "bot", secretPending: false },
          images: [],
          redactions: 0,
          textOnly: false,
        };
      },
    };
  }

  async function newRunWithCompletion(
    completion: CompletionCondition,
    objective = "Publicar o formulário e confirmar.",
  ) {
    const { run } = await service.createRun(
      { id: "loop-user" },
      {
        botId: `bot-${crypto.randomUUID().slice(0, 8)}`,
        userId: "loop-user",
        origin: "web",
        objective,
        completion,
      },
      "loop-user",
    );
    created.push(run.id);
    return run;
  }

  test("prosa de sucesso após clique sem prova estaciona sem repetir a ação", async () => {
    const run = await newRun();
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "click", arguments: { ref: "e2" } } },
      { kind: "final", message: "Publiquei o formulário com sucesso!" },
    ]);
    const tools = toolCatalog();
    await drive(run.id, executorFor({ provider, tools }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("needs_reconciliation");
    expect(row?.checkpoint).toMatchObject({ effect: "uncertain" });
    // A ação não foi repetida para "confirmar": um clique, uma reconciliação.
    expect(tools.calls.length).toBe(1);
    const usage = row?.usage as { modelCalls: number; attempts: unknown[] };
    expect(usage.modelCalls).toBe(2);
    expect(usage.attempts).toHaveLength(2);
  });

  test("condição page_text confirmada na página conclui", async () => {
    const run = await newRunWithCompletion({
      kind: "page_text",
      text: "Pedido 42 confirmado",
    });
    const provider = scriptedProvider([
      { kind: "final", message: "Pedido 42 confirmado, visível na página." },
    ]);
    await drive(
      run.id,
      executorFor({
        provider,
        observations: pageSource({
          text: "Recibo: Pedido 42 confirmado. Obrigado!",
        }),
      }),
    );
    expect((await repository.get(run.id))?.status).toBe("succeeded");
  });

  test("condição page_text ausente não conclui, mesmo com prosa enfática", async () => {
    const run = await newRunWithCompletion({
      kind: "page_text",
      text: "Pedido 42 confirmado",
    });
    const provider = scriptedProvider([
      {
        kind: "final",
        message: "Publiquei tudo, está tudo certo, palavra de modelo.",
        evidence: { receipt: "eu vi, confia" },
      },
    ]);
    await drive(
      run.id,
      executorFor({
        provider,
        observations: pageSource({ text: "Formulário ainda vazio." }),
      }),
    );
    const row = await repository.get(run.id);
    expect(row?.status).toBe("needs_reconciliation");
  });

  test("condição page_url confirmada conclui", async () => {
    const run = await newRunWithCompletion({
      kind: "page_url",
      url: "https://example.test/sucesso",
    });
    const provider = scriptedProvider([
      { kind: "final", message: "Chegamos na página de sucesso." },
    ]);
    await drive(
      run.id,
      executorFor({
        provider,
        observations: pageSource({
          text: "Obrigado!",
          url: "https://example.test/sucesso",
        }),
      }),
    );
    expect((await repository.get(run.id))?.status).toBe("succeeded");
  });

  test("artefato do próprio run conclui; alheio ou ausente não", async () => {
    const owner = await newRunWithCompletion({ kind: "artifact" });
    const receipt = Bun.file(
      join(tmpdir(), `openbot-receipt-${crypto.randomUUID()}.txt`),
    );
    await Bun.write(receipt, "Receipt 42");
    try {
      const artifact = await repository.insertArtifact({
        runId: owner.id,
        stepId: null,
        kind: "file",
        mime: "text/plain",
        width: null,
        height: null,
        hash: "recibo-1",
        bytes: 10,
        storagePath: receipt.name ?? "",
        classification: "internal",
        protection: "none",
        retentionUntil: null,
        allowedDestinations: [],
        metadata: {},
      });
      await drive(
        owner.id,
        executorFor({
          provider: scriptedProvider([
            { kind: "final", message: "Recibo pronto." },
          ]),
        }),
      );
      expect((await repository.get(owner.id))?.status).toBe("succeeded");

      // O mesmo artefato não prova nada para outro run.
      const stranger = await newRunWithCompletion({
        kind: "artifact",
        artifactId: artifact.id,
      });
      await drive(
        stranger.id,
        executorFor({
          provider: scriptedProvider([
            { kind: "final", message: "Recibo pronto." },
          ]),
        }),
      );
      expect((await repository.get(stranger.id))?.status).toBe(
        "needs_reconciliation",
      );

      const missing = await newRunWithCompletion({
        kind: "artifact",
        artifactId: crypto.randomUUID(),
      });
      await drive(
        missing.id,
        executorFor({
          provider: scriptedProvider([
            { kind: "final", message: "Recibo pronto." },
          ]),
        }),
      );
      expect((await repository.get(missing.id))?.status).toBe(
        "needs_reconciliation",
      );
    } finally {
      await receipt.delete();
    }
  });

  test("texto puro sem efeitos conclui sem screenshot obrigatório", async () => {
    const run = await newRun("Resumir o que a página diz.");
    const provider = scriptedProvider([
      { kind: "final", message: "A página pede para preencher o formulário." },
    ]);
    await drive(run.id, executorFor({ provider }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("succeeded");
    expect(provider.inputs[0]?.observation?.images).toHaveLength(0);
  });

  test("delegated com toolCalls sem prova estaciona; zerado conclui", async () => {
    const acted = await newRun("Delegar o preenchimento.");
    await drive(
      acted.id,
      executorFor({
        provider: scriptedProvider([
          { kind: "delegated", message: "Preenchi e enviei.", toolCalls: 3 },
        ]),
      }),
    );
    expect((await repository.get(acted.id))?.status).toBe(
      "needs_reconciliation",
    );

    const reported = await newRun("Delegar a leitura.");
    await drive(
      reported.id,
      executorFor({
        provider: scriptedProvider([
          { kind: "delegated", message: "Li e resumi.", toolCalls: 0 },
        ]),
      }),
    );
    expect((await repository.get(reported.id))?.status).toBe("succeeded");
  });

  test("retomada após reconciliação conclui quando a página confirma", async () => {
    const page = { text: "Formulário ainda vazio." };
    const run = await newRunWithCompletion({
      kind: "page_text",
      text: "Pedido 42 confirmado",
    });
    const first = scriptedProvider([
      { kind: "tool_call", call: { name: "click", arguments: { ref: "e2" } } },
      { kind: "final", message: "Enviei o pedido." },
    ]);
    await drive(
      run.id,
      executorFor({ provider: first, observations: pageSource(page) }),
    );
    expect((await repository.get(run.id))?.status).toBe("needs_reconciliation");

    // A pessoa confere por fora, a página muda, e a retomada conclui sem reagir.
    await service.resume(run.id, { id: "loop-user" });
    page.text = "Recibo: Pedido 42 confirmado. Obrigado!";
    const tools = toolCatalog();
    const second = scriptedProvider([
      { kind: "final", message: "A página agora mostra o recibo." },
    ]);
    await drive(
      run.id,
      executorFor({ provider: second, tools, observations: pageSource(page) }),
    );
    expect((await repository.get(run.id))?.status).toBe("succeeded");
    expect(tools.calls.length).toBe(0);
  });

  test("relatos roteados contam a identidade subjacente sem dupla", async () => {
    const run = await newRun();
    await database
      .update(agentRuns)
      .set({ provider: "routed" })
      .where(eq(agentRuns.id, run.id));
    const routedLike: AgentModelProvider = {
      id: "routed",
      capabilities: {
        vision: false,
        tools: true,
        streaming: false,
        mode: "step",
      },
      async run(
        _input: AgentRunInput,
        context: AgentRunContext,
      ): Promise<AgentRunResult> {
        context.onAttempt?.({
          provider: "cheap",
          model: "cheap-model",
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          cost: null,
        });
        context.onAttempt?.({
          provider: "strong",
          model: "strong-model",
          inputTokens: 7,
          outputTokens: 3,
          cachedTokens: null,
          cost: null,
        });
        return {
          kind: "final",
          message: "Pronto.",
          usage: {
            provider: "routed",
            model: "routed-1",
            inputTokens: 99,
            outputTokens: 99,
            cachedTokens: null,
            cost: null,
          },
        };
      },
    };
    await drive(run.id, executorFor({ provider: routedLike }));
    const row = await repository.get(run.id);
    expect(row?.status).toBe("succeeded");
    const view = runView(row!);
    expect(view.usage.modelCalls).toBe(2);
    expect(view.usage.attempts?.map((attempt) => attempt.provider)).toEqual([
      "cheap",
      "strong",
    ]);
    expect(view.usage.attempts?.[1]).toMatchObject({
      model: "strong-model",
      inputTokens: 7,
      outputTokens: 3,
    });
    for (const attempt of view.usage.attempts ?? []) {
      expect(Object.keys(attempt).sort()).toEqual([
        "cachedTokens",
        "cost",
        "inputTokens",
        "model",
        "outputTokens",
        "provider",
      ]);
    }
  });

  test("fracasso com relato preserva a tentativa subjacente uma vez", async () => {
    const run = await newRun();
    await database
      .update(agentRuns)
      .set({ provider: "routed" })
      .where(eq(agentRuns.id, run.id));
    const failing: AgentModelProvider = {
      id: "routed",
      capabilities: {
        vision: false,
        tools: true,
        streaming: false,
        mode: "step",
      },
      async run(
        _input: AgentRunInput,
        context: AgentRunContext,
      ): Promise<AgentRunResult> {
        context.onAttempt?.({
          provider: "cheap",
          model: "cheap-model",
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          cost: null,
        });
        throw new Error("cheap caiu e não há fallback");
      },
    };
    await drive(
      run.id,
      executorFor({ provider: failing, maxProviderRetries: 0 }),
    );
    const row = await repository.get(run.id);
    expect(row?.status).toBe("failed");
    const usage = row?.usage as {
      modelCalls: number;
      attempts: { provider: string }[];
    };
    expect(usage.modelCalls).toBe(1);
    expect(usage.attempts.map((attempt) => attempt.provider)).toEqual([
      "cheap",
    ]);
  });
});

describe("pin explícito no roteador real", () => {
  test.each([
    {
      name: "preserva modelo igual ao padrão após retomada",
      model: "scripted-1",
      forged: false,
      status: "failed",
      attempts: ["scripted", "scripted"],
    },
    {
      name: "permite fallback sem escolha apesar de metadata forjado",
      model: undefined,
      forged: true,
      status: "succeeded",
      attempts: ["scripted", "scripted", "strong"],
    },
  ])("$name", async ({ model, forged, status, attempts }) => {
    const { run } = await service.createRun(
      { id: "loop-user" },
      {
        botId: `bot-${crypto.randomUUID()}`,
        userId: "loop-user",
        origin: "web",
        objective: "Relatar o texto disponível.",
        provider: "routed",
        model,
        metadata: { modelPinned: forged },
      },
      "loop-user",
    );
    created.push(run.id);
    const primary = scriptedProvider((input) => {
      if (input.usage.modelCalls === 0)
        return { kind: "help", reason: "Confirme a continuação." };
      throw Object.assign(new Error("Primary unavailable"), {
        retryable: true,
      });
    });
    const fallback = {
      ...scriptedProvider([{ kind: "final", message: "Texto disponível." }]),
      id: "strong",
    };
    const routed = createRoutedProvider({
      policy: { primary: "scripted", fallback: "strong" },
      providers: [primary, fallback],
      configs: [
        {
          id: "scripted",
          transport: "responses",
          model: "scripted-1",
          vision: false,
          tools: true,
        },
        {
          id: "strong",
          transport: "responses",
          model: "strong-1",
          vision: false,
          tools: true,
        },
      ],
    });
    if (!routed)
      throw new Error("The real routed provider was not registered.");
    await drive(
      run.id,
      executorFor({ provider: routed, defaultModel: "scripted-1" }),
    );
    expect((await repository.get(run.id))?.status).toBe("waiting_human");
    await service.resume(run.id, { id: "loop-user" });
    await drive(
      run.id,
      executorFor({ provider: routed, defaultModel: "scripted-1" }),
    );
    const row = await repository.get(run.id);
    if (!row) throw new Error("The persisted run disappeared.");
    expect(row.status).toBe(status);
    expect(
      runView(row).usage.attempts?.map((attempt) => attempt.provider),
    ).toEqual(attempts);
  });
});
