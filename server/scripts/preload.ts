/**
 * Loaded before anything else, to make module loading deterministic.
 *
 * Both the test suite and the API server preload this. It started as a test-only shim, which was a
 * misreading of the problem: the ordering it fixes is a property of the module graph, not of the
 * test runner, and the server hit exactly the same failure the moment it ran anywhere the graph
 * happened to be walked in the other order — in the Docker image, on every boot.
 *
 * Deep inside the runtime's dependencies, `@modelcontextprotocol/sdk`
 * does `require("eventsource")` from CommonJS, and eventsource ships as ESM only. Bun permits that
 * only when the module has already been evaluated as ESM by something earlier in the process, so
 * whether it works depends on the order the test files happen to be walked, an order that changes
 * whenever a test file is added or renamed.
 *
 * The failure is not a failing test. The file throws while being imported, so under the test runner
 * its tests are never registered and never reported, and under the server the process dies during
 * start-up with `require() async module ... is unsupported`.
 *
 * Importing it here evaluates it as ESM once, before anything requires it, so the order no longer
 * decides the outcome.
 *
 * This compatibility shim is narrow enough to delete when the SDK ships an ESM-safe require or Bun
 * handles it.
 */

import "eventsource";

/*
 * E, no caminho do teste, um aviso quando o banco está vazio.
 *
 * Um Postgres sem schema produz 79 falhas espalhadas por 20 arquivos, com mensagens sobre JSON
 * inválido e colunas ausentes — nenhuma delas dizendo "não há tabela nenhuma aqui". Aconteceu duas
 * vezes no mesmo dia: o Colima recria a máquina virtual e leva o volume junto, e das duas vezes a
 * primeira suspeita foi regressão de código.
 *
 * Aqui porque este arquivo é o único ponto por onde a suíte inteira passa antes de qualquer teste.
 * Não bloqueia nada: quem quer só os testes de unidade não precisa de banco.
 */
if (process.env.NODE_ENV !== "production") {
  const { SQL } = await import("bun");
  const endereço =
    process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot";
  const sql = new SQL(endereço);
  try {
    const [linha] = (await sql`
      select count(*)::int as total
      from information_schema.tables
      where table_schema = 'public'
    `) as { total: number }[];
    if ((linha?.total ?? 0) === 0) {
      console.warn(
        "\n  O BANCO DE TESTES ESTÁ SEM SCHEMA — as falhas de integração abaixo são disso, não do código." +
          "\n  Aplique com: bun run --cwd server db:migrate\n",
      );
    }
  } catch {
    console.warn(
      "\n  O BANCO DE TESTES NÃO RESPONDEU — as falhas de integração abaixo são disso, não do código." +
        "\n  Suba com: docker compose up -d postgres\n",
    );
  } finally {
    await sql.end();
  }
}
