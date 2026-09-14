import { serve } from "bun";
import { Hono } from "hono";
import { deriveComputerToken } from "../../shared/computer-token";
import {
  BrowserCapacityError,
  DEFAULT_MAX_COMPUTERS,
  DockerUnavailableError,
  ensure,
  listOwned,
  reachable,
  reset,
  SectorConflictError,
  stop,
} from "./docker";
import { registerEntry } from "./identity";
import { namesFor } from "./names";

/**
 * The container supervisor: the only thing here that holds the Docker socket.
 *
 * Giving a Bot its own container requires something to create containers. Access to the Docker
 * socket is root-equivalent on the host because a container can be started with the host filesystem
 * bound into it. Putting that in the API server would mean every bug in a request handler, every
 * injection through a Bot's own output and every dependency in a large tree sits one mistake away
 * from owning the machine.
 *
 * So the socket lives behind four verbs, expressed in Bots rather than in Docker: ensure a computer
 * for this Bot, stop it, reset it, list them. There is no passthrough and no way to name a container
 * directly, names are derived from the Bot id, which is validated first. A compromised API server
 * can ask for a Bot's computer to be restarted. It cannot ask for anything else, because nothing
 * else is expressible.
 *
 * The shared secret is not the boundary; the vocabulary is. `SUPERVISOR_TOKEN` keeps other
 * processes on the same network from driving it, but even with the token the worst available action
 * is cycling a computer that already belongs to a Bot.
 *
 * Refusing to start without it matches the computer. This process holds the Docker socket, which is
 * root on the host, so missing authentication is a deployment failure.
 */

const port = Number.parseInt(process.env.PORT ?? "4300", 10);
const token = process.env.SUPERVISOR_TOKEN?.trim();
if (!token) {
  console.error(
    "SUPERVISOR_TOKEN is not set. This process holds the Docker socket and will not start without the secret its caller must present.",
  );
  process.exit(1);
}
const image = process.env.COMPUTER_IMAGE ?? "openbot-agent-computer:latest";
const network = process.env.COMPUTER_NETWORK;
const runtime = process.env.COMPUTER_RUNTIME;
const memoryBytes = process.env.COMPUTER_MEMORY_BYTES
  ? Number.parseInt(process.env.COMPUTER_MEMORY_BYTES, 10)
  : undefined;
const spireSocketVolume = process.env.SPIRE_AGENT_SOCKET_VOLUME;
/*
 * The master behind every computer's credential. Each computer receives only its own derived
 * token, so this process refuses to start without the master: a supervisor that could only hand
 * out dead computers would be worse than one that says so at boot.
 */
const computerTokenMaster = process.env.COMPUTER_TOKEN?.trim();
if (!computerTokenMaster) {
  console.error(
    "COMPUTER_TOKEN is not set. The supervisor derives each computer's credential from it, and will not start computers it cannot credential.",
  );
  process.exit(1);
}
/*
 * How many computers may be live at once. Six residents, one per sector, and no seventh browser
 * on the host. Must be a positive integer; anything else refuses to boot rather than silently
 * running unbounded.
 */
const maxComputers = (() => {
  const raw = process.env.COMPUTER_MAX_COMPUTERS?.trim();
  if (!raw) return DEFAULT_MAX_COMPUTERS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(
      "COMPUTER_MAX_COMPUTERS must be a positive integer.",
    );
    process.exit(1);
  }
  return parsed;
})();
/*
 * Sector ids this supervisor admits, when the deployment places computers into sectors. Unset,
 * any request is admitted on capacity alone, which is the laptop shape; set, only these ids are
 * accepted and a request without one is refused.
 */
const sectorAllowlist = (() => {
  const raw = process.env.COMPUTER_SECTORS?.trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
})();

/**
 * What a computer is told about itself.
 *
 * The egress variables come through so a Bot's traffic still leaves by the route configured for it;
 * everything else a computer needs it already has. Nothing here is caller-supplied: a request says
 * which Bot, never what to run or what to set.
 */
