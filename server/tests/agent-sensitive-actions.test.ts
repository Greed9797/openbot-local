/**
 * O classificador de ações sensíveis.
 *
 * O que se fixa aqui é a fronteira: o que sai da máquina, gasta dinheiro, apaga ou muda a
 * configuração de todos espera por uma pessoa; navegar, ler e mapear não esperam. Os casos incluem os
 * que quase passam — "Reenviar" e "publishable" — porque uma fronteira só é útil se ela errar para o
 * lado de perguntar.
 */
import { describe, expect, test } from "bun:test";
import { classifyAction } from "../src/agent-runtime/sensitive-actions";

describe("o que exige uma pessoa", () => {
  test("um botão de publicar é sensível, e diz por quê", () => {
    const verdict = classifyAction(
      { name: "click", arguments: { ref: "e5", snapshotId: 3 } },
      {
        url: "https://loja.test/produtos/novo",
        targetName: "Publicar produto",
        targetRole: "button",
      },
    );
    expect(verdict.sensitive).toBe(true);
    if (!verdict.sensitive) return;
    expect(verdict.rule).toBe("acting-word");
    expect(verdict.reason).toContain("publicar");
    expect(verdict.destination).toBe("https://loja.test/produtos/novo");
    expect(verdict.expectedEffect).toContain("Publicar produto");
  });

  test("acentos e caixa não escondem um verbo", () => {
    const verdict = classifyAction(
      { name: "click", arguments: {} },
      { targetName: "EXCLUIR ITEM", targetRole: "button" },
    );
    expect(verdict.sensitive).toBe(true);
  });

  test("um verbo colado em outra palavra não é o mesmo verbo", () => {
    // "publishable" não é publish, e "cancelar" não é cadastrar: a fronteira é de palavra.
    expect(
      classifyAction(
        { name: "click", arguments: {} },
        { targetName: "Publishable draft", targetRole: "link" },
      ).sensitive,
    ).toBe(false);
    expect(
      classifyAction(
        { name: "click", arguments: {} },
        { targetName: "Cancelar", targetRole: "button" },
      ).sensitive,
    ).toBe(false);
  });

  test("reenviar uma mensagem é um efeito, e é pego", () => {
    expect(
      classifyAction(
        { name: "click", arguments: {} },
        { targetName: "Reenviar código", targetRole: "button" },
      ).sensitive,
    ).toBe(true);
  });

  test("navegar para a etapa de pagamento é sensível mesmo sem rótulo", () => {
    const verdict = classifyAction(
      { name: "navigate", arguments: { url: "https://app.test/admin/usuarios" } },
      { url: "https://app.test/admin/usuarios" },
    );
    expect(verdict.sensitive).toBe(true);
    if (!verdict.sensitive) return;
    expect(verdict.rule).toBe("acting-path");

    // E o checkout é sensível pelo verbo que o próprio endereço carrega.
    expect(
      classifyAction(
        { name: "navigate", arguments: { url: "https://loja.test/checkout" } },
        { url: "https://loja.test/checkout" },
      ).sensitive,
    ).toBe(true);
  });

  test("mandar concluir por argumento é sensível", () => {
    const verdict = classifyAction({
      name: "type_text",
      arguments: { ref: "e2", snapshotId: 1, text: "caderno", submit: true },
    });
    expect(verdict.sensitive).toBe(true);
    if (!verdict.sensitive) return;
    expect(verdict.rule).toBe("acting-argument");
  });

  test("ler, mapear e rolar não esperam por ninguém", () => {
    for (const action of [
      { name: "read_page", arguments: {} },
      { name: "snapshot_page", arguments: {} },
      { name: "scroll", arguments: { deltaY: 600 } },
      { name: "screenshot", arguments: {} },
      { name: "wait_for", arguments: { text: "Salvo" } },
      { name: "click", arguments: { ref: "e1", snapshotId: 1 } },
    ]) {
      expect(
        classifyAction(action, { targetName: "Ver detalhes" }).sensitive,
      ).toBe(false);
    }
  });
});
