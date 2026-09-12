/**
 * Roteamento opt-in de modelos (RQ-10): modo fixo sem política, uma escalada com ela.
 *
 * O que este arquivo prende: sem `AGENT_ROUTING_POLICY` nada é substituído; com ela, só
 * candidatos registrados e compatíveis conduzem a tarefa, no máximo uma escalada por run
 * (lida de `usage.attempts`, sem estado global), cada tentativa subjacente relatada uma vez
 * em `onAttempt` com a identidade real. Cancelamento, recusa e erro desconhecido nunca
 * escalam; modelo explícito em conflito é rejeitado, nunca trocado em silêncio.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import type {
  AgentModelProvider,
  AgentRunInput,
  AgentRunResult,
  ModelAttemptUsage,
  ModelCapabilities,
} from "../src/agent-runtime/contracts";
import { ProviderRejectedError } from "../src/agent-runtime/providers/http";
import {
  createRoutedProvider,
  routedCatalogEntries,
  ROUTED_PROVIDER_ID,
  selectRoutedCandidate,
} from "../src/agent-runtime/routed-provider";
import { testEnvironment } from "./support/environment";

function capabilities(
  overrides: Partial<ModelCapabilities> = {},
): ModelCapabilities {
  return {
    vision: true,
    tools: true,
    streaming: false,
    mode: "step",
    ...overrides,
  };
}

function stepInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: "run-1",
    botId: "bot-1",
    objective: "Ler a página e resumir.",
    observation: null,
    history: [],
    tools: [],
    budget: { maxSteps: 40, maxMs: 900_000, maxCorrections: 2 },
    usage: { steps: 0, activeMs: 0, modelCalls: 0, toolCalls: 0 },
    capabilities: capabilities(),
    ...overrides,
  };
}

function withImage(input: AgentRunInput): AgentRunInput {
  return {
    ...input,
    observation: {
      observationId: "obs-1",
      runId: input.runId,
      url: "https://exemplo.test/pagina",
      title: "Página",
      text: "texto",
      truncated: false,
      elements: [],
      snapshotId: 1,
      viewport: { width: 1280, height: 800 },
      capturedAt: "2026-09-12T00:00:00.000Z",
      control: { holder: "bot", secretPending: false },
      images: [
        {
          artifactId: "artifact-1",
          mime: "image/png",
          width: 1280,
          height: 800,
          capturedAt: "2026-09-12T00:00:00.000Z",
          protected: false,
          data: "QUJD",
        },
      ],
      redactions: 0,
      textOnly: false,
    },
  };
}

function withTools(input: AgentRunInput): AgentRunInput {
  return {
    ...input,
    tools: [
      {
        name: "click",
        description: "Clica.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
  };
}

/** Um provedor de mentira: responde o que o teste mandar e guarda por onde passou. */
function fakeProvider(
  id: string,
  options: {
    capabilities?: Partial<ModelCapabilities>;
    answer?: AgentRunResult;
    failWith?: unknown;
    calls?: string[];
  } = {},
): AgentModelProvider {
  const calls = options.calls ?? [];
  const answer: AgentRunResult = options.answer ?? {
    kind: "final",
    message: `feito por ${id}`,
    usage: {
      provider: id,
      model: `${id}-model`,
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: null,
      cost: null,
    },
  };
  return {
    id,
    capabilities: capabilities(options.capabilities),
    run: async () => {
      calls.push(id);
      if (options.failWith !== undefined) throw options.failWith;
      return answer;
    },
  };
}

function retryable(message = "provedor instável"): Error & { retryable: true } {
  return Object.assign(new Error(message), { retryable: true as const });
}

const configs = [
  {
    id: "cheap",
    transport: "chat-completions",
    model: "cheap-model",
    vision: false,
    tools: true,
  },
  {
    id: "strong",
    transport: "responses",
    model: "strong-model",
    vision: true,
    tools: true,
  },
] as const;

