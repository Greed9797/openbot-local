import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createAgentRunRoutes } from "../src/agent-runs/routes";
import type { AgentRunService } from "../src/agent-runs/service";
import type { AppVariables } from "../src/auth/guards";

function asActor(id: string, role: "admin" | "user" = "user"): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (context, next) => {
    context.set("actor", { id, email: `${id}@test`, role });
    await next();
  };
}

function fakeService(): AgentRunService {
  const runs = new Map<
    string,
    { id: string; botId: string; userId: string | null }
  >();
  return {
    async createRun(_actor, input, actorUserId) {
      if (input.idempotencyKey === "dup-key" && runs.has("dup-key")) {
        return { run: runs.get("dup-key") as never, created: false };
      }
      const run = {
        id: `run-${runs.size + 1}`,
        botId: input.botId,
        userId: actorUserId,
      } as never;
      if (input.idempotencyKey === "dup-key") runs.set("dup-key", run as never);
      return { run, created: true };
    },
    async getRun(id) {
      if (id === "other-run") return { id, botId: "livelab-bot", userId: "someone-else" } as never;
      if (id === "mine") return { id, botId: "vendas-bot", userId: "vendas-1" } as never;
      return undefined;
    },
    async listRuns(filters?: { botId?: string }) {
      const base = { threadId: null, origin: "web", provider: "p", model: "m", objective: "o", status: "queued", currentStep: 0, budget: {}, usage: {}, checkpoint: null, error: null, createdAt: new Date(), startedAt: null, finishedAt: null, metadata: {} };
      const all = [
        { ...base, id: "r1", botId: "vendas-bot", userId: "vendas-1" },
        { ...base, id: "r2", botId: "livelab-bot", userId: "vendas-1" },
      ];
      return (filters?.botId ? all.filter((r) => r.botId === filters.botId) : all) as never;
    },
  } as unknown as AgentRunService;
}

describe("run bot access", () => {
  test("denies createRun for a bot the actor cannot use", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/agent-runs",
      createAgentRunRoutes(fakeService(), asActor("vendas-1"), async () => false),
    );
    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "collect", botId: "livelab-bot" }),
    });
    expect(res.status).toBe(404);
  });

  test("duplicate idempotency key from another owner stays hidden", async () => {
    const service = fakeService();
    // Seed the duplicate owned by someone else on another bot.
    await service.createRun({ id: "owner" }, {
      botId: "livelab-bot",
      userId: "owner",
      origin: "web",
      objective: "collect",
      idempotencyKey: "dup-key",
    } as never, "owner");
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/agent-runs",
      createAgentRunRoutes(service, asActor("vendas-1"), async () => true),
    );
    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "dup-key",
      },
      body: JSON.stringify({ objective: "collect", botId: "vendas-bot" }),
    });
    // Owner mismatch → 404, no run leaked.
    expect(res.status).toBe(404);
  });

  test("run owned by another person answers as absent", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/api/agent-runs", createAgentRunRoutes(fakeService(), asActor("vendas-1"), async () => true));
    const res = await app.request("/api/agent-runs/other-run");
    expect(res.status).toBe(404);
  });

  test("missing botId is INVALID_ACTION, not silent default", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/api/agent-runs", createAgentRunRoutes(fakeService(), asActor("vendas-1"), async () => true));
    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "collect" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_ACTION");
  });

  test("listing a foreign bot answers as absent", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/agent-runs",
      createAgentRunRoutes(fakeService(), asActor("vendas-1"), async (_a, botId) => botId === "vendas-bot"),
    );
    const res = await app.request("/api/agent-runs?botId=livelab-bot");
    expect(res.status).toBe(404);
  });

  test("listing without filter hides runs on foreign bots", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/agent-runs",
      createAgentRunRoutes(fakeService(), asActor("vendas-1"), async (_a, botId) => botId === "vendas-bot"),
    );
    const res = await app.request("/api/agent-runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: { id: string }[] };
    expect(body.runs.map((r) => r.id)).toEqual(["r1"]);
  });
});
