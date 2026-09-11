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
  app.route(
    "/api/agent-runs",
    createAgentRunRoutes(service, asActor(actor)),
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
});
