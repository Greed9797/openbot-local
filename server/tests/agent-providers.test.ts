/**
 * O que cada adaptador manda no fio.
 *
 * O teste que o PRD chama de decisivo é este: o payload preserva a modalidade da imagem. Não basta o
 * adaptador "aceitar" uma imagem — ela tem de chegar como bloco de imagem, no formato daquele
 * provedor, e um modelo marcado sem visão não pode recebê-la de forma nenhuma. O `fetch` é um dublê
 * que guarda o corpo enviado; nada sai para a internet.
 */
import { describe, expect, test } from "bun:test";
import type { AgentRunInput, ModelCapabilities } from "../src/agent-runtime/contracts";
import {
  createAnthropicProvider,
} from "../src/agent-runtime/providers/anthropic";
import {
  createOpenAICompatibleProvider,
} from "../src/agent-runtime/providers/openai-compatible";
import {
  createOpenAIResponsesProvider,
} from "../src/agent-runtime/providers/openai-responses";
import {
  createCodexDelegatedProvider,
} from "../src/agent-runtime/providers/codex-delegated";
import {
  createGeminiProvider,
} from "../src/agent-runtime/providers/gemini";
import {
  mintRunAssertion,
  readRunAssertion,
} from "../src/agents/callback-token";
import {
  postJson,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "../src/agent-runtime/providers/http";

const IMAGE_DATA = "QUJD";

/** A chave do deployment nestes testes: só existe aqui dentro. */
const KEY = "chave-de-teste";

function capabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { vision: true, tools: true, streaming: false, mode: "step", ...overrides };
}

function input(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: "run-1",
    botId: "bot-1",
    objective: "Preencher o formulário de produto.",
    observation: {
      observationId: "obs-1",
      runId: "run-1",
      url: "https://exemplo.test/form",
      title: "Produto",
      text: "Nome do produto",
      truncated: false,
      elements: [{ ref: "e1", role: "textbox", name: "Nome" }],
      snapshotId: 4,
      viewport: { width: 1280, height: 800 },
      capturedAt: "2026-09-11T10:00:00.000Z",
      control: { holder: "bot", secretPending: false },
      images: [
        {
          artifactId: "artifact-1",
          mime: "image/png",
          width: 1280,
          height: 800,
          capturedAt: "2026-09-11T10:00:00.000Z",
          protected: false,
          data: IMAGE_DATA,
        },
      ],
      redactions: 0,
      textOnly: false,
    },
    history: [{ seq: 1, kind: "observation", summary: "observation → ok" }],
    tools: [
      {
        name: "click",
        description: "Clica em um elemento.",
        parameters: {
          type: "object",
          properties: { ref: { type: "string" } },
          required: ["ref"],
        },
      },
    ],
    budget: { maxSteps: 40, maxMs: 900_000, maxCorrections: 2 },
    usage: { steps: 1, modelCalls: 1, toolCalls: 0, activeMs: 1_000 },
    capabilities: capabilities(),
    ...overrides,
  };
}

/** Um fetch de mentira que responde o que o teste mandar e guarda o que foi enviado. */
function capture(response: unknown, status = 200) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const context = {
  signal: new AbortController().signal,
};

/** O corpo enviado, ou uma falha clara: um teste que não enviou nada não provou nada. */
function bodyOf(sent: { url: string; body: Record<string, unknown> }[]): Record<string, unknown> {
  const body = sent[0]?.body;
  if (!body) throw new Error("Nenhuma chamada foi enviada ao provedor.");
  return body;
}

function urlOf(sent: { url: string }[]): string {
  const url = sent[0]?.url;
  if (!url) throw new Error("Nenhuma chamada foi enviada ao provedor.");
  return url;
}

