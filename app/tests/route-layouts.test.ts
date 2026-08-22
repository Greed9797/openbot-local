import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROUTES = join(import.meta.dir, "..", "src", "routes");

/**
 * Um arquivo de rota que também é pasta é um layout, quer quem escreveu saiba ou não.
 *
 * No roteamento por arquivo, `connectors.tsx` ao lado de `connectors/google-drive.tsx` não são duas
 * telas irmãs: o primeiro vira o layout do segundo. Sem um `<Outlet />` dentro dele, a rota filha
 * nunca aparece — abrir o endereço dela renderiza o pai de novo, sem erro nenhum em lugar algum. Foi
 * exatamente assim que a tela de conectar o Google Drive existiu por completo, com rota, formulário e
 * endpoints funcionando, e ainda assim foi impossível chegar nela: o botão levava a uma URL que
 * mostrava a lista de onde ele tinha sido clicado.
 *
 * Nada no compilador, no lint ou nos testes de unidade enxerga isso, porque não há nada de errado
 * com o arquivo em si. Só a relação entre ele e a pasta ao lado, que é o que este teste olha.
 */
function routeFilesShadowingAFolder(directory: string): string[] {
  const found: string[] = [];

  const walk = (current: string) => {
    const entries = readdirSync(current);
    const folders = new Set(
      entries.filter((entry) => statSync(join(current, entry)).isDirectory()),
    );

    for (const entry of entries) {
      const path = join(current, entry);
      if (folders.has(entry)) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".tsx")) continue;
      // `route.tsx` é o layout declarado de propósito; a armadilha é o que vira layout sem querer.
      if (entry === "route.tsx") continue;
      if (folders.has(entry.replace(/\.tsx$/, ""))) found.push(path);
    }
  };

  walk(directory);
  return found;
}

describe("layouts que ninguém pediu", () => {
  test("todo arquivo de rota que também é pasta renderiza um Outlet", () => {
    const offenders = routeFilesShadowingAFolder(ROUTES)
      .filter((path) => !readFileSync(path, "utf8").includes("<Outlet"))
      .map((path) => path.slice(ROUTES.length + 1));

    /*
     * A saída nomeia o arquivo porque o conserto depende de qual é a intenção: se ele deve ser
     * layout, ganha um `<Outlet />`; se deve ser uma tela irmã, vira `<pasta>/index.tsx`.
     */
    expect(offenders).toEqual([]);
  });
});
