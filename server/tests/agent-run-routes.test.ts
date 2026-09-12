/**
 * The task routes, over the real service and database.
 *
 * The rules worth pinning here are the ones a caller can see: a retried request does not create a
 * second task, a run id belonging to somebody else answers exactly like a run that does not exist,
 * and pausing a finished run is refused rather than absorbed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { inArray } from "drizzle-orm";
import { createAgentRunRepository } from "../src/agent-runs/repository";
import { createAgentRunRoutes } from "../src/agent-runs/routes";
import { createAgentRunService } from "../src/agent-runs/service";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { agentRuns } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "../src/agent-runtime/artifact-store";
import type { ComputerGateway } from "../src/computer/gateway";
import type { RunVision } from "../src/agent-runs/routes";

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
    provider: "test-provider",
    model: "test-model",
    budget: { maxSteps: 10, maxMs: 60_000, maxCorrections: 1 },
    leaseTtlMs: 30_000,
  },
});

const created: string[] = [];

const member: AuthenticatedActor = {
  id: "route-user-a",
  email: "a@openbot.test",
  role: "user",
};
const other: AuthenticatedActor = {
  id: "route-user-b",
  email: "b@openbot.test",
  role: "user",
};
const administrator: AuthenticatedActor = {
  id: "route-admin",
  email: "admin@openbot.test",
  role: "admin",
};

function asActor(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function appFor(actor: AuthenticatedActor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/agent-runs", createAgentRunRoutes(service, asActor(actor)));
  return app;
}

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** As rotas de imagem, com um computador de mentira e um armazém de verdade. */
async function visionFor(
  options: { screenshotUrl?: string; masked?: number } = {},
): Promise<RunVision> {
  const root = await mkdtemp(join(tmpdir(), "openbot-route-artifacts-"));
  return {
    gateway: {
      screenshot: async () => ({
        base64: PIXEL_PNG,
        width: 1280,
        height: 800,
        capturedAt: "2026-09-11T10:00:00.000Z",
        url: options.screenshotUrl ?? "https://exemplo.test/form",
        masked: options.masked ?? 0,
      }),
    } as unknown as ComputerGateway,
    artifacts: createArtifactStore({ repository, root, retentionDays: 7 }),
    sensitiveHosts: ["banco.test"],
    retentionDays: 7,
  };
}

function appWithVision(actor: AuthenticatedActor, vision?: RunVision) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/agent-runs",
    createAgentRunRoutes(service, asActor(actor), vision),
  );
  return app;
}

async function create(
  actor: AuthenticatedActor,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await appFor(actor).request("/api/agent-runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as {
    run?: { id: string };
    created?: boolean;
    error?: string;
  };
  if (payload.run?.id) created.push(payload.run.id);
  return { response, payload };
}

afterAll(async () => {
  if (created.length) {
    await database.delete(agentRuns).where(inArray(agentRuns.id, created));
  }
});

