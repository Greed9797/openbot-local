/**
 * O que cada CLI recebe no fio.
 *
 * O teste existe pela mesma razão do serviço: o que quebra um turno delegado não é o modelo, é o
 * encanamento — uma flag com outro nome, uma config no lugar errado, um evento lido como silêncio.
 * Nada aqui precisa do CLI instalado: o adaptador é uma função.
 */
import { describe, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { LIMITE_CONTEXTO_TURNO, perguntaDoTurno } from "../src/index";
import {
  adapterFor,
  cliConfig,
  knownAdapters,
  MIMO,
  OPENCODE,
  readOpencodeEvent,
} from "../src/cli";

describe("adaptadores", () => {
  test("o OpenCode lê o config do projeto e aprova com --auto", () => {
    const args = OPENCODE.args({
      prompt: "Abra o TikTok",
      workspace: "/workspace",
      model: "opencode-go/deepseek-v4.1-flash",
      variant: "",
    });
    expect(args).toEqual([
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      "/workspace",
      "-m",
      "opencode-go/deepseek-v4.1-flash",
      "Abra o TikTok",
    ]);
    expect(OPENCODE.configPath).toBe("opencode.json");
  });

  test("o MiMo tem outro binário, outro arquivo e outra flag de aprovação", () => {
    // É exatamente aqui que um adaptador copiado do outro falha em silêncio: a flag do fork tem
    // outro nome, e o turno fica esperando uma aprovação que ninguém vai dar.
    expect(MIMO.binary).toBe("mimo");
    expect(MIMO.configPath).toBe(".mimocode/mimocode.jsonc");
    expect(
      MIMO.args({
        prompt: "Abra o TikTok",
        workspace: "/workspace",
        model: "",
        variant: "",
      }),
    ).toContain("--yolo");
  });

  test("sem modelo escolhido, nenhuma flag de modelo vai", () => {
    const args = OPENCODE.args({
      prompt: "oi",
      workspace: "/w",
      model: "",
      variant: "",
    });
    expect(args).not.toContain("-m");
  });

  test("o degrau de raciocínio vai como --variant, antes do prompt", () => {
    // O `high` é do modelo, não do CLI: o mesmo binário roda modelo que pensa em degraus e modelo
    // que não. Depois do prompt, o CLI leria a flag como parte da mensagem.
    const args = OPENCODE.args({
      prompt: "Leia a tela e me diga o valor",
      workspace: "/workspace",
      model: "opencode-go/muse-spark-1.3-contributor",
      variant: "high",
    });

    expect(args).toEqual([
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      "/workspace",
      "-m",
      "opencode-go/muse-spark-1.3-contributor",
      "--variant",
      "high",
      "Leia a tela e me diga o valor",
    ]);
    expect(
      MIMO.args({
        prompt: "oi",
        workspace: "/w",
        model: "",
        variant: "max",
      }),
    ).toContain("max");
  });

  test("sem degrau escolhido, nenhuma flag de degrau vai", () => {
    const args = OPENCODE.args({
      prompt: "oi",
      workspace: "/w",
      model: "",
      variant: "",
    });
    expect(args).not.toContain("--variant");
  });

  test("CLI desconhecido é recusado com a lista do que existe", () => {
    expect(() => adapterFor("nao-existe")).toThrow(/nao-existe/);
    expect(() => adapterFor("nao-existe")).toThrow(/opencode/);
    expect(knownAdapters()).toEqual(["opencode", "mimo"]);
  });
});

describe("o config que dá o navegador ao CLI", () => {
  const config = cliConfig({
    mcpPath: "/app/shared/mcp-computer.ts",
    schema: "https://opencode.ai/config.json",
    environment: {
      OPENBOT_AGENT_TOKEN: "token",
      OPENBOT_API_URL: "http://openbot:3001",
      OPENBOT_RUN: "declaracao",
      OPENBOT_BOT_ID: "self",
    },
  });

  test("o servidor MCP local sobe o mesmo mcp-computer dos outros serviços", () => {
    expect(config.mcp).toEqual({
      openbot: {
        type: "local",
        command: ["bun", "/app/shared/mcp-computer.ts"],
        environment: {
          OPENBOT_AGENT_TOKEN: "token",
          OPENBOT_API_URL: "http://openbot:3001",
          OPENBOT_RUN: "declaracao",
          OPENBOT_BOT_ID: "self",
        },
        enabled: true,
      },
    });
  });

  test("busca embutida do CLI é negada: a web só entra pelo gateway", () => {
    // Não é estilo. `webfetch` do CLI lê a página por fora da política e do audit — o defeito que
    // este fork existe para não ter.
    expect(config.permission).toEqual({
      webfetch: "deny",
      websearch: "deny",
    });
  });
});

describe("os eventos do --format json", () => {
  test("texto vira a resposta do turno", () => {
    expect(
      readOpencodeEvent(
        JSON.stringify({
          type: "text",
          part: { type: "text", text: "O relatório foi baixado." },
        }),
      ),
    ).toEqual({ kind: "text", text: "O relatório foi baixado." });
  });

  test("chamada de ferramenta é contada", () => {
    expect(
      readOpencodeEvent(
        JSON.stringify({
          type: "tool_use",
          part: { tool: "openbot_navigate", state: { status: "completed" } },
        }),
      ),
    ).toEqual({ kind: "tool", name: "openbot_navigate" });
  });

  test("o erro do CLI traz a mensagem de dentro, não só o nome", () => {
    expect(
      readOpencodeEvent(
        JSON.stringify({
          type: "error",
          error: {
            name: "APIError",
            data: { message: "usage limit reached", statusCode: 429 },
          },
        }),
      ),
    ).toEqual({ kind: "failure", message: "usage limit reached" });
  });

  test("linha que não é JSON é ruído, não queda", () => {
    // O CLI também escreve avisos soltos no stdout. Derrubar o turno por causa deles seria perder a
    // tarefa por causa de um log.
    expect(
      readOpencodeEvent("Reading additional input from stdin..."),
    ).toBeUndefined();
    expect(readOpencodeEvent("")).toBeUndefined();
  });

  test("evento de passo não vira texto nem falha", () => {
    expect(
      readOpencodeEvent(
        JSON.stringify({
          type: "step_finish",
          part: { reason: "tool-calls", tokens: { total: 10 } },
        }),
      ),
    ).toBeUndefined();
  });
});

/**
 * O contexto do turno (RQ-01): o CLI recebe uma única mensagem simples com o histórico daquele
 * pedido e a pergunta atual, sem memória global e sem "[object Object]".
 *
 * Nada aqui precisa do CLI instalado: `perguntaDoTurno` é função pura sobre o `input`.
 */
describe("o contexto textual do turno", () => {
  function turnoComMensagens(
    messages: Message[],
    threadId = "t1",
  ): RunAgentInput {
    return {
      threadId,
      runId: "r1",
      state: {},
      messages,
      tools: [],
      context: [],
      forwardedProps: {},
    } as RunAgentInput;
  }

  function fala(id: string, content: string): Message {
    return { id, role: "user", content } as Message;
  }

  function resposta(id: string, content: string): Message {
    return { id, role: "assistant", content } as Message;
  }

  test("o segundo turno recebe o dado do primeiro, com papéis marcados (AC1)", () => {
    const pergunta = perguntaDoTurno(
      turnoComMensagens([
        fala("m1", "meu endereço é Rua das Flores, 123"),
        resposta("m2", "anotei o seu endereço"),
        fala("m3", "qual é o meu endereço?"),
      ]),
    );

    expect(pergunta).toContain("Rua das Flores, 123");
    expect(pergunta).toContain("qual é o meu endereço?");
    expect(pergunta).toContain("Pessoa:");
    expect(pergunta).toContain("Assistente:");
  });

  test("outra thread não herda o dado da primeira (AC2)", () => {
    const mensagensA = [
      fala("m1", "meu endereço é Rua das Flores, 123"),
      fala("m2", "confirme que anotou"),
    ];
    const primeira = perguntaDoTurno(turnoComMensagens(mensagensA, "thread-a"));
    expect(primeira).toContain("Rua das Flores, 123");

    const segunda = perguntaDoTurno(
      turnoComMensagens([fala("m1", "olá")], "thread-b"),
    );
    expect(segunda).not.toContain("Rua das Flores");

    // Sem memória global: repetir a primeira devolve o mesmo texto, sem vazar nada da segunda.
    expect(perguntaDoTurno(turnoComMensagens(mensagensA, "thread-a"))).toBe(
      primeira,
    );
  });

  test("histórico longo preserva a atual inteira e sinaliza a omissão (AC3)", () => {
    const atual = "responda terminando com a palavra PINEAPPLE";
    const antigas: Message[] = [];
    for (let i = 0; i < 200; i++) {
      antigas.push(fala(`u${i}`, `pergunta antiga ${i} ${"x".repeat(500)}`));
      antigas.push(
        resposta(`a${i}`, `resposta antiga ${i} ${"y".repeat(500)}`),
      );
    }

    const pergunta = perguntaDoTurno(
      turnoComMensagens([...antigas, fala("nova", atual)]),
    );

    expect(pergunta).toContain(atual);
    expect(pergunta.length).toBeLessThanOrEqual(LIMITE_CONTEXTO_TURNO);
    expect(pergunta).toMatch(/omitid/);
    expect(pergunta).not.toContain("pergunta antiga 0");
  });

  test("mensagem atual acima do limite é recusada, nunca truncada (AC4)", () => {
    const gigante = `começo-MARCADOR ${"z".repeat(LIMITE_CONTEXTO_TURNO)} fim-MARCADOR`;
    const entrada = turnoComMensagens([fala("m1", gigante)]);

    expect(() => perguntaDoTurno(entrada)).toThrow(/limite/);
  });

  test("parte multimodal vira marcador explícito, nunca [object Object]", () => {
    const pergunta = perguntaDoTurno(
      turnoComMensagens([
        {
          id: "m1",
          role: "user",
          content: [
            { type: "text", text: "descreva a foto" },
            {
              type: "image",
              source: { type: "url", value: "https://exemplo.test/foto.png" },
            },
          ],
        } as unknown as Message,
      ]),
    );

    expect(pergunta).toContain("descreva a foto");
    expect(pergunta).not.toContain("[object Object]");
    expect(pergunta).toMatch(/image/i);
  });

  test("conteúdo fora do contrato é recusado com erro explícito", () => {
    const entrada = turnoComMensagens([
      { id: "m1", role: "user", content: 42 } as unknown as Message,
    ]);

    expect(() => perguntaDoTurno(entrada)).toThrow(/contrato/);
  });

  test("chamada de ferramenta do assistente entra no histórico sem virar silêncio", () => {
    const pergunta = perguntaDoTurno(
      turnoComMensagens([
        fala("m1", "abra a página"),
        {
          id: "m2",
          role: "assistant",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "openbot_navigate", arguments: "{}" },
            },
          ],
        } as unknown as Message,
        fala("m3", "e agora?"),
      ]),
    );

    expect(pergunta).toContain("openbot_navigate");
  });
});
