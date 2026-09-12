import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "../db/client";
import { userRoles } from "../db/schema";
import type { OpenBotRole } from "./roles";

export type AuthenticatedActor = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: OpenBotRole;
};

export type AuthService = {
  handler: (request: Request) => Response | Promise<Response>;
  api: {
    getSession: (input: {
      headers: Headers;
      query: { disableCookieCache: boolean };
    }) => Promise<{
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
      };
    } | null>;
  };
};

export type RoleRepository = {
  rolesForUser: (userId: string) => Promise<OpenBotRole[]>;
};

export type AppVariables = {
  actor: AuthenticatedActor;
  /**
   * Set when the caller is a Bot presenting a run assertion rather than a person with a session.
   *
   * Read by the computer routes to skip the session guard and the per-person Bot check, both of
   * which ask a question that has no answer for a Bot: which signed-in person is this. The actor is
   * still populated, from the assertion, because the audit row needs a name.
   */
  viaAgent?: boolean;
  /** The Bot the run assertion named, so a route addressed as `self` knows whose computer it is. */
  agentBotId?: string;
  /** The run the assertion named, so an agent acting call carries real audit identity. Human calls omit it. */
  agentRunId?: string;
};
export function createRoleRepository(database: Database): RoleRepository {
  return {
    rolesForUser: async (userId) => {
      const records = await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));

      return records.map((record) => record.role);
    },
  };
}

export function createRequireUser(
  auth: AuthService,
  roleRepository: RoleRepository,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
      query: { disableCookieCache: true },
    });

    if (!session) {
      return context.json({ error: "Authentication required." }, 401);
    }

    const roles = await roleRepository.rolesForUser(session.user.id);
    const role = roles.includes("admin")
      ? "admin"
      : roles.includes("user")
        ? "user"
        : undefined;

    if (!role) {
      return context.json({ error: "Authorization required." }, 403);
    }

    context.set("actor", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
      role,
    });
    await next();
  };
}

export function requireAdmin(context: Context<{ Variables: AppVariables }>) {
  if (context.var.actor.role !== "admin") {
    return context.json({ error: "Administrator access required." }, 403);
  }

  return undefined;
}
