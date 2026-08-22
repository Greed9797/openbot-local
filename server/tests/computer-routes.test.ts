import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

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
