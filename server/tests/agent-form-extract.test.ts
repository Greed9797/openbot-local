/**
 * A extração do formulário a partir do snapshot ARIA, sem tocar no navegador.
 *
 * O que se prova: um cadastro de produto realista vira campos na ordem do snapshot (texto,
 * select com as opções do `option` acima, checkbox, dois grupos de rádio, textarea, botão
 * salvar), `option` e botão sem nome não viram campo, obrigatório sai do `*` e da palavra,
 * `filled` sai de `value` e de `checked`, e o plano casa por rótulo exato, por sinônimo
 * (`name` acha "Nome do produto") e por continência inequívoca — com `unknown`, `missing` e
 * o mesmo resultado para a mesma entrada.
 */
import { describe, expect, test } from "bun:test";
import { extractForm, planFill } from "../src/agent-runtime/form-extract";
import type { FormSnapshotElement } from "../src/agent-runtime/form-extract";

function elements(): FormSnapshotElement[] {
  return [
    { ref: "e1", role: "textbox", name: "Nome do produto *" },
    { ref: "e2", role: "textbox", name: "SKU", value: "CAM-001" },
    { ref: "e3", role: "combobox", name: "Categoria obrigatória" },
    { ref: "e4", role: "option", name: "Eletrônicos" },
    { ref: "e5", role: "option", name: "Roupas" },
    { ref: "e6", role: "textbox", name: "Preço", type: "number" },
    { ref: "e7", role: "textbox", name: "Quantidade", type: "number", value: "10" },
    { ref: "e8", role: "checkbox", name: "Em estoque", checked: true },
    { ref: "e9", role: "radio", name: "Tamanho P" },
    { ref: "e10", role: "radio", name: "Tamanho M", checked: true },
    { ref: "e11", role: "radio", name: "Tamanho G" },
    { ref: "e12", role: "radio", name: "Cor Vermelho" },
    { ref: "e13", role: "radio", name: "Cor Azul" },
    { ref: "e14", role: "textbox", name: "Descrição do produto", type: "textarea" },
    { ref: "e15", role: "textbox", name: "E-mail do fornecedor (required)", type: "email" },
    { ref: "e16", role: "button", name: "Salvar" },
    { ref: "e17", role: "button", name: "" },
    { ref: "e18", role: "link", name: "Voltar" },
    { ref: "e19", role: "heading", name: "Cadastro de produto" },
    { ref: "e20", role: "textbox", name: "Cupom", value: "" },
  ];
}

describe("extractForm num cadastro de produto", () => {
  test("extrai os campos na ordem do snapshot, com kind, opções e grupos", () => {
    const extract = extractForm({ elements: elements() });

    expect(extract.fields.map((field) => field.ref)).toEqual([
      "e1",
      "e2",
      "e3",
      "e6",
      "e7",
      "e8",
      "e9",
      "e12",
      "e14",
      "e15",
      "e20",
    ]);
    expect(extract.fields.map((field) => field.kind)).toEqual([
      "text",
      "text",
      "select",
      "number",
      "number",
      "checkbox",
      "radio",
      "radio",
      "textarea",
      "email",
      "text",
    ]);

    const category = extract.fields.find((field) => field.ref === "e3");
    expect(category?.options).toEqual(["Eletrônicos", "Roupas"]);

    const size = extract.fields.find((field) => field.ref === "e9");
    expect(size).toMatchObject({ label: "Tamanho", group: "Tamanho", options: ["P", "M", "G"] });

    const color = extract.fields.find((field) => field.ref === "e12");
    expect(color).toMatchObject({ label: "Cor", group: "Cor", options: ["Vermelho", "Azul"] });

    expect(extract.buttons).toEqual([{ ref: "e16", label: "Salvar", role: "button" }]);
  });

  test("obrigatório sai do asterisco, de obrigatória e de required", () => {
    const extract = extractForm({ elements: elements() });

    expect(extract.required).toEqual(["e1", "e3", "e15"]);
    expect(extract.fields.find((field) => field.ref === "e2")?.required).toBe(false);
  });

  test("filled sai de value e de checked; type file sozinho não obriga", () => {
    const extract = extractForm({ elements: elements() });
    const byRef = new Map(extract.fields.map((field) => [field.ref, field]));

    expect(byRef.get("e2")?.filled).toBe(true);
    expect(byRef.get("e2")?.currentValue).toBe("CAM-001");
    expect(byRef.get("e7")?.filled).toBe(true);
    expect(byRef.get("e8")?.filled).toBe(true);
    expect(byRef.get("e9")?.filled).toBe(true);
    expect(byRef.get("e9")?.currentValue).toBe("M");
    expect(byRef.get("e1")?.filled).toBe(false);
    expect(byRef.get("e12")?.filled).toBe(false);
    expect(byRef.get("e20")?.filled).toBe(false);

    expect(extract.unfilled).toEqual(["e1", "e3", "e6", "e12", "e14", "e15", "e20"]);

    const file = extractForm({
      elements: [{ ref: "f1", role: "textbox", name: "Foto", type: "file" }],
    });
    expect(file.fields[0]).toMatchObject({ kind: "file", required: false });
  });

  test("textarea sai de role próprio e de nome com quebra de linha", () => {
    const extract = extractForm({
      elements: [
        { ref: "t1", role: "textarea", name: "Mensagem" },
        { ref: "t2", role: "textbox", name: "Notas\nsegunda linha" },
        { ref: "t3", role: "textbox", name: "Apelido" },
      ],
    });

    expect(extract.fields.map((field) => field.kind)).toEqual(["textarea", "textarea", "text"]);
  });
});

