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
});
