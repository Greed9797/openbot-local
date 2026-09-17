import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createSectorRoutes } from "../src/sectors/routes";

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

/*
 * The seam isolates `list` only: the other two sector paths (`botsOf`,
 * `sectorForBot`, `updateBot`) keep the real store. A stub here is `{ list }`
 * cast to the full type because the factory signature takes the whole store;
 * calling the other paths against this stub would TypeError, so only
 * `GET /admin/sectors` is exercised through it.
 */
function appWith(
  sectors: { list: () => Promise<unknown[]> },
  role: "admin" | "user" = "admin",
) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: ADMIN.id,
      email: ADMIN.email,
      name: ADMIN.name,
      image: ADMIN.image,
      role,
    });
    await next();
  };
  const app = new Hono();
  app.route(
    "/api",
    createSectorRoutes({} as never, requireUser, sectors as never),
  );
  return (path: string) => app.request(`http://openbot.test${path}`);
}

describe("sector routes", () => {
  test("lists the sectors for an administrator", async () => {
    const request = appWith({
      list: async () => [{ id: "websites", name: "Websites" }],
    });

    const response = await request("/api/admin/sectors");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sectors: [{ id: "websites", name: "Websites" }],
    });
  });

  // A plain user reading the list would learn every sector's shape, which is not theirs to have.
  test("refuses the list to somebody who is not an administrator", async () => {
    const request = appWith({ list: async () => [] }, "user");

    expect((await request("/api/admin/sectors")).status).toBe(403);
  });

  /*
   * Behind database answers 503, not 500. The server is up; its database predates migration 0011
   * (or the migrate step never ran). A 500 reads as a bug in this route; a 503 names the cure:
   * run the release's migrate step.
   */
  test("says the database must migrate when the table is missing", async () => {
    const request = appWith({
      list: async () => {
        throw new Error('relation "sectors" does not exist');
      },
    });

    const response = await request("/api/admin/sectors");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Setores indisponíveis: o banco precisa migrar.",
    });
  });
});
