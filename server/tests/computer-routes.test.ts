import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes, refusalOf } from "../src/computer/routes";
import { SupervisorError } from "../src/computer/supervisor";

describe("computer routes", () => {
  test("gets a screenshot through the governed computer gateway", async () => {
    const requestedBotIds: string[] = [];
    const gateway = {
      screenshot: async (botId: string) => {
        requestedBotIds.push(botId);
        return { image: "aGVsbG8=", mimeType: "image/png" as const };
      },
    } as unknown as ComputerGateway;
    const policyStore = {} as PolicyStore;
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      _context,
      next,
    ) => next();
    // Permissive: what this covers is the gateway seam, not who may act as the Bot. That question
    // has its own suite in bot-access.test.ts.
    const routes = createComputerRoutes(
      gateway,
      policyStore,
      requireUser,
      async () => true,
    );

    const response = await routes.request(
      "http://openbot.test/bot-17/screenshot",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      image: "aGVsbG8=",
      mimeType: "image/png",
    });
    expect(requestedBotIds).toEqual(["bot-17"]);
  });
});
/**
 * The composed fill over HTTP carries the signed run, never a fabricated or body-claimed one.
 *
 * What this fixes is who the audit row names: the fill-form route used to execute with a
 * placeholder run, so every composed fill was recorded under an identity no run ever had. A Bot
 * now arrives with the assertion this deployment signed, and a person arrives with no run at all.
 */
describe("a refused computer start", () => {
  test("answers 429 with the supervisor's code and wait, not a 500", async () => {
    const gateway = {
      screenshot: async () => {
        throw new SupervisorError("No room for another computer.", {
          code: "COMPUTER_BUSY_SLOT",
          retryAfterMs: 30_000,
        });
      },
    } as unknown as ComputerGateway;
    const routes = createComputerRoutes(
      gateway,
      {} as PolicyStore,
      (async (_context, next) => next()) as MiddlewareHandler<{
        Variables: AppVariables;
      }>,
      async () => true,
    );
    const response = await routes.request(
      "http://openbot.test/bot-17/screenshot",
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "No room for another computer.",
      code: "COMPUTER_BUSY_SLOT",
      retryAfterMs: 30_000,
    });
  });

  test("an ordinary failure carries no refusal fields", () => {
    expect(refusalOf(new Error("boom"))).toEqual({});
    expect(
      refusalOf(
        new SupervisorError("unreachable", { code: "SOME_OTHER_CODE" }),
      ),
    ).toEqual({});
  });
});

describe("run identity on composed and read routes", () => {
  const seenActors: unknown[] = [];
  const gateway = {
    snapshot: async () => ({
      snapshotId: 9,
      url: "https://loja.test/entrega",
      title: "Entrega",
      truncated: false,
      viewport: { width: 1280, height: 800 },
      elements: [{ ref: "e1", role: "textbox", name: "Nome" }],
    }),
    type: async (_botId: string, actor: unknown, input: { text: string }) => {
      seenActors.push(actor);
      return {
        action: "type",
        characters: input.text.length,
        url: "https://loja.test/entrega",
        elapsedMs: 40,
      };
    },
    select: async () => {
      throw new Error("não deveria selecionar neste formulário");
    },
    fetch: async (_botId: string, actor: unknown, url: string) => {
      seenActors.push(actor);
      return { url, title: "Preços", text: "Caderno: 29.90", links: [] };
    },
  } as unknown as ComputerGateway;
  const policyStore = {
    get: () => ({ mode: "enforce", deny: [], allow: [] }),
  } as unknown as PolicyStore;

  const fillBody = {
    values: [{ label: "Nome", value: "Marina" }],
    runId: "forged-in-body",
  };

  test("a Bot call records the signed run and ignores what the body claimed", async () => {
    seenActors.length = 0;
    const routes = createComputerRoutes(
      gateway,
      policyStore,
      asActor(member),
      async () => true,
      async () => ({ botId: "bot-1", actorId: "user-9", runId: "run-signed" }),
    );
    const response = await routes.request(
      "http://openbot.test/bot-1/fill-form",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": "obot_agt_presented",
          "x-openbot-run": "signed-assertion",
        },
        body: JSON.stringify(fillBody),
      },
    );
    expect(response.status).toBe(200);
    expect(seenActors).toEqual([
      { id: "user-9", userId: "user-9", runId: "run-signed" },
    ]);
    const payload = (await response.json()) as {
      ok: boolean;
      result: { filled: unknown[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.result.filled).toEqual([{ label: "Nome", ref: "e1" }]);
  });

  test("a person calling the same route records no run", async () => {
    seenActors.length = 0;
    const routes = createComputerRoutes(
      gateway,
      policyStore,
      asActor(member),
      async () => true,
      async () => ({ botId: "bot-1", actorId: "user-9", runId: "run-signed" }),
    );
    const response = await routes.request(
      "http://openbot.test/bot-1/fill-form",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fillBody),
      },
    );
    expect(response.status).toBe(200);
    expect(seenActors).toEqual([{ id: "user-1", userId: "user-1" }]);
  });

  test("a presented token the deployment does not recognise is refused before the gateway", async () => {
    let typed = 0;
    const counting = {
      ...gateway,
      snapshot: async () => {
        typed += 1;
        return gateway.snapshot("bot-1");
      },
    } as unknown as ComputerGateway;
    const routes = createComputerRoutes(
      counting,
      policyStore,
      asActor(member),
      async () => true,
      async () => null,
    );
    const response = await routes.request(
      "http://openbot.test/bot-1/fill-form",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": "unknown-token",
          "x-openbot-run": "whatever",
        },
        body: JSON.stringify(fillBody),
      },
    );
    expect(response.status).toBe(401);
    expect(typed).toBe(0);
  });

  test("an agent fetch records the same signed run as the acting routes", async () => {
    seenActors.length = 0;
    const routes = createComputerRoutes(
      gateway,
      policyStore,
      asActor(member),
      async () => true,
      async () => ({ botId: "bot-1", actorId: "user-9", runId: "run-signed" }),
    );
    const response = await routes.request("http://openbot.test/bot-1/fetch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": "obot_agt_presented",
        "x-openbot-run": "signed-assertion",
      },
      body: JSON.stringify({ url: "https://loja.test/precos" }),
    });
    expect(response.status).toBe(200);
    expect(seenActors).toEqual([
      { id: "user-9", userId: "user-9", runId: "run-signed" },
    ]);
    await expect(response.json()).resolves.toMatchObject({ title: "Preços" });
  });
});

