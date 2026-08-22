/**
 * Um `ref` de snapshot resolvido em elemento, ou uma recusa que diz o que fazer.
 *
 * Fora de `index.ts` e sem importar o Playwright de propósito. O que esta lógica precisa de uma
 * página é uma função `locator`, e é só isso que ela pede — assim ela é exercitável sem subir um
 * navegador, que é a diferença entre ter teste para as três formas de um ref envelhecer e não ter
 * nenhum. As três aparecem em uso normal e nenhuma delas é um erro de programação.
 */

/** O tanto de uma página que resolver um ref exige. */
export type PaginaComSeletor = {
  locator: (selector: string) => { count: () => Promise<number> };
};

export class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

/**
 * Recusa qualquer coisa vinda de um snapshot que já foi substituído.
 *
 * `aria-ref=` é um motor de seletor de primeira mão do Playwright, o mesmo que o servidor MCP dele
 * usa. A checagem de geração aqui é a metade voltada para quem chama; ver a nota sobre `snapshotId`
 * para por que as duas existem.
 */
export function locateRef<P extends PaginaComSeletor>(
  snapshotId: number,
  target: P,
  ref: string,
  expectedSnapshotId: number | undefined,
): ReturnType<P["locator"]> {
  if (expectedSnapshotId !== undefined && expectedSnapshotId !== snapshotId) {
    throw new StaleSnapshotError(
      `That list of elements is out of date: it was taken for snapshot ${expectedSnapshotId} and the page is now at ${snapshotId}. Take a new snapshot and use the refs from it.`,
    );
  }
  return target.locator(`aria-ref=${ref}`) as ReturnType<P["locator"]>;
}

/**
 * O elemento, ou uma recusa que diz o que fazer a respeito.
 *
 * Conferir a geração não é conferir a existência. Um ref do snapshot atual que não nomeia nada —
 * porque o modelo o inventou, ou porque a página seguiu em frente sem um snapshot novo — passa por
 * `locateRef` e simplesmente espera. A ação estoura o tempo, e quem chamou recebe uma falha genérica
 * carregando o log interno do Playwright em vez da resposta acionável: tire um snapshot novo.
 *
 * `count()` resolve na hora em vez de esperar, então um ref que não nomeia nada é recusado em
 * milissegundos em vez de segurar a ação pelo tempo inteiro.
 */
export async function resolveRef<P extends PaginaComSeletor>(
  snapshotId: number,
  target: P,
  ref: string,
  expectedSnapshotId: number | undefined,
): Promise<ReturnType<P["locator"]>> {
  const locator = locateRef(snapshotId, target, ref, expectedSnapshotId);

  /*
   * `count()` também FALHA, e não só devolve zero.
   *
   * Quando a página navegou depois do snapshot — o Bot clicou num link e agora quer digitar —, o
   * frame em que aqueles refs foram numerados não existe mais, e o motor de seletor estoura com
   * "Invalid frame in aria-ref selector" antes de contar coisa nenhuma. Sem isto o erro do Playwright
   * subia inteiro até o Bot, com status 503: uma frase sobre a implementação interna do seletor,
   * anunciando queda de serviço, para o que foi apenas a página seguir em frente.
   *
   * É a mesma situação de fato dos outros dois casos aqui, e merece a mesma resposta.
   */
  let quantos: number;
  try {
    quantos = await locator.count();
  } catch {
    throw new StaleSnapshotError(
      `The page moved on after that snapshot, so ref ${ref} no longer points anywhere. Take a fresh snapshot and use the refs from it.`,
    );
  }

  if (quantos === 0) {
    throw new StaleSnapshotError(
      `Nothing on this page has the ref ${ref}. Take a new snapshot and use the refs it returns.`,
    );
  }
  return locator;
}
