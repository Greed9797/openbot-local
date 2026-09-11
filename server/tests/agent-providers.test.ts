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
  postJson,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "../src/agent-runtime/providers/http";

const IMAGE_DATA = "QUJD";

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
