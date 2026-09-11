import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("provides PostgreSQL with pgvector for local development", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  expect(compose).toContain("postgres:");
  expect(compose).toContain("pgvector/pgvector:");
  expect(compose).toContain("${POSTGRES_PORT:-5432}:5432");
});

/**
 * Every published port is settable, and defaults to the number the documentation gives.
 *
 * `scripts/start.sh` reads these same names to decide where to look for each service.
 */
test("publishes every service on a settable port with the documented default", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  const published = [
    ["POSTGRES_PORT", "5432", "5432"],
    ["COMPUTER_PORT", "4100", "4100"],
    ["SUPERVISOR_PORT", "4500", "4300"],
    ["BOT_PORT", "4200", "4200"],
    ["LANGGRAPH_PORT", "4201", "4201"],
    // Os que faltavam: a API e os dois serviços de CLI de agente. Sem eles a lista não era
    // "every published port" — três serviços podiam mudar de porta, ou deixar de ser configuráveis,
    // sem que esta conferência dissesse nada.
    ["OPENBOT_PORT", "3001", "3001"],
    ["CODEX_BOT_PORT", "4202", "4202"],
    ["CLI_BOT_PORT", "4210", "4210"],
  ] as const;

  for (const [name, host, container] of published) {
    expect(compose).toContain(`\${${name}:-${host}}:${container}`);
  }
});

/**
 * Both Bots are reachable at whatever `OPENAI_BASE_URL` names.
 *
 * The API server reads that variable from `.env` directly, so it moves with the deployment. The
 * Bots run in containers and see only what compose hands them, and a deployment that moved its
 * models to a gateway and found half of itself still calling OpenAI would have no way to tell.
 */
test("gives both shipped Bots the OpenAI-compatible endpoint", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  // Both Bots speak OpenAI; only the framework Bot can be pointed at the other two.
  expect(
    compose.match(/OPENAI_BASE_URL: \$\{OPENAI_BASE_URL:-?\}/g),
  ).toHaveLength(2);
  for (const variable of [
    "ANTHROPIC_BASE_URL",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
  ]) {
    expect(compose).toContain(`${variable}: \${${variable}:-}`);
  }
});

test("enables pgvector before creating vector columns", () => {
  const migration = readFileSync(
    join(import.meta.dir, "..", "server", "drizzle", "0000_schema.sql"),
    "utf8",
  );

  // The order is the property, not the first line. A `vector` column cannot be created before the
  // extension that defines the type, and a generated migration has no reason to put them in that
  // order on its own.
  const extension = migration.indexOf("CREATE EXTENSION IF NOT EXISTS vector;");
  const firstVectorColumn = migration.search(/"embedding" vector\(/);
  expect(extension).toBeGreaterThanOrEqual(0);
  expect(firstVectorColumn).toBeGreaterThan(extension);
});

test("runs migrations after PostgreSQL becomes healthy", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  expect(compose).toContain("migrate:");
  expect(compose).toContain("condition: service_healthy");
  expect(compose).toContain('"drizzle-kit", "migrate"');
});

describe("um Bot sem navegador tem de aparecer", () => {
  /**
   * `fetch` sozinho não reprova nada. O teste antigo do `agent-codex` chamava o `/health` e ignorava
   * a resposta, então passava também quando o Bot tinha subido SEM ferramentas — e um Bot sem
   * ferramentas continua atendendo, conversando e respondendo bem, de memória. A falha só aparecia
   * na resposta de alguém, dias depois, indistinguível de uma resposta lida.
   */
  test("o healthcheck do agent-codex olha o status da resposta", () => {
    const compose = readFileSync(
      join(import.meta.dir, "..", "docker-compose.yml"),
      "utf8",
    );
    const servico = compose.slice(compose.indexOf("  agent-codex:"));
    const bloco = servico.slice(0, servico.indexOf("\n  # "));

    expect(bloco).toContain("r.ok");
    expect(bloco).toContain("start_period");
  });
});