describe("planFill", () => {
  test("casa por rótulo exato, por sinônimo e por continência, com o how de cada kind", () => {
    const extract = extractForm({ elements: elements() });
    const plan = planFill(extract, {
      name: "Cadeira Gamer X",
      SKU: "CAD-002",
      category: "Eletrônicos",
      valor: "1299",
      qtd: "5",
      description: "Cadeira ergonômica",
      fornecedor: "contato@fornecedor.test",
      "em estoque": "true",
      tamanho: "G",
    });

    expect(plan.unknown).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.assignments).toEqual([
      { ref: "e1", label: "Nome do produto *", kind: "text", how: "fill", value: "Cadeira Gamer X" },
      { ref: "e2", label: "SKU", kind: "text", how: "fill", value: "CAD-002" },
      {
        ref: "e3",
        label: "Categoria obrigatória",
        kind: "select",
        how: "select",
        value: "Eletrônicos",
      },
      { ref: "e6", label: "Preço", kind: "number", how: "fill", value: "1299" },
      { ref: "e7", label: "Quantidade", kind: "number", how: "fill", value: "5" },
      {
        ref: "e14",
        label: "Descrição do produto",
        kind: "textarea",
        how: "fill",
        value: "Cadeira ergonômica",
      },
      {
        ref: "e15",
        label: "E-mail do fornecedor (required)",
        kind: "email",
        how: "fill",
        value: "contato@fornecedor.test",
      },
      { ref: "e8", label: "Em estoque", kind: "checkbox", how: "check", value: "true" },
      { ref: "e9", label: "Tamanho", kind: "radio", how: "check", value: "G" },
    ]);
  });

  test("campo já filled recebe valor mesmo assim, e o que sobra vai para unknown e missing", () => {
    const extract = extractForm({ elements: elements() });
    const plan = planFill(extract, { SKU: "CAD-002", observacoes: "sem pressa" });

    // O SKU já estava preenchido: preencher de novo é corrigir, não é erro.
    expect(plan.assignments).toEqual([
      { ref: "e2", label: "SKU", kind: "text", how: "fill", value: "CAD-002" },
    ]);
    expect(plan.unknown).toEqual(["observacoes"]);
    expect(plan.missing).toEqual(["e1", "e3", "e15"]);
  });

  test("a mesma entrada dá sempre a mesma saída", () => {
    const snapshot = { elements: elements() };
    const values = { name: "Cadeira Gamer X", tamanho: "G", plano: "x" };

    expect(JSON.stringify(extractForm(snapshot))).toBe(JSON.stringify(extractForm(snapshot)));
    const extract = extractForm(snapshot);
    expect(JSON.stringify(planFill(extract, values))).toBe(
      JSON.stringify(planFill(extract, values)),
    );
  });
});