type MutableConfigs = {
  id: string;
  transport: "chat-completions" | "responses";
  model: string;
  vision: boolean;
  tools: boolean;
}[];

const mutableConfigs = (): MutableConfigs =>
  configs.map((config) => ({ ...config }));

describe("configuração da política", () => {
  test("ausente mantém o modo fixo e o padrão", () => {
    const config = loadConfig(
      testEnvironment({
        AGENT_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
      }),
    );
    expect(config.agentRuntime.routingPolicy).toBeUndefined();
    expect(config.agentRuntime.defaultProvider).toBe("local");
  });

  test("válida resolve primário e fallback", () => {
    const config = loadConfig(
      testEnvironment({
        AGENT_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
        AGENT_CODEX_URL: "http://127.0.0.1:4200/ag-ui",
        AGENT_ROUTING_POLICY: JSON.stringify({
          primary: "local",
          fallback: "codex",
        }),
      }),
    );
    expect(config.agentRuntime.routingPolicy).toEqual({
      primary: "local",
      fallback: "codex",
    });
    expect(config.agentRuntime.defaultProvider).toBe("local");
  });

  test("recusa JSON inválido, primário ausente e candidato desconhecido", () => {
    const base = testEnvironment({
      AGENT_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
    });
    expect(() =>
      loadConfig({ ...base, AGENT_ROUTING_POLICY: "não-json" }),
    ).toThrow("AGENT_ROUTING_POLICY must be JSON");
    expect(() =>
      loadConfig({ ...base, AGENT_ROUTING_POLICY: JSON.stringify({}) }),
    ).toThrow('"primary"');
    expect(() =>
      loadConfig({
        ...base,
        AGENT_ROUTING_POLICY: JSON.stringify({ primary: "inexistente" }),
      }),
    ).toThrow("not configured");
  });

  test("recusa auto-referência a routed e primário igual ao fallback", () => {
    const base = testEnvironment({
      AGENT_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
    });
    expect(() =>
      loadConfig({
        ...base,
        AGENT_ROUTING_POLICY: JSON.stringify({ primary: "routed" }),
      }),
    ).toThrow("routed");
    expect(() =>
      loadConfig({
        ...base,
        AGENT_ROUTING_POLICY: JSON.stringify({
          primary: "local",
          fallback: "local",
        }),
      }),
    ).toThrow("must differ");
  });
});

describe("registro do routed", () => {
  test("sem política não existe provedor sintético", () => {
    const cheap = fakeProvider("cheap");
    expect(
      createRoutedProvider({
        policy: undefined,
        providers: [cheap],
        configs: mutableConfigs(),
      }),
    ).toBeUndefined();
  });

  test("fallback não construído não registra o routed", () => {
    const cheap = fakeProvider("cheap");
    expect(
      createRoutedProvider({
        policy: { primary: "cheap", fallback: "strong" },
        providers: [cheap],
        configs: mutableConfigs(),
      }),
    ).toBeUndefined();
  });

  test("vive sob o id routed sem virar padrão", () => {
    const routed = createRoutedProvider({
      policy: { primary: "cheap", fallback: "strong" },
      providers: [fakeProvider("cheap"), fakeProvider("strong")],
      configs: mutableConfigs(),
    });
    expect(routed?.id).toBe(ROUTED_PROVIDER_ID);
  });
});

