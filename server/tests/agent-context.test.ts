import { describe, expect, test } from "bun:test";
import type { AgentRunInput } from "../src/agent-runtime/contracts";
import {
  historyBlock,
  restrictionsBlock,
  systemPrompt,
  toolData,
  truncateForContext,
  userPrompt,
} from "../src/agent-runtime/prompt";

function input(): AgentRunInput {
  return {
    runId: "context-test",
    botId: "context-bot",
    objective: "Preencher sem publicar.",
    instructions: "Não publique sem autorização explícita.",
    observation: null,
    history: [],
    tools: [],
    budget: { maxSteps: 40, maxMs: 60_000, maxCorrections: 2 },
    usage: { steps: 0, modelCalls: 0, toolCalls: 0, activeMs: 0 },
    capabilities: {
      vision: false,
      tools: true,
      streaming: false,
      mode: "step",
    },
  };
}

describe("contexto do modelo", () => {
  test("mantém a instrução no sistema sem repeti-la na mensagem variável", () => {
    const request = input();
    const system = systemPrompt(request);
    const user = userPrompt(request);
    expect(system).toContain("Não publique sem autorização explícita.");
    expect(user).not.toContain("Não publique sem autorização explícita.");
  });

  test("preserva correção da pessoa e resultado útil com proveniência distinta", () => {
    const request = input();
    request.messages = [
      { author: "person", kind: "message", text: "Use a categoria Livros." },
    ];
    request.history = [
      {
        seq: 1,
        kind: "observation",
        summary: 'plan_form → {"assignments":[{"label":"Título","ref":"e1"}]}',
      },
    ];
    const user = userPrompt(request);
    expect(user).toContain("Use a categoria Livros.");
    expect(user).toContain("plan_form");
    expect(user).toContain('"label":"Título"');
    expect(user.indexOf("Use a categoria Livros.")).toBeGreaterThan(
      user.indexOf("plan_form"),
    );
  });
});

describe("contexto útil e limitado (RQ-06)", () => {
  test("o envelope variável nunca repete a regra do sistema", () => {
    const request = input();
    const user = userPrompt(request);
    expect(user).not.toContain("Você opera o navegador de uma pessoa");
    expect(user).not.toContain("Não publique sem autorização explícita.");
    expect(systemPrompt(request)).toContain(
      "Não publique sem autorização explícita.",
    );
  });

  test("restrições vigentes chegam como pessoa, depois das mensagens novas", () => {
    const request = input();
    request.messages = [
      { author: "person", kind: "answer", text: "O código é 4821." },
    ];
    request.restrictions = [
      { kind: "instruction", text: "Use a categoria Livros." },
    ];
    const user = userPrompt(request);
    expect(user).toContain("Use a categoria Livros.");
    expect(user).toContain("Restrições vigentes da pessoa");
    expect(restrictionsBlock([])).toBe("");
    expect(restrictionsBlock(undefined)).toBe("");
  });

  test("o corte de contexto é explícito, não silencioso", () => {
    expect(truncateForContext("abcdef", 4)).toBe(
      "abcd…(truncado, limite de contexto)",
    );
    expect(truncateForContext("abc", 4)).toBe("abc");
  });

  test("resultado de ferramenta vai etiquetado como dado, com proveniência", () => {
    const tagged = toolData("plan_form", '{"assignments":[]}');
    expect(tagged).toContain('<ferramenta nome="plan_form">');
    expect(tagged).toContain('{"assignments":[]}');
    const request = input();
    request.history = [
      { seq: 1, kind: "action", summary: `plan_form → ok ${tagged}` },
    ];
    const block = historyBlock(request.history);
    expect(block).toContain("não instruções");
    expect(block).toContain('<ferramenta nome="plan_form">');
  });
});