describe("OpenAI Responses", () => {
  test("manda instruções, ferramentas e o bloco de imagem", async () => {
    const { sent, fetchImpl } = capture({
      output: [
        {
          type: "function_call",
          name: "click",
          arguments: '{"ref":"e1"}',
          call_id: "call-1",
        },
      ],
    });
    const withFetch = createOpenAIResponsesProvider({
      model: "gpt-5.5",
      apiKey: "chave",
      capabilities: capabilities(),
      fetchImpl,
    });
    const decision = await withFetch.run(input(), context);

    expect(decision.kind).toBe("tool_call");
    if (decision.kind !== "tool_call") return;
    expect(decision.call.name).toBe("click");
    expect(decision.call.arguments).toEqual({ ref: "e1" });

    const body = bodyOf(sent);
    expect(urlOf(sent)).toBe("https://api.openai.com/v1/responses");
    expect(body.model).toBe("gpt-5.5");
    expect(body.store).toBe(false);
    expect(String(body.instructions)).toContain("formulário de produto");
    const message = (body.input as Record<string, unknown>[])[0];
    expect(message?.role).toBe("user");
    const parts = message?.content as Record<string, unknown>[];
    expect(parts[0]).toMatchObject({ type: "input_text" });
    expect(parts[1]).toEqual({
      type: "input_image",
      image_url: `data:image/png;base64,${IMAGE_DATA}`,
      detail: "high",
    });
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ type: "function", name: "click" });
  });

  test("um modelo sem visão não recebe imagem nenhuma", async () => {
    const { sent, fetchImpl } = capture({ output: [] });
    const withFetch = createOpenAIResponsesProvider({
      model: "gpt-5-nano",
      apiKey: "chave",
      capabilities: capabilities({ vision: false }),
      fetchImpl,
    });
    await withFetch.run(input({ capabilities: capabilities({ vision: false }) }), context);
    expect(JSON.stringify(bodyOf(sent))).not.toContain(IMAGE_DATA);
    expect(JSON.stringify(bodyOf(sent))).not.toContain("input_image");
  });

  test("uma resposta sem nada é inválida, não um sucesso", async () => {
    const { fetchImpl } = capture({ output: [] });
    const withFetch = createOpenAIResponsesProvider({
      model: "gpt-5.5",
      apiKey: "chave",
      capabilities: capabilities(),
      fetchImpl,
    });
    const decision = await withFetch.run(input(), context);
    expect(decision.kind).toBe("invalid");
  });
});

describe("Anthropic", () => {
  test("a imagem viaja como bloco image com fonte base64", async () => {
    const { sent, fetchImpl } = capture({
      content: [
        { type: "text", text: "Vou clicar." },
        { type: "tool_use", id: "toolu_1", name: "click", input: { ref: "e1" } },
      ],
    });
    const provider = createAnthropicProvider({
      model: "claude-sonnet-4-5",
      apiKey: "chave",
      capabilities: capabilities(),
      fetchImpl,
    });
    const decision = await provider.run(input(), context);

    expect(decision.kind).toBe("tool_call");
    const body = bodyOf(sent);
    expect(urlOf(sent)).toBe("https://api.anthropic.com/v1/messages");
    expect(body.system).toContain("formulário de produto");
    const content = (body.messages as Record<string, unknown>[])[0]
      ?.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: IMAGE_DATA,
      },
    });
  });

  test("texto sem ferramenta é a conclusão da tarefa", async () => {
    const { fetchImpl } = capture({
      content: [{ type: "text", text: "O formulário tem 14 campos." }],
    });
    const provider = createAnthropicProvider({
      model: "claude-sonnet-4-5",
      apiKey: "chave",
      capabilities: capabilities(),
      fetchImpl,
    });
    const decision = await provider.run(input(), context);
    expect(decision).toMatchObject({
      kind: "final",
      message: "O formulário tem 14 campos.",
    });
  });
});