/**
 * The fleet listing is the one route here that is not about the Bot in its path.
 *
 * `:botId` is ignored and the handler returns every computer, so a signed-in person asking about a
 * Bot they own learned every Bot id in the deployment and whether its computer was running,
 * private coworkers included. Being signed in is not the question; administering the deployment is.
 */
const member: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

const administrator: AuthenticatedActor = {
  id: "admin-1",
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

function appFor(
  actor: AuthenticatedActor,
  computers: () => Promise<unknown>,
  /**
   * Permissivo por padrão. Se esta pessoa pode dirigir o Bot do caminho é outra pergunta, com a
   * própria suíte, e não é sobre isso que estas rotas respondem — mas um teste aqui embaixo precisa
   * poder recusar todo Bot, que é como um deployment com registro de agentes trata um id inventado.
   */
  canUseBot: () => Promise<boolean> = async () => true,
) {
  let listed = 0;
  const countingGateway = {
    async computers() {
      listed += 1;
      return computers();
    },
  } as ComputerGateway;

  return {
    app: createComputerRoutes(
      countingGateway,
      {
        get: () => ({ mode: "enforce", deny: [], allow: [] }),
      } as unknown as PolicyStore,
      asActor(actor),
      canUseBot,
    ),
    listed: () => listed,
  };
}

/**
 * A frota não é de um Bot, e o endereço dela diz isso.
 *
 * Enquanto ela morou em `/:botId/computers`, o guarda que pergunta se esta pessoa pode dirigir o Bot
 * do caminho rodava antes — e como o id ali era um marcador, não um Bot, num deployment com registro
 * de agentes a resposta virava 404 e a tela de Computadores ficava vazia sem uma queixa.
 */
describe("computer fleet listing", () => {
  test("refuses a signed-in user the fleet, and does not ask the gateway", async () => {
    const { app, listed } = appFor(member, async () => ({
      isolation: "per-bot",
      computers: [
        { botId: "private-coworker", running: true, startedAt: null },
      ],
    }));

    const response = await app.request("http://openbot.test/fleet");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
    // Refused before the gateway is asked: a check that runs after the fleet has been read is not a
    // check, it is a filter on the response.
    expect(listed()).toBe(0);
  });

  /**
   * O guarda de Bot não pode alcançar o que não é de um Bot.
   *
   * `/:botId/*` casa um caminho de um segmento só, então `/policy` entrava nele com `botId` valendo
   * "policy". Num deployment sem registro de agentes `canUseBot` responde sim a tudo e nada aparece;
   * num deployment com registro, não existe Bot chamado "policy" e a resposta vira 404. O sintoma
   * não é um erro na tela: é a de Limites abrindo como se não houvesse regra nenhuma configurada, e
   * a de Computadores como se este deployment não tivesse nenhum.
   */
  test("a política e a frota não passam pelo guarda de Bot", async () => {
    const recusaTodoBot = async () => false;
    const { app } = appFor(
      administrator,
      async () => ({ isolation: "per-bot", computers: [] }),
      recusaTodoBot,
    );

    expect((await app.request("http://openbot.test/policy")).status).toBe(200);
    expect((await app.request("http://openbot.test/fleet")).status).toBe(200);
  });

  test("lets an administrator see the fleet", async () => {
    const fleet = {
      isolation: "per-bot" as const,
      computers: [
        {
          botId: "private-coworker",
          running: true,
          startedAt: "2026-08-20T00:00:00.000Z",
          egress: null,
        },
      ],
    };
    const { app, listed } = appFor(administrator, async () => fleet);

    const response = await app.request("http://openbot.test/fleet");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(fleet);
    expect(listed()).toBe(1);
  });
});
