import { describe, expect, test } from "bun:test";

/*
 * As credenciais têm de existir antes do import: o módulo sai com código 1 sem elas, e um teste que
 * derruba o processo de teste não reporta nada.
 */
process.env.OPENBOT_AGENT_TOKEN ??= "token-de-teste";
process.env.OPENBOT_RUN ??= "declaracao-de-teste";
process.env.OPENBOT_BOT_ID ??= "self";

const { tools, handle } = await import("../src/mcp-computer");

/** Captura o que o servidor escreveria em stdout. */
function capture() {
  const written: unknown[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: substituição de stdout só para o teste.
  (process.stdout as any).write = (chunk: string) => {
    written.push(JSON.parse(String(chunk)));
    return true;
  };
  return {
    written,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restaura o original.
      (process.stdout as any).write = original;
    },
  };
}

async function ask(message: Record<string, unknown>) {
  const sink = capture();
  try {
    await handle(message);
    return sink.written;
  } finally {
    sink.restore();
  }
}

/**
 * O aperto de mão é o que decide se o Codex vê alguma ferramenta.
 *
 * Errar aqui não dá erro: o servidor sobe, o Codex não recebe nada e o Bot simplesmente responde que
 * não consegue abrir páginas — o mesmo sintoma de não ter MCP nenhum.
 */
describe("aperto de mão MCP", () => {
  test("responde initialize anunciando ferramentas", async () => {
    const [reply] = (await ask({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    })) as { result: { capabilities: unknown; protocolVersion: string } }[];

    expect(reply.result.capabilities).toEqual({ tools: {} });
    expect(reply.result.protocolVersion).toBe("2024-11-05");
  });

  test("não responde a notificação, que não tem id", async () => {
    expect(
      await ask({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toEqual([]);
  });

  test("lista as ferramentas com o schema que o modelo lê", async () => {
    const [reply] = (await ask({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as { result: { tools: { name: string; inputSchema: unknown }[] } }[];

    const names = reply.result.tools.map((tool) => tool.name);
    expect(names).toContain("abrir_pagina");
    expect(names).toContain("mapear_pagina");
    expect(names).toContain("clicar");
    for (const tool of reply.result.tools) {
      expect(tool.inputSchema).toHaveProperty("type", "object");
    }
  });

  test("ferramenta desconhecida vira erro de protocolo, não silêncio", async () => {
    const [reply] = (await ask({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "voar", arguments: {} },
    })) as { error?: { message: string } }[];

    expect(reply.error?.message).toContain("voar");
  });
});

/**
 * Clicar sem o par ref/snapshotId é recusado pelo servidor, então o schema tem de exigir os dois.
 * Um schema frouxo aqui vira o modelo chutando um ref e levando 400 em silêncio.
 */
describe("contrato das ferramentas", () => {
  test("clicar e digitar exigem ref e snapshotId", () => {
    for (const name of ["clicar", "digitar"]) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as {
        required: string[];
      };
      expect(schema.required).toContain("ref");
      expect(schema.required).toContain("snapshotId");
    }
  });

  test("abrir_pagina exige a url", () => {
    const schema = tools.find((tool) => tool.name === "abrir_pagina")
      ?.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["url"]);
  });

  test("escolher_opcao exige ref, snapshotId e value", () => {
    const schema = tools.find((tool) => tool.name === "escolher_opcao")
      ?.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["ref", "snapshotId", "value"]);
  });

  test("pedir_ajuda exige o motivo", () => {
    const schema = tools.find((tool) => tool.name === "pedir_ajuda")
      ?.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["motivo"]);
  });
});

/**
 * A imagem, que era o buraco apontado pela auditoria.
 *
 * O protocolo aceita resultado de imagem; o que faltava era devolvê-lo. Um teste que só olhasse o
 * nome da ferramenta passaria com o bridge mandando base64 como texto, que é exatamente o estado
 * anterior — por isso a asserção é sobre o formato do conteúdo.
 */
describe("a captura chega como imagem", () => {
  test("ver_a_tela devolve conteúdo image com o mime, e os metadados em texto", async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          base64: "aVZCT1J3MEtHZ29B",
          width: 1280,
          height: 800,
          capturedAt: "2026-09-11T10:00:00.000Z",
          url: "https://exemplo.test/form",
          masked: 2,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const [reply] = (await ask({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "ver_a_tela", arguments: {} },
      })) as {
        result: { content: { type: string; data?: string; mimeType?: string; text?: string }[] };
      }[];

      expect(reply.result.content[0]).toEqual({
        type: "image",
        data: "aVZCT1J3MEtHZ29B",
        mimeType: "image/png",
      });
      const metadata = JSON.parse(String(reply.result.content[1]?.text));
      expect(metadata).toEqual({
        url: "https://exemplo.test/form",
        width: 1280,
        height: 800,
        capturadaEm: "2026-09-11T10:00:00.000Z",
        mascarados: 2,
      });
      // O base64 aparece uma vez só, como imagem, e nunca de novo dentro do texto.
      expect(String(reply.result.content[1]?.text)).not.toContain("aVZCT1J3MEtHZ29B");
      expect(calls[0]).toContain("/screenshot");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("uma captura recusada durante um segredo não vira imagem", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "A person is entering a value the assistant must not see.",
          secretPending: true,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      const [reply] = (await ask({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "ver_a_tela", arguments: {} },
      })) as { result: { content: { type: string; text?: string }[] } }[];

      expect(reply.result.content).toHaveLength(1);
      expect(reply.result.content[0]?.type).toBe("text");
      expect(String(reply.result.content[0]?.text)).toContain("must not see");
    } finally {
      globalThis.fetch = original;
    }
  });
});