describe("OpenAI-compatible", () => {
  test("um modelo local com visão recebe a imagem como data URL", async () => {
    const { sent, fetchImpl } = capture({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "click", arguments: '{"ref":"e1"}' },
              },
            ],
          },
        },
      ],
    });
    const provider = createOpenAICompatibleProvider({
      model: "qwen2.5-vl",
      baseUrl: "http://127.0.0.1:11434/v1",
      capabilities: capabilities(),
      fetchImpl,
    });
    const decision = await provider.run(input(), context);

    expect(decision.kind).toBe("tool_call");
    const body = bodyOf(sent);
    expect(urlOf(sent)).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const content = (body.messages as Record<string, unknown>[])[1]
      ?.content as Record<string, unknown>[];
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${IMAGE_DATA}` },
    });
  });

  test("um modelo sem ferramentas nativas recebe o catálogo no texto e responde JSON", async () => {
    const { sent, fetchImpl } = capture({
      choices: [
        {
          message: {
            role: "assistant",
            content: '{"tool":"click","arguments":{"ref":"e1"}}',
          },
        },
      ],
    });
    const provider = createOpenAICompatibleProvider({
      model: "llama3.1",
      baseUrl: "http://127.0.0.1:11434/v1",
      capabilities: capabilities({ tools: false }),
      fetchImpl,
    });
    const decision = await provider.run(
      input({ capabilities: capabilities({ tools: false }) }),
      context,
    );

    expect(decision.kind).toBe("tool_call");
    const body = bodyOf(sent);
    expect(body.tools).toBeUndefined();
    const content = (body.messages as Record<string, unknown>[])[1]
      ?.content as Record<string, unknown>[];
    expect(String(content[0]?.text)).toContain("Ferramentas disponíveis");
    expect(String(content[0]?.text)).toContain('"tool":"nome"');
  });

  test("um JSON quebrado é uma decisão inválida, não uma ação", async () => {
    const { fetchImpl } = capture({
      choices: [{ message: { role: "assistant", content: "claro, vou clicar" } }],
    });
    const provider = createOpenAICompatibleProvider({
      model: "llama3.1",
      baseUrl: "http://127.0.0.1:11434/v1",
      capabilities: capabilities({ tools: false }),
      fetchImpl,
    });
    const decision = await provider.run(
      input({ capabilities: capabilities({ tools: false }) }),
      context,
    );
    expect(decision.kind).toBe("invalid");
  });

  test("uma ferramenta desconhecida no JSON também é inválida", async () => {
    const { fetchImpl } = capture({
      choices: [
        { message: { role: "assistant", content: '{"tool":"exec","arguments":{}}' } },
      ],
    });
    const provider = createOpenAICompatibleProvider({
      model: "llama3.1",
      baseUrl: "http://127.0.0.1:11434/v1",
      capabilities: capabilities({ tools: false }),
      fetchImpl,
    });
    const decision = await provider.run(
      input({ capabilities: capabilities({ tools: false }) }),
      context,
    );
    expect(decision.kind).toBe("invalid");
    if (decision.kind !== "invalid") return;
    expect(decision.error).toContain("exec");
  });
});

describe("erros de provedor", () => {
  test("uma recusa não é retentável", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 404,
      })) as unknown as typeof fetch;
    const failure = await postJson({
      url: "https://api.test/v1/x",
      headers: {},
      body: {},
      timeoutMs: 1_000,
      fetchImpl,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderRejectedError);
    expect((failure as ProviderRejectedError).retryable).toBe(false);
    expect((failure as Error).message).toContain("model not found");
  });

  test("um 500 e um 429 são retentáveis", async () => {
    for (const status of [500, 429]) {
      const fetchImpl = (async () =>
        new Response("boom", { status })) as unknown as typeof fetch;
      const failure = await postJson({
        url: "https://api.test/v1/x",
        headers: {},
        body: {},
        timeoutMs: 1_000,
        fetchImpl,
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).retryable).toBe(true);
    }
  });

  test("um servidor fora do ar é indisponível", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const failure = await postJson({
      url: "https://api.test/v1/x",
      headers: {},
      body: {},
      timeoutMs: 1_000,
      fetchImpl,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
  });
});

/**
 * O Codex delegado, no fio.
 *
 * Este adaptador não tinha teste de fio, e a falta apareceu no primeiro deploy real: o runtime levava
 * 401 do próprio serviço do Codex, porque o cabeçalho que aquele serviço exige nunca era enviado. A
 * tarefa falhava com PROVIDER_UNAVAILABLE e o motivo não estava no lugar que ele apontava.
 *
 * O que se prova aqui: o pedido chega com `x-openbot-agent-token` quando há token, chega sem ele
 * quando não há, e um fluxo AG-UI bem formado vira a resposta delegada de sempre.
 */
describe("Codex delegado", () => {
  /** Um fluxo AG-UI mínimo, com um texto e o fim do run. */
  function streamOf(text: string, declaredTools?: number): Response {
    const events = [
      { type: "RUN_STARTED", threadId: "t", runId: "run-1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: text },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      ...(declaredTools === undefined
        ? []
        : [
            {
              type: "CUSTOM",
              name: "openbot.tools",
              value: { count: declaredTools },
            },
          ]),
      { type: "RUN_FINISHED", threadId: "t", runId: "run-1" },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  async function call(
    options: { token?: string; text?: string; declaredTools?: number },
  ): Promise<{ headers: Headers; body: unknown; result: unknown }> {
    let seen: Headers | undefined;
    let body: unknown;
    const provider = createCodexDelegatedProvider({
      id: "codex",
      endpoint: "http://agent-codex.test/ag-ui",
      model: "codex default",
      ...(options.token ? { token: options.token } : {}),
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return streamOf(
          options.text ?? "Abri a página e li o título.",
          options.declaredTools,
        );
      }) as unknown as typeof fetch,
    });
    const result = await provider.run(input(), {
      signal: new AbortController().signal,
    });
    if (!seen) throw new Error("o provedor não chegou a falar com o serviço");
    return { headers: seen, body, result };
  }

  test("o pedido leva o token do Bot gerenciado", async () => {
    const { headers, result } = await call({ token: "token-do-deployment" });
    expect(headers.get("x-openbot-agent-token")).toBe("token-do-deployment");
    expect(result).toMatchObject({
      kind: "delegated",
      message: "Abri a página e li o título.",
    });
  });

  test("sem token configurado, o cabeçalho não vai", async () => {
    const { headers } = await call({});
    expect(headers.get("x-openbot-agent-token")).toBeNull();
  });

  /**
   * O CLI conta as ferramentas dele porque ninguém mais pode contá-las.
   *
   * Um agente delegado conduz o próprio laço: as chamadas de ferramenta dele não passam por este
   * processo, e sem a declaração o run fechava dizendo `tools: 0` depois de ter aberto página,
   * clicado e lido — a mesma resposta que um turno que não usou ferramenta nenhuma.
   */
  test("as ferramentas declaradas pelo serviço chegam ao run", async () => {
    const { result } = await call({ declaredTools: 7 });
    expect(result).toMatchObject({ toolCalls: 7, evidence: { tools: 7 } });
  });

  test("declaração menor não apaga o que o fluxo já contou", async () => {
    const provider = createCodexDelegatedProvider({
      endpoint: "http://agent-codex.test/ag-ui",
      model: "codex default",
      fetchImpl: (async () => {
        const events = [
          { type: "RUN_STARTED", threadId: "t", runId: "run-1" },
          { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "computer" },
          { type: "TOOL_CALL_END", toolCallId: "c1" },
          { type: "TOOL_CALL_START", toolCallId: "c2", toolCallName: "computer" },
          { type: "TOOL_CALL_END", toolCallId: "c2" },
          { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "pronto" },
          { type: "TEXT_MESSAGE_END", messageId: "m1" },
          { type: "CUSTOM", name: "openbot.tools", value: { count: 1 } },
          { type: "RUN_FINISHED", threadId: "t", runId: "run-1" },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }) as unknown as typeof fetch,
    });
    const result = await provider.run(input(), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ toolCalls: 2, evidence: { tools: 2 } });
  });

  test("o objetivo vai no corpo, com o que já aconteceu", async () => {
    const { body } = await call({ text: "tudo certo" });
    const payload = body as { messages?: { content?: string }[] };
    expect(JSON.stringify(payload)).toContain("Preencher o formulário de produto.");
  });
});

/**
 * A declaração de execução no pedido delegado.
 *
 * O serviço do Codex entrega esta declaração ao servidor MCP, que a devolve em cada chamada de
 * ferramenta — é dela que saem o Bot e a pessoa da linha de auditoria. O primeiro run delegado de
 * verdade mostrou o custo de não mandá-la: o servidor MCP saía no boot, o `codex exec` terminava em
 * erro e a tarefa morria sem ter aberto página nenhuma.
 */
describe("Codex delegado > declaração de execução", () => {
  /** O corpo que o pedido levou, com um fluxo AG-UI de resposta. */
  async function requestBody(
    options: {
      signRun?: (run: { botId: string; runId: string; actorId: string }) => string;
      run?: Partial<AgentRunInput>;
    } = {},
  ): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    const provider = createCodexDelegatedProvider({
      endpoint: "http://agent-codex.test/ag-ui",
      model: "codex default",
      token: "t",
      ...(options.signRun ? { signRun: options.signRun } : {}),
      // O transporte do cliente só aceita um Response; o corpo que importa é o do pedido.
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          [
            { type: "RUN_STARTED", threadId: "run-1", runId: "run-1" },
            { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
            { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "pronto" },
            { type: "TEXT_MESSAGE_END", messageId: "m1" },
            { type: "RUN_FINISHED", threadId: "run-1", runId: "run-1" },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }) as unknown as typeof fetch,
    });

    await provider
      .run(input(options.run ?? {}), { signal: new AbortController().signal })
      .catch(() => {});
    return body;
  }

  test("o pedido leva a declaração que este deployment assina", async () => {
    const body = await requestBody({
      signRun: ({ botId, runId, actorId }) =>
        mintRunAssertion({ botId, actorId, runId }, KEY),
      run: { actorId: "pessoa-1" },
    });

    const forwarded = body.forwardedProps as { openbotRun?: string };
    expect(typeof forwarded.openbotRun).toBe("string");
    // Exatamente o que o servidor MCP faz do outro lado: abre com a chave do deployment.
    expect(readRunAssertion(forwarded.openbotRun, KEY)).toEqual({
      botId: "bot-1",
      actorId: "pessoa-1",
      runId: "run-1",
    });
  });

  test("sem assinante, o pedido não leva declaração nenhuma", async () => {
    const body = await requestBody({ run: { actorId: "pessoa-1" } });
    expect(body.forwardedProps).not.toHaveProperty("openbotRun");
  });

  test("tarefa sem dono não vira declaração de ninguém", async () => {
    const body = await requestBody({ signRun: () => "nunca chamado" });
    expect(body.forwardedProps).not.toHaveProperty("openbotRun");
  });
});

/**
 * O turno que o serviço recusou.
 *
 * O cliente AG-UI encerra o fluxo sem erro quando recebe `RUN_ERROR`, e o adaptador — que só olhava
 * texto — transformava a recusa num "terminou sem texto". A causa que a pessoa lia na tarefa era
 * `INVALID_ACTION`, e o motivo real (cota esgotada, modelo inexistente) não aparecia em lugar
 * nenhum. Agora ele é o erro do run.
 */
describe("Codex delegado > turno recusado", () => {
  test("o motivo do serviço vira o erro da tarefa", async () => {
    const provider = createCodexDelegatedProvider({
      endpoint: "http://agent-codex.test/ag-ui",
      model: "codex default",
      token: "t",
      fetchImpl: (async () =>
        new Response(
          [
            { type: "RUN_STARTED", threadId: "run-1", runId: "run-1" },
            {
              type: "RUN_ERROR",
              message:
                "You've hit your usage limit. Try again at Sep 15th, 2026 2:05 AM.",
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    });

    const failure = await provider
      .run(input({ actorId: "pessoa-1" }), {
        signal: new AbortController().signal,
      })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect((failure as Error).message).toContain("usage limit");
  });

  test("o silêncio sem recusa continua sendo silêncio", async () => {
    const provider = createCodexDelegatedProvider({
      endpoint: "http://agent-codex.test/ag-ui",
      model: "codex default",
      token: "t",
      fetchImpl: (async () =>
        new Response(
          [
            { type: "RUN_STARTED", threadId: "run-1", runId: "run-1" },
            { type: "RUN_FINISHED", threadId: "run-1", runId: "run-1" },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    });

    const result = await provider.run(input({}), {
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe("invalid");
  });
});

/**
 * O Gemini, no fio.
 *
 * As duas coisas que este adaptador existe para fazer e que um teste de unidade frouxo deixaria
 * passar: a imagem chega como bytes (`inlineData`), nunca como texto, e a chamada de ferramenta é
 * lida de dentro das partes, com os argumentos já em JSON.
 */
describe("Gemini", () => {
  test("o pedido leva instruções, ferramentas e a imagem como bytes", async () => {
    const { sent, fetchImpl } = capture({
      candidates: [{ content: { parts: [{ text: "pronto" }] }, finishReason: "STOP" }],
    });
    await createGeminiProvider({
      model: "gemini-3.8-flash",
      apiKey: "chave-gemini",
      capabilities: capabilities(),
      fetchImpl,
    }).run(input(), context);

    expect(sent[0]?.url).toContain(
      "/v1beta/models/gemini-3.8-flash:generateContent",
    );
    const body = bodyOf(sent);
    expect(JSON.stringify(body.systemInstruction)).toContain("Você");
    const parts = (
      (body.contents as { parts: Record<string, unknown>[] }[])[0] as {
        parts: Record<string, unknown>[];
      }
    ).parts;
    expect(String(parts[0]?.text)).toContain("Preencher o formulário de produto.");
    expect(parts[1]?.inlineData).toEqual({
      mimeType: "image/png",
      data: IMAGE_DATA,
    });
    const declarations = (
      (body.tools as { functionDeclarations: Record<string, unknown>[] }[])[0] as {
        functionDeclarations: Record<string, unknown>[];
      }
    ).functionDeclarations;
    expect(declarations[0]?.name).toBe("click");
    expect(declarations[0]?.parameters).toEqual(
      (input().tools[0] as { parameters: unknown }).parameters,
    );
  });

  test("um modelo sem visão não recebe imagem nenhuma", async () => {
    const { sent, fetchImpl } = capture({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });
    await createGeminiProvider({
      model: "gemini-3.8-flash",
      apiKey: "chave-gemini",
      capabilities: capabilities({ vision: false }),
      fetchImpl,
    }).run(input({ capabilities: capabilities({ vision: false }) }), context);

    const parts = (
      (bodyOf(sent).contents as { parts: Record<string, unknown>[] }[])[0] as {
        parts: Record<string, unknown>[];
      }
    ).parts;
    expect(parts).toHaveLength(1);
    expect(JSON.stringify(parts)).not.toContain(IMAGE_DATA);
  });

  test("a chamada de ferramenta vira a decisão do passo", async () => {
    const { fetchImpl } = capture({
      candidates: [
        {
          content: {
            parts: [
              { text: "Vou clicar." },
              {
                functionCall: {
                  name: "click",
                  args: { ref: "e1" },
                  id: "fc-1",
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });

    const result = await createGeminiProvider({
      model: "gemini-3.8-flash",
      apiKey: "chave-gemini",
      capabilities: capabilities(),
      fetchImpl,
    }).run(input(), context);

    expect(result.kind).toBe("tool_call");
    expect(
      (result as { call: { name: string; arguments: unknown; callId?: string } }).call,
    ).toEqual({ name: "click", arguments: { ref: "e1" }, callId: "fc-1" });
  });

  test("texto sem ferramenta é a tarefa dada por concluída", async () => {
    const { fetchImpl } = capture({
      candidates: [
        {
          content: { parts: [{ text: "O relatório foi baixado." }] },
          finishReason: "STOP",
        },
      ],
    });

    const result = await createGeminiProvider({
      model: "gemini-3.8-flash",
      apiKey: "chave-gemini",
      capabilities: capabilities(),
      fetchImpl,
    }).run(input(), context);

    expect(result).toEqual({ kind: "final", message: "O relatório foi baixado." });
  });

  test("bloqueio de conteúdo é dito com o motivo, não como resposta vazia", async () => {
    const { fetchImpl } = capture({
      promptFeedback: {
        blockReason: "SAFETY",
        blockReasonMessage: "Pedido bloqueado por política.",
      },
    });

    const result = await createGeminiProvider({
      model: "gemini-3.8-flash",
      apiKey: "chave-gemini",
      capabilities: capabilities(),
      fetchImpl,
    }).run(input(), context);

    expect(result.kind).toBe("invalid");
    expect((result as { error: string }).error).toContain("SAFETY");
  });

  test("uma recusa do provedor não é resposta vazia", async () => {
    const { fetchImpl } = capture({ error: { message: "model not found" } }, 404);
    const failure = await createGeminiProvider({
      model: "gemini-inexistente",
      apiKey: "chave-gemini",
      capabilities: capabilities(),
      fetchImpl,
    })
      .run(input(), context)
      .catch((error) => error);

    expect(failure).toBeInstanceOf(ProviderRejectedError);
    expect((failure as Error).message).toContain("model not found");
  });

  test("sem chave, o adaptador diz isso em vez de chamar a API", async () => {
    const failure = await createGeminiProvider({
      model: "gemini-3.8-flash",
      apiKey: "",
      capabilities: capabilities(),
    })
      .run(input(), context)
      .catch((error) => error);

    expect(failure).toBeInstanceOf(ProviderRejectedError);
  });
});