describe("seleção de candidatos", () => {
  test("modo fixo: primário compatível conduz", () => {
    const cheap = fakeProvider("cheap", { capabilities: { vision: false } });
    const strong = fakeProvider("strong");
    const candidates = {
      primary: { provider: cheap, model: "cheap-model" },
      fallback: { provider: strong, model: "strong-model" },
    };
    expect(selectRoutedCandidate(candidates, stepInput()).provider.id).toBe(
      "cheap",
    );
  });

  test("visão incompatível pula o primário para o fallback elegível", () => {
    const cheap = fakeProvider("cheap", { capabilities: { vision: false } });
    const strong = fakeProvider("strong");
    const candidates = {
      primary: { provider: cheap, model: "cheap-model" },
      fallback: { provider: strong, model: "strong-model" },
    };
    expect(
      selectRoutedCandidate(candidates, withImage(stepInput())).provider.id,
    ).toBe("strong");
  });

  test("sem candidato compatível informa indisponibilidade sem trocar em silêncio", () => {
    const cheap = fakeProvider("cheap", { capabilities: { tools: false } });
    const candidates = {
      primary: { provider: cheap, model: "cheap-model" },
    };
    expect(() =>
      selectRoutedCandidate(candidates, withTools(stepInput())),
    ).toThrow(ProviderRejectedError);
  });

  test("modelo explícito em conflito é rejeitado, nunca substituído", () => {
    const cheap = fakeProvider("cheap");
    const strong = fakeProvider("strong");
    const candidates = {
      primary: { provider: cheap, model: "cheap-model" },
      fallback: { provider: strong, model: "strong-model" },
    };
    expect(() =>
      selectRoutedCandidate(candidates, stepInput({ model: "outro-modelo" })),
    ).toThrow(/conflicts with the configured routing policy/);
  });

  test("modelo explícito do fallback prende a decisão nele", () => {
    const cheap = fakeProvider("cheap");
    const strong = fakeProvider("strong");
    const candidates = {
      primary: { provider: cheap, model: "cheap-model" },
      fallback: { provider: strong, model: "strong-model" },
    };
    expect(
      selectRoutedCandidate(candidates, stepInput({ model: "strong-model" }))
        .provider.id,
    ).toBe("strong");
  });
});

