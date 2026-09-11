/**
 * O armazém de artefatos, contra o banco e o disco de verdade.
 *
 * O que se prova aqui é a ordem que evita o artefato mentiroso — arquivo antes da linha —, a
 * retenção que apaga os dois, e a classificação que decide os destinos sem que ninguém possa
 * aumentá-los depois. Uma imagem que some do disco deixa de ser prometida: a linha vai embora junto.
 */
import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRunRepository } from "../src/agent-runs/repository";
import { createAgentRunService } from "../src/agent-runs/service";
import { createArtifactStore } from "../src/agent-runtime/artifact-store";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agentRuns, runArtifacts } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@127.0.0.1:5432/openbot",
  TEST_POOL,
);
const repository = createAgentRunRepository(database);
const service = createAgentRunService({
  repository,
  auditStore: createAuditStore(database),
  defaults: {
    provider: "scripted",
    model: "scripted-1",
    budget: { maxSteps: 5, maxMs: 30_000, maxCorrections: 1 },
    leaseTtlMs: 30_000,
  },
});

const created: string[] = [];

async function newRun(): Promise<string> {
  const { run } = await service.createRun(
    { id: "artifacts" },
    {
      botId: `bot-${crypto.randomUUID().slice(0, 8)}`,
      userId: "artifacts",
      origin: "web",
      objective: "Uma página qualquer.",
    },
    "artifacts",
  );
  created.push(run.id);
  return run.id;
}

afterAll(async () => {
  /*
   * As capturas saem junto com as tarefas: a chave estrangeira é `cascade`, e apagar a tarefa é o que
   * basta. Enquanto só `run_artifacts` era apagado, cada corrida da suíte deixava uma dúzia de
   * tarefas na base de quem roda os testes — e a tela de Tarefas enchia de "Uma página qualquer.".
   */
  if (created.length) {
    await database.delete(agentRuns).where(inArray(agentRuns.id, created));
  }
});

/** Um PNG válido de um pixel, para o que for gravado ser mesmo uma imagem. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function store(options: { retentionDays: number } = { retentionDays: 7 }) {
  const root = await mkdtemp(join(tmpdir(), "openbot-artifacts-"));
  return createArtifactStore({ repository, root, ...options });
}

test("uma captura vira linha e arquivo, com hash do conteúdo", async () => {
  const runId = await newRun();
  const artifacts = await store();
  const stored = await artifacts.capture({
    runId,
    stepId: null,
    kind: "screenshot",
    data: PIXEL_PNG,
    mime: "image/png",
    url: "https://example.test/form",
    width: 1280,
    height: 800,
    capturedAt: new Date().toISOString(),
    classification: "internal",
    protection: "masked",
    allowedDestinations: ["panel", "model", "telegram"],
    retentionDays: 7,
    metadata: { masked: 2 },
  });

  expect(stored.bytes).toBe(Buffer.from(PIXEL_PNG, "base64").byteLength);
  expect(stored.hash).toHaveLength(64);
  expect(stored.protection).toBe("masked");
  expect(stored.retentionUntil).not.toBeNull();

  const read = await artifacts.read(stored.id);
  expect(read?.bytes.toString("base64")).toBe(PIXEL_PNG);

  // O arquivo está mesmo no disco, no diretório do run.
  expect(stored.storagePath).toContain(runId);
});

test("duas capturas iguais têm o mesmo hash e ids diferentes", async () => {
  const runId = await newRun();
  const artifacts = await store();
  const common = {
    runId,
    stepId: null,
    kind: "screenshot",
    data: PIXEL_PNG,
    mime: "image/png",
    url: "https://example.test/",
    width: 1,
    height: 1,
    capturedAt: new Date().toISOString(),
    classification: "internal" as const,
    protection: "none" as const,
    allowedDestinations: ["panel"],
    retentionDays: 7,
  };
  const first = await artifacts.capture(common);
  const second = await artifacts.capture(common);
  expect(first.id).not.toBe(second.id);
  expect(first.hash).toBe(second.hash);
});

test("a retenção vencida apaga a linha e o arquivo", async () => {
  const runId = await newRun();
  const artifacts = await store({ retentionDays: 0 });
  const stored = await artifacts.capture({
    runId,
    stepId: null,
    kind: "screenshot",
    data: PIXEL_PNG,
    mime: "image/png",
    url: "https://example.test/",
    width: 1,
    height: 1,
    capturedAt: new Date().toISOString(),
    classification: "internal",
    protection: "none",
    allowedDestinations: ["panel"],
    retentionDays: 0,
  });

  const removed = await artifacts.deleteExpired(
    new Date(Date.now() + 1_000),
  );
  expect(removed).toBeGreaterThanOrEqual(1);
  expect(await repository.artifact(stored.id)).toBeUndefined();
  expect(await artifacts.read(stored.id)).toBeUndefined();
});

test("uma linha sem arquivo não é prometida: some e responde que não tem", async () => {
  const runId = await newRun();
  const artifacts = await store();
  const stored = await artifacts.capture({
    runId,
    stepId: null,
    kind: "screenshot",
    data: PIXEL_PNG,
    mime: "image/png",
    url: "https://example.test/",
    width: 1,
    height: 1,
    capturedAt: new Date().toISOString(),
    classification: "internal",
    protection: "none",
    allowedDestinations: ["panel"],
    retentionDays: 7,
  });

  // O caso de um volume trocado por baixo: a linha continua, os bytes não.
  await writeFile(stored.storagePath, "");
  const read = await artifacts.read(stored.id);
  expect(read?.bytes.byteLength).toBe(0);

  await rm(stored.storagePath);
  expect(await artifacts.read(stored.id)).toBeUndefined();
  expect(
    await database
      .select()
      .from(runArtifacts)
      .where(eq(runArtifacts.id, stored.id)),
  ).toHaveLength(0);
});
