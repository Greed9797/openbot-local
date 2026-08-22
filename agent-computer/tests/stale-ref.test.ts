import { describe, expect, test } from "bun:test";
import {
  type PaginaComSeletor,
  resolveRef,
  StaleSnapshotError,
} from "../src/refs";

/** Uma página cujo motor de seletor responde do jeito que o teste pedir. */
function paginaCom(count: () => Promise<number>): PaginaComSeletor {
  return { locator: () => ({ count }) };
}

describe("um ref que não vale mais", () => {
  test("um ref de outro snapshot é recusado antes de tocar na página", () => {
    const nunca = paginaCom(async () => {
      throw new Error("a página não devia ter sido consultada");
    });

    expect(resolveRef(9, nunca, "e1", 8)).rejects.toThrow(/out of date/);
  });

  test("um ref que não nomeia nada diz para tirar outro snapshot", () => {
    const vazia = paginaCom(async () => 0);

    expect(resolveRef(3, vazia, "e1", 3)).rejects.toThrow(
      /Take a new snapshot/,
    );
  });

  /**
   * O caso que chegava cru até o Bot.
   *
   * Depois de um clique que navega, o frame onde aqueles refs foram numerados deixa de existir, e o
   * motor de seletor estoura em vez de contar zero. O `snapshotId` ainda bate — ninguém tirou um
   * snapshot novo —, então a checagem de geração deixa passar, e sem este guarda o que voltava era
   * `Invalid frame in aria-ref selector` com status 503: uma frase sobre a implementação interna de
   * um seletor, anunciando queda de serviço, para o que foi apenas a página seguir em frente.
   */
  test("a página ter navegado vira 'tire um snapshot novo', e não erro do motor de seletor", async () => {
    const navegou = paginaCom(async () => {
      throw new Error('Invalid frame in aria-ref selector "aria-ref=e6"');
    });

    const erro = await resolveRef(6, navegou, "e6", 6).catch(
      (motivo: unknown) => motivo,
    );

    expect(erro).toBeInstanceOf(StaleSnapshotError);
    expect((erro as Error).message).toMatch(/fresh snapshot/);
    expect((erro as Error).message).not.toMatch(/aria-ref/);
  });

  test("um ref que resolve devolve o elemento", async () => {
    const achou = paginaCom(async () => 1);
    expect(await resolveRef(4, achou, "e2", 4)).toBeDefined();
  });
});
