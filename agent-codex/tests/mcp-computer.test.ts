import { describe, expect, test } from "bun:test";

/*
 * As credenciais têm de existir antes do import: o módulo sai com código 1 sem elas, e um teste que
 * derruba o processo de teste não reporta nada.
 */
process.env.OPENBOT_AGENT_TOKEN ??= "token-de-teste";
process.env.OPENBOT_RUN ??= "declaracao-de-teste";
process.env.OPENBOT_BOT_ID ??= "self";

const { tools, handle } = await import("../../shared/mcp-computer");

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
        result: {
          content: {
            type: string;
            data?: string;
            mimeType?: string;
            text?: string;
          }[];
        };
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
      expect(String(reply.result.content[1]?.text)).not.toContain(
        "aVZCT1J3MEtHZ29B",
      );
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

/**
 * O preenchimento composto e a leitura rápida pelo MCP do agente.
 *
 * O que se prova aqui é o envelope, não a ferramenta: as duas credenciais viajam nos headers que
 * o servidor confere uma contra a outra, o corpo leva só os argumentos (identidade no corpo seria
 * forjável), e uma recusa da política volta como texto que o modelo lê em vez de derrubar a chamada.
 */
describe("preenchimento e leitura pelo MCP", () => {
  test("preencher_formulario leva as duas credenciais nos headers e só valores no corpo", async () => {
    const original = globalThis.fetch;
    const calls: {
      url: string;
      headers: Record<string, string>;
      body: unknown;
    }[] = [];
    globalThis.fetch = (async (
      url: unknown,
      init?: { headers?: Record<string, string>; body?: string },
    ) => {
      calls.push({
        url: String(url),
        headers: init?.headers ?? {},
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: { filled: [{ label: "Nome", ref: "e1" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const [reply] = (await ask({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "preencher_formulario",
          arguments: { values: [{ label: "Nome", value: "Marina" }] },
        },
      })) as { result: { content: { type: string; text?: string }[] } }[];

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/fill-form");
      expect(calls[0]?.headers["x-openbot-agent-token"]).toBe("token-de-teste");
      expect(calls[0]?.headers["x-openbot-run"]).toBe("declaracao-de-teste");
      expect(calls[0]?.body).toEqual({
        values: [{ label: "Nome", value: "Marina" }],
      });
      expect(String(reply.result.content[0]?.text)).toContain("Nome");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("ler_url_rapido recusado volta como recusa legível, não como erro de protocolo", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: "Ler este endereço exige aprovação.",
          rule: "deny[5]",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const [reply] = (await ask({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "ler_url_rapido",
          arguments: { url: "https://loja.test/interno" },
        },
      })) as {
        result: {
          isError?: boolean;
          content: { type: string; text?: string }[];
        };
      }[];

      const payload = JSON.parse(String(reply.result.content[0]?.text));
      expect(payload).toEqual({
        recusado: true,
        motivo: "Ler este endereço exige aprovação.",
        regra: "deny[5]",
      });
      // Recusa é resposta, não erro: `isError` faria o modelo tratar política como pane.
      expect(reply.result.isError).toBeUndefined();
      // E uma recusa não se repete sozinha: uma chamada ao servidor, uma resposta.
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * Falha operacional não é recusa de política.
 *
 * O bridge transformava todo HTTP não-2xx em `{recusado:true}`. Um 502 do Chromium sem permissão no
 * volume de perfis chegava ao modelo como "a política barrou", e a resposta natural a uma recusa é
 * procurar outro caminho — foi assim que um navegador que não abria virou uma consulta que nunca
 * aconteceu. O contrato agora é: 403 é política, volta como resultado; o resto é `isError`, com a
 * razão do servidor no texto.
 */
describe("falha operacional não vira recusa de política", () => {
  const casos = [
    {
      nome: "EACCES no diretório de perfis, que é filesystem",
      status: 502,
      body: {
        error:
          "launchPersistentContext: EACCES: permission denied, mkdir '/profiles/agent_6436f77c'",
      },
      contem: "EACCES",
    },
    {
      nome: "RobotsBlocked no leitor rápido, que é do motor sem pixels",
      status: 502,
      body: { error: "RobotsBlocked: /status/1 is disallowed by robots.txt" },
      contem: "RobotsBlocked",
    },
    {
      nome: "429 da página, que é limite externo",
      status: 429,
      body: { error: "Too Many Requests" },
      contem: "Too Many Requests",
    },
    {
      nome: "pessoa no controle, que é 409 e não é defeito",
      status: 409,
      body: { error: "A person is using the computer right now." },
      contem: "A person is using the computer right now.",
    },
  ];

  for (const caso of casos) {
    test(`${caso.status}: ${caso.nome}`, async () => {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response(JSON.stringify(caso.body), {
          status: caso.status,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      try {
        const [reply] = (await ask({
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: {
            name: "abrir_pagina",
            arguments: { url: "https://x.com/search?q=skills" },
          },
        })) as {
          result: {
            isError?: boolean;
            content: { type: string; text?: string }[];
          };
        }[];

        expect(reply.result.isError).toBeTrue();
        const texto = String(reply.result.content[0]?.text);
        expect(texto).toContain(caso.contem);
        // O que não pode acontecer: chegar como recusa, que o modelo lê como política.
        expect(texto).not.toContain("recusado");
        // Uma tentativa, sem retry escondido no bridge.
        expect(calls).toBe(1);
      } finally {
        globalThis.fetch = original;
      }
    });
  }
});