describe("task routes", () => {
  test("a retried creation is the same task", async () => {
    const key = `route-key-${crypto.randomUUID()}`;
    const first = await create(
      member,
      { botId: "bot-routes", objective: "Abrir a página." },
      { "idempotency-key": key },
    );
    expect(first.response.status).toBe(201);

    const second = await create(
      member,
      { botId: "bot-routes", objective: "Abrir a página." },
      { "idempotency-key": key },
    );
    expect(second.response.status).toBe(200);
    expect(second.payload.created).toBe(false);
    expect(second.payload.run?.id).toBe(first.payload.run?.id);
  });

  test("refuses a task with no objective", async () => {
    const { response, payload } = await create(member, { botId: "bot-routes" });
    expect(response.status).toBe(400);
    expect(payload.error).toContain("objective");
  });

  test("lists only the runs the caller owns, unless the caller administers the deployment", async () => {
    const mine = await create(member, {
      botId: "bot-routes",
      objective: "Minha tarefa.",
    });
    const theirs = await create(other, {
      botId: "bot-routes",
      objective: "Tarefa de outra pessoa.",
    });

    const mineList = (await (
      await appFor(member).request("/api/agent-runs")
    ).json()) as { runs: { id: string }[] };
    expect(mineList.runs.map((run) => run.id)).toContain(mine.payload.run?.id);
    expect(mineList.runs.map((run) => run.id)).not.toContain(
      theirs.payload.run?.id,
    );

    const theirsList = (await (
      await appFor(administrator).request("/api/agent-runs")
    ).json()) as { runs: { id: string }[] };
    expect(theirsList.runs.map((run) => run.id)).toContain(
      theirs.payload.run?.id,
    );
  });

  test("a run belonging to somebody else answers as if it did not exist", async () => {
    const theirs = await create(other, {
      botId: "bot-routes",
      objective: "Tarefa alheia.",
    });
    const read = await appFor(member).request(
      `/api/agent-runs/${theirs.payload.run?.id}`,
    );
    expect(read.status).toBe(404);
    const steps = await appFor(member).request(
      `/api/agent-runs/${theirs.payload.run?.id}/steps`,
    );
    expect(steps.status).toBe(404);
  });

  test("pause, resume and cancel answer with the run's real state", async () => {
    const { payload } = await create(member, {
      botId: "bot-routes",
      objective: "Tarefa para pausar.",
    });
    const id = payload.run?.id;

    const paused = (await (
      await appFor(member).request(`/api/agent-runs/${id}/pause`, {
        method: "POST",
      })
    ).json()) as { run: { status: string } };
    expect(paused.run.status).toBe("paused");

    const resumed = (await (
      await appFor(member).request(`/api/agent-runs/${id}/resume`, {
        method: "POST",
      })
    ).json()) as { run: { status: string } };
    expect(resumed.run.status).toBe("queued");

    const cancelled = (await (
      await appFor(member).request(`/api/agent-runs/${id}/cancel`, {
        method: "POST",
      })
    ).json()) as { run: { status: string } };
    expect(cancelled.run.status).toBe("cancelled");

    const refused = await appFor(member).request(
      `/api/agent-runs/${id}/pause`,
      { method: "POST" },
    );
    expect(refused.status).toBe(409);
  });

  test("events are readable from a cursor", async () => {
    const { payload } = await create(member, {
      botId: "bot-routes",
      objective: "Tarefa com eventos.",
    });
    const response = await appFor(member).request(
      `/api/agent-runs/${payload.run?.id}/events?after=0`,
    );
    const body = (await response.json()) as {
      events: { seq: number; type: string }[];
    };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events[0]?.type).toBe("run.created");
  });

  test("a completion condition is validated and persisted, never forged", async () => {
    const bad = await create(member, {
      botId: "bot-routes",
      objective: "Tarefa com condição inválida.",
      completion: { kind: "javascript", run: "alert(1)" },
    });
    expect(bad.response.status).toBe(400);

    const badUrl = await create(member, {
      botId: "bot-routes",
      objective: "Tarefa com URL inválida.",
      completion: { kind: "page_url", url: "ftp://example.test/x" },
    });
    expect(badUrl.response.status).toBe(400);

    const good = await create(member, {
      botId: "bot-routes",
      objective: "Tarefa com condição.",
      completion: { kind: "page_text", text: "Pedido 42 confirmado" },
      metadata: {
        tag: "minha-etiqueta",
        verified: true,
        verification: { ok: true },
        completion: { kind: "page_url", url: "https://forjado.test/" },
      },
    });
    expect(good.response.status).toBe(201);
    const read = (await (
      await appFor(member).request(`/api/agent-runs/${good.payload.run?.id}`)
    ).json()) as {
      run: {
        metadata: Record<string, unknown>;
        usage: Record<string, unknown>;
      };
    };
    // A condição tipada persiste; chaves reservadas do corpo não forjam prova.
    expect(read.run.metadata).toMatchObject({
      tag: "minha-etiqueta",
      completion: { kind: "page_text", text: "Pedido 42 confirmado" },
    });
    expect("verified" in read.run.metadata).toBe(false);
    expect("verification" in read.run.metadata).toBe(false);
    // A visão da API carrega tentativas (vazias aqui), sem prompt nem segredo.
    expect(read.run.usage).toMatchObject({
      steps: 0,
      modelCalls: 0,
      attempts: [],
    });
  });
});