function environmentFor(botId: string): string[] {
  const passthrough = Object.entries(process.env).filter(([key]) =>
    key.startsWith("EGRESS_PROXY"),
  );
  /*
   * The secret the computer demands of its callers. Handed to every container this creates, from
   * this process's own environment, so the server and the computers share one secret and nothing else
   * can drive a Bot's browser. Never caller-supplied: a request says which Bot, never what
   * to set.
   */
  // One credential per computer, derived from the master above. The container never sees the
  // master, so a credential taken from one Bot's computer authenticates nowhere else.
  const computerToken = deriveComputerToken(
    computerTokenMaster as string,
    botId,
  );
  return [
    // Which Bot this container is. Read by the computer as the Bot to assume when a request does not
    // name one. It is normally named per request, so this is the fallback, and for a container that
    // exists to be one Bot's the fallback must be that Bot rather than the shared default.
    `COMPUTER_BOT_ID=${botId}`,
    // Without this the computer refuses to start; it must never answer an unauthenticated caller.
    ...(computerToken ? [`COMPUTER_TOKEN=${computerToken}`] : []),
    // Where to ask what it is. Absent, the computer reports no identity and carries on.
    ...(spireSocketVolume
      ? ["SPIFFE_ENDPOINT_SOCKET=/tmp/spire-agent/public/api.sock"]
      : []),
    ...passthrough.map(([key, value]) => `${key}=${value ?? ""}`),
  ];
}

const app = new Hono();

app.use("*", async (context, next) => {
  // Health is open so an orchestrator can check it without holding the token.
  if (context.req.path === "/health") return next();
  if (context.req.header("authorization") !== `Bearer ${token}`) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  return next();
});

app.get("/health", async (context) =>
  context.json({ status: "ok", docker: await reachable() }),
);

/** The Bot id in the path, validated before it becomes any kind of name. */
function resolve(raw: string) {
  return namesFor(raw);
}

app.post("/computers/:botId/ensure", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  // The sector comes from the authorised server's own lookup, never from the requester beyond it:
  // callers name a Bot, and the server says which sector that Bot belongs to, if any.
  const body = (await context.req.json().catch(() => null)) as {
    sectorId?: unknown;
  } | null;
  const sectorId =
    typeof body?.sectorId === "string" && body.sectorId.trim().length > 0
      ? body.sectorId.trim()
      : null;

  try {
    // Registered before the computer is handed out, so it can prove which Bot it is from its first
    // request.
    const identity = await registerEntry(parsed.names);

    const state = await ensure(parsed.names, {
      image,
      environment: environmentFor(parsed.names.botId),
      ...(network ? { network } : {}),
      ...(runtime ? { runtime } : {}),
      ...(memoryBytes ? { memoryBytes } : {}),
      ...(spireSocketVolume ? { spireSocketVolume } : {}),
      ...(sectorId ? { sectorId } : {}),
      ...(sectorAllowlist ? { sectorAllowlist } : {}),
      maxComputers,
    });
    return context.json({
      ...state,
      ...(identity.registered
        ? { spiffeId: identity.spiffeId }
        : { identity: identity.reason }),
    });
  } catch (error) {
    if (error instanceof BrowserCapacityError) {
      // The wire carries the busy-slot route's code, not the class's: the server and the UI match
      // on this string, and it must not change with a refactor of the supervisor's internals.
      return context.json(
        {
          error: error.message,
          code: "COMPUTER_BUSY_SLOT",
          retryAfterMs: error.retryAfterMs,
        },
        429,
      );
    }
    if (error instanceof SectorConflictError) {
      return context.json({ error: error.message, code: error.code }, 409);
    }
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/stop", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const stopped = await stop(parsed.names);
    return context.json({ stopped });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/reset", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const wasThere = await reset(parsed.names);
    return context.json({ reset: wasThere });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.get("/computers", async (context) => {
  try {
    return context.json({
      computers: await listOwned(),
      maxComputers,
    });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

serve({ port, fetch: app.fetch, idleTimeout: 120 });

console.info(
  `Supervisor listening on http://localhost:${port} (image ${image}${runtime ? `, runtime ${runtime}` : ""})`,
);
