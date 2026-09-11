/**
 * O que cada CLI recebe no fio.
 *
 * O teste existe pela mesma razão do serviço: o que quebra um turno delegado não é o modelo, é o
 * encanamento — uma flag com outro nome, uma config no lugar errado, um evento lido como silêncio.
 * Nada aqui precisa do CLI instalado: o adaptador é uma função.
 */
import { describe, expect, test } from "bun:test";
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
      MIMO.args({ prompt: "Abra o TikTok", workspace: "/workspace", model: "" }),
    ).toContain("--yolo");
  });

  test("sem modelo escolhido, nenhuma flag de modelo vai", () => {
    const args = OPENCODE.args({ prompt: "oi", workspace: "/w", model: "" });
    expect(args).not.toContain("-m");
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
    expect(readOpencodeEvent("Reading additional input from stdin...")).toBeUndefined();
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
