/**
 * As skills concedidas, do runtime ao workspace do CLI.
 *
 * O que este arquivo prova é o encanamento, e não o modelo: que a lista que chega no
 * `forwardedProps` seja lida, que um slug não escape do workspace por ser nome de diretório, e que
 * o corpo da skill NÃO entre no `AGENTS.md` — com cem skills concedidas, entrar seria o turno
 * inteiro. O CLI não precisa estar instalado: são funções.
 */
import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import { instructions, skillsDoTurno } from "../src/index";

function turnoCom(props: Record<string, unknown>): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    state: {},
    messages: [{ id: "m1", role: "user", content: "oi" }],
    tools: [],
    context: [],
    forwardedProps: props,
  } as RunAgentInput;
}

describe("skills concedidas", () => {
  test("a lista vem do forwardedProps, e ausência é lista vazia", () => {
    expect(skillsDoTurno(turnoCom({}))).toEqual([]);
    expect(skillsDoTurno(turnoCom({ skills: "nada" }))).toEqual([]);

    const lidas = skillsDoTurno(
      turnoCom({
        skills: [
          {
            slug: "gerar-imagens",
            title: "Gerar imagens",
            summary: "Descreve o fluxo de geração",
            instructions: "Abra a ferramenta e peça o produto.",
          },
        ],
      }),
    );
    expect(lidas).toHaveLength(1);
    expect(lidas[0]?.slug).toBe("gerar-imagens");
  });

  test("um slug que escaparia do workspace é descartado", () => {
    const lidas = skillsDoTurno(
      turnoCom({
        skills: [
          { slug: "../../etc/cron.d/evil", instructions: "x" },
          { slug: "TMP", instructions: "x" },
          { slug: "com espaço", instructions: "x" },
          { slug: "ok-123", instructions: "y" },
        ],
      }),
    );
    expect(lidas.map((skill) => skill.slug)).toEqual(["ok-123"]);
  });

  test("o índice nomeia o arquivo, e o corpo da skill fica fora das instruções", () => {
    const texto = instructions([
      {
        slug: "gerar-imagens",
        title: "Gerar imagens",
        summary: "Descreve o fluxo de geração",
        instructions: "SEGREDO-QUE-NAO-DEVE-ENTRAR-NO-AGENTS",
      },
    ]);

    expect(texto).toContain("## Skills concedidas");
    expect(texto).toContain(
      "- gerar-imagens — Descreve o fluxo de geração (/workspace/.openbot-skills/gerar-imagens/SKILL.md)",
    );
    expect(texto).not.toContain("SEGREDO-QUE-NAO-DEVE-ENTRAR-NO-AGENTS");
  });

  test("sem skill concedida não há seção — nem título órfão", () => {
    expect(instructions([])).not.toContain("Skills concedidas");
  });
});
