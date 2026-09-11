/**
 * Redação de segredos no texto que vai para o modelo.
 *
 * O que importa aqui não é apagar muito: é apagar o que é segredo e não tocar no que não é. Um
 * regex ganancioso que come números de pedido é pior que nenhum, porque some com a informação e
 * ninguém percebe. Por isso o teste tem os dois lados.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED, redactSecrets } from "../src/agent-runtime/redact";

describe("redactSecrets", () => {
  test("um cabeçalho de autorização não sobrevive", () => {
    const result = redactSecrets(
      "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' https://api.test",
    );
    expect(result.text).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result.text).toContain("Bearer");
    expect(result.redactions).toBeGreaterThan(0);
  });

  test("chaves de API dos formatos conhecidos somem", () => {
    const result = redactSecrets(
      "sk-proj-abcdefghijklmnopqrstuv e ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    );
    expect(result.text).not.toContain("sk-proj-abcdefghijklmnopqrstuv");
    expect(result.text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  });

  test("um JWT inteiro some", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactSecrets(`token: ${jwt}`).text).not.toContain(jwt);
  });

  test("um valor rotulado como senha some e o rótulo fica", () => {
    const result = redactSecrets("senha: hunter2segredo\nusuário: alice");
    expect(result.text).toContain("senha");
    expect(result.text).not.toContain("hunter2segredo");
    expect(result.text).toContain("alice");
  });

  test("um cartão válido some; um número qualquer não", () => {
    // 4111 1111 1111 1111 fecha o Luhn; o número de pedido abaixo não fecha.
    const card = redactSecrets("cartão 4111 1111 1111 1111").text;
    expect(card).not.toContain("4111");
    const order = redactSecrets("pedido 1234567890123456").text;
    expect(order).toContain("1234567890123456");
  });

  test("texto comum passa intacto", () => {
    const text =
      "Preencha o formulário com o nome do produto e clique em Publicar.";
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.redactions).toBe(0);
  });

  test("texto vazio não vira trabalho", () => {
    expect(redactSecrets("")).toEqual({ text: "", redactions: 0, rules: [] });
  });

  test("o marcador diz que houve corte, para o modelo não ler o texto como completo", () => {
    const result = redactSecrets("password: 12345678");
    expect(result.text).toContain(REDACTED);
  });
});
