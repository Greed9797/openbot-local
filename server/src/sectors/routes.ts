import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Database } from "../db/client";
import { requireAdmin, type AppVariables } from "../auth/guards";
import { checkNavigationTarget } from "../computer/target";
import { inviteEnrollment, resendEnrollment } from "../people/enrollments";
import { createSectorStore, type SectorStore } from "./store";

export function createSectorRoutes(
  database: Database,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  sectorsOverride?: SectorStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const sectors = sectorsOverride ?? createSectorStore(database);

  routes.get("/admin/sectors", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    try {
      return context.json({ sectors: await sectors.list() });
    } catch (error) {
      /*
       * The table is created by migration 0011, but a deployment whose database predates it (or
       * whose migrate step never ran) throws here. 503, not 500: the server is up, its database
       * is behind — retry the release's migrate step instead of reporting a bug.
       */
      console.error(
        "Setores indisponíveis: a tabela sectors não responde.",
        error,
      );
      return context.json(
        { error: "Setores indisponíveis: o banco precisa migrar." },
        503,
      );
    }
  });

  routes.post("/admin/sectors/:sectorId/enrollment", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as {
      email?: unknown;
      name?: unknown;
    } | null;
    if (typeof body?.email !== "string" || typeof body?.name !== "string") {
      return context.json({ error: "Email and name are required." }, 400);
    }
    try {
      const row = await inviteEnrollment(database, {
        email: body.email,
        name: body.name,
        sectorId: context.req.param("sectorId"),
        role: "user",
      });
      return context.json({ enrollment: row }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not invite.";
      const status =
        message.includes("already") || message.includes("invited") ? 409 : 400;
      return context.json({ error: message }, status as 400);
    }
  });

  routes.post(
    "/admin/sectors/:sectorId/enrollment/resend",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      const body = (await context.req.json().catch(() => null)) as {
        email?: unknown;
      } | null;
      if (typeof body?.email !== "string") {
        return context.json({ error: "Email is required." }, 400);
      }
      try {
        const row = await resendEnrollment(database, body.email);
        return context.json({ enrollment: row });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not resend.";
        return context.json({ error: message }, 400);
      }
    },
  );

  routes.get("/sectors/:sectorId/bots", requireUser, async (context) => {
    const sectorId = context.req.param("sectorId");
    if (context.var.actor.role !== "admin") {
      const all = await sectors.list();
      const sector = all.find((s) => s.id === sectorId);
      if (!sector || sector.ownerUserId !== context.var.actor.id) {
        return context.json({ error: "Not found." }, 404);
      }
    }
    return context.json({ bots: await sectors.botsOf(sectorId) });
  });

  routes.patch("/sectors/:sectorId/bots/:botId", requireUser, async (context) => {
    const sectorId = context.req.param("sectorId");
    const botId = context.req.param("botId");
    const existing = await sectors.sectorForBot(botId);
    if (existing !== sectorId) return context.json({ error: "Not found." }, 404);
    if (context.var.actor.role !== "admin") {
      const all = await sectors.list();
      const sector = all.find((s) => s.id === sectorId);
      if (!sector || sector.ownerUserId !== context.var.actor.id) {
        return context.json({ error: "Not found." }, 404);
      }
    }
    const body = (await context.req.json().catch(() => null)) as {
      accountLabel?: unknown;
      sellerUrl?: unknown;
      enabled?: unknown;
    } | null;
    if (
      body?.sellerUrl !== undefined &&
      body.sellerUrl !== null &&
      typeof body.sellerUrl === "string" &&
      body.sellerUrl.trim()
    ) {
      const verdict = checkNavigationTarget(body.sellerUrl.trim());
      if (!verdict.allowed) {
        return context.json({ error: verdict.reason }, 400);
      }
    }
    const row = await sectors.updateBot(botId, {
      ...(body?.accountLabel !== undefined
        ? {
            accountLabel:
              typeof body.accountLabel === "string"
                ? body.accountLabel.trim() || null
                : null,
          }
        : {}),
      ...(body?.sellerUrl !== undefined
        ? {
            sellerUrl:
              typeof body.sellerUrl === "string"
                ? body.sellerUrl.trim() || null
                : null,
          }
        : {}),
      ...(body?.enabled !== undefined
        ? { enabled: body.enabled === true }
        : {}),
    });
    if (!row) return context.json({ error: "Not found." }, 404);
    return context.json({ bot: row });
  });

  return routes;
}