/**
 * A imagem de uma tarefa: capturar, classificar, guardar e servir.
 *
 * O que se fixa aqui é o caminho do PRD — a captura vira artefato com classificação e destinos, os
 * bytes saem por um endereço próprio, e um artefato de outra pessoa responde como inexistente. Sem
 * esta última parte, um id adivinhado leria a tela de outro usuário.
 */
describe("imagem de uma tarefa", () => {
  test("a captura vira artefato, e os bytes saem pelo endereço do artefato", async () => {
    const { payload } = await create(member, {
      botId: "bot-routes",
      objective: "Ver a tela.",
    });
    const id = payload.run?.id;
    const app = appWithVision(member, await visionFor({ masked: 2 }));

    const captured = await app.request(`/api/agent-runs/${id}/screenshot`, {
      method: "POST",
    });
    expect(captured.status).toBe(200);
    const body = (await captured.json()) as {
      artifact: {
        id: string;
        mime: string;
        classification: string;
        protection: string;
        allowedDestinations: string[];
      };
    };
    expect(body.artifact.mime).toBe("image/png");
    expect(body.artifact.classification).toBe("internal");
    expect(body.artifact.protection).toBe("masked");
    expect(body.artifact.allowedDestinations).toContain("model");

    const bytes = await app.request(
      `/api/agent-runs/${id}/artifacts/${body.artifact.id}`,
    );
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect(bytes.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await bytes.arrayBuffer()).toString("base64")).toBe(
      PIXEL_PNG,
    );
  });

  test("uma página sensível fica retida para o painel e não vai ao modelo", async () => {
    const { payload } = await create(member, {
      botId: "bot-routes",
      objective: "Ver a tela do banco.",
    });
    const app = appWithVision(
      member,
      await visionFor({ screenshotUrl: "https://app.banco.test/extrato" }),
    );
    const captured = (await (
      await app.request(`/api/agent-runs/${payload.run?.id}/screenshot`, {
        method: "POST",
      })
    ).json()) as {
      artifact: { classification: string; allowedDestinations: string[] };
    };
    expect(captured.artifact.classification).toBe("sensitive");
    expect(captured.artifact.allowedDestinations).toEqual(["panel"]);
  });

  test("o artefato de outra pessoa responde como inexistente", async () => {
    const mine = await create(member, {
      botId: "bot-routes",
      objective: "Minha tela.",
    });
    const theirs = await create(other, {
      botId: "bot-routes",
      objective: "Tela alheia.",
    });
    const vision = await visionFor();
    const app = appWithVision(member, vision);

    const captured = (await (
      await app.request(`/api/agent-runs/${mine.payload.run?.id}/screenshot`, {
        method: "POST",
      })
    ).json()) as { artifact: { id: string } };

    // O mesmo artefato, pedido sob a tarefa de outra pessoa.
    const stolen = await app.request(
      `/api/agent-runs/${theirs.payload.run?.id}/artifacts/${captured.artifact.id}`,
    );
    expect(stolen.status).toBe(404);

    // E a tarefa de outra pessoa nem pode ser vista por quem não é dono dela.
    const wrongOwner = await app.request(
      `/api/agent-runs/${theirs.payload.run?.id}/screenshot`,
      { method: "POST" },
    );
    expect(wrongOwner.status).toBe(404);
  });

  test("sem navegador ligado, a rota diz isso em vez de falhar por dentro", async () => {
    const { payload } = await create(member, {
      botId: "bot-routes",
      objective: "Sem visão.",
    });
    const app = appWithVision(member, undefined);
    const response = await app.request(
      `/api/agent-runs/${payload.run?.id}/screenshot`,
      { method: "POST" },
    );
    expect(response.status).toBe(503);
  });
});