describe("execução roteada", () => {
  test("sucesso do primário relata uma tentativa com a identidade real", async () => {
    const calls: string[] = [];
    const routed = createRoutedProvider({
      policy: { primary: "cheap", fallback: "strong" },
      providers: [
        fakeProvider("cheap", { calls, capabilities: { vision: false } }),
        fakeProvider("strong", { calls }),
      ],
      configs: mutableConfigs(),
    });
    const attempts: ModelAttemptUsage[] = [];
    const result = await routed?.run(stepInput(), {
      signal: new AbortController().signal,
      onAttempt: (usage) => attempts.push(usage),
    });
    expect(result?.kind).toBe("final");
    expect(calls).toEqual(["cheap"]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      provider: "cheap",
      model: "cheap-model",
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  test("falha retentável escala uma vez e mantém o fallback nos passos seguintes", async () => {
    const calls: string[] = [];
    const routed = createRoutedProvider({
      policy: { primary: "cheap", fallback: "strong" },
      providers: [
        fakeProvider("cheap", {
          calls,
          failWith: retryable(),
          capabilities: { vision: false },
        }),
        fakeProvider("strong", { calls }),
      ],
      configs: mutableConfigs(),
    });
    const attempts: ModelAttemptUsage[] = [];
    const context = {
      signal: new AbortController().signal,
      onAttempt: (usage: ModelAttemptUsage) => attempts.push(usage),
    };
    const result = await routed?.run(stepInput(), context);
    expect(result?.kind).toBe("final");
    expect(calls).toEqual(["cheap", "strong"]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ provider: "cheap", inputTokens: null });
    expect(attempts[1]).toMatchObject({
      provider: "strong",
      model: "strong-model",
    });

    // Retomada: o fallback consta em usage.attempts, o primário nem é chamado.
    const retomada: string[] = [];
    const routedResumido = createRoutedProvider({
      policy: { primary: "cheap", fallback: "strong" },
      providers: [
        fakeProvider("cheap", {
          calls: retomada,
          capabilities: { vision: false },
        }),
        fakeProvider("strong", { calls: retomada }),
      ],
      configs: mutableConfigs(),
    });
    await routedResumido?.run(stepInput({ usage: stepInput().usage }), {
      signal: new AbortController().signal,
    });
    // Sem histórico persistido de fallback, o primário volta a conduzir: prova do
    // mecanismo às avessas — e com o histórico, ele é pulado (abaixo).
    expect(retomada).toEqual(["cheap"]);

    const diretoAoFallback: string[] = [];
    const routedPersistido = createRoutedProvider({
      policy: { primary: "cheap", fallback: "strong" },
      providers: [
        fakeProvider("cheap", {
          calls: diretoAoFallback,
          capabilities: { vision: false },
        }),
        fakeProvider("strong", { calls: diretoAoFallback }),
      ],
      configs: mutableConfigs(),
    });
    await routedPersistido?.run(
      stepInput({
        usage: { steps: 1, activeMs: 1, modelCalls: 2, toolCalls: 0, attempts },
      }),
      { signal: new AbortController().signal },
    );
    expect(diretoAoFallback).toEqual(["strong"]);
  });

  test("fallback esgotado relata as duas tentativas e devolve o erro dele", async () => {
    const routed = createRoutedProvider({
      policy: { primary: "cheap", fallback: "strong" },
      providers: [
        fakeProvider("cheap", { failWith: retryable("primário caiu") }),
        fakeProvider("strong", { failWith: retryable("fallback caiu") }),
      ],
      configs: mutableConfigs(),
    });
    const attempts: ModelAttemptUsage[] = [];
    await expect(
      routed?.run(stepInput(), {
        signal: new AbortController().signal,
        onAttempt: (usage) => attempts.push(usage),
      }),
    ).rejects.toThrow("fallback caiu");
    expect(attempts.map((attempt) => attempt.provider)).toEqual([
      "cheap",
      "strong",
    ]);
  });

  test("cancelamento não escala e relata só a tentativa feita", async () => {
    const calls: string[] = [];
    const routed = createRoutedProvider({
      policy: { primary: "cheap", fallback: "strong" },
      providers: [
        fakeProvider("cheap", { calls, failWith: retryable() }),
        fakeProvider("strong", { calls }),
      ],
      configs: mutableConfigs(),
    });
    const controller = new AbortController();
    controller.abort();
    const attempts: ModelAttemptUsage[] = [];
    await expect(
      routed?.run(stepInput(), {
        signal: controller.signal,
        onAttempt: (usage) => attempts.push(usage),
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(["cheap"]);
    expect(attempts).toHaveLength(1);
  });

  test("recusa do provedor não escala", async () => {
    const calls: string[] = [];
    const routed = createRoutedProvider({
      policy: { primary: "cheap", fallback: "strong" },
      providers: [
        fakeProvider("cheap", {
          calls,
          failWith: new ProviderRejectedError("modelo recusou o pedido"),
        }),
        fakeProvider("strong", { calls }),
      ],
      configs: mutableConfigs(),
    });
    await expect(
      routed?.run(stepInput(), { signal: new AbortController().signal }),
    ).rejects.toThrow("modelo recusou");
    expect(calls).toEqual(["cheap"]);
  });
});

describe("catálogo do routed", () => {
  test("anuncia os modelos reais sem ser padrão nem prometer visão alheia", () => {
    const entries = routedCatalogEntries({
      policy: { primary: "cheap", fallback: "strong" },
      providers: [
        fakeProvider("cheap", { capabilities: { vision: false } }),
        fakeProvider("strong"),
      ],
      configs: mutableConfigs(),
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.model).sort()).toEqual([
      "cheap-model",
      "strong-model",
    ]);
    for (const entry of entries) {
      expect(entry.id).toBe(ROUTED_PROVIDER_ID);
      expect(entry.default).toBe(false);
    }
    expect(
      entries.find((entry) => entry.model === "cheap-model")?.capabilities
        .vision,
    ).toBe(false);
    expect(
      entries.find((entry) => entry.model === "strong-model")?.capabilities
        .vision,
    ).toBe(true);
  });
});
