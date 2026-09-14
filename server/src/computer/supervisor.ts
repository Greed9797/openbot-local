/**
 * Where a Bot's computer lives, asked of the supervisor.
 *
 * Each Bot gets a container of its own, which means the address of a computer is no longer one
 * fixed URL, it is whatever port the supervisor published for that Bot, and it changes when the
 * computer is reset. So the server stops holding an address and starts asking for one.
 *
 * The server still never touches Docker. It asks for a Bot's computer by Bot; the supervisor decides
 * what that means. Everything the API server can express is in this file, and it is four verbs.
 *
 * Without a supervisor configured, nothing here is used and the fixed `AGENT_COMPUTER_URL` still
 * answers for every Bot. That is the single-container mode: fine for one person on a laptop, and
 * honest about being one shared computer.
 */

import type { ComputerLocation, ComputerProvider } from "./provider";
import type { ComputerStatus } from "./schema";

type SupervisorComputerLocation = {
  botId: string;
  container?: string;
  status: string;
  port?: number;
  /** Where to reach it, decided by the supervisor rather than assembled here. */
  url?: string;
  startedAt?: string;
};

export type SupervisorOptions = {
  baseUrl: string;
  token?: string;
  /** How a published port becomes a URL the server can reach. */
  hostForPort?: (port: number) => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Which sector slot a Bot belongs to, resolved from this deployment's own store.
   *
   * Set, every ensure carries the sector and the supervisor admits the computer into it; unset,
   * the supervisor admits on capacity alone. The value never comes from a caller: locate resolves
   * it here, from the authorised server side.
   */
  sectorForBot?: (botId: string) => string | null | Promise<string | null>;
};

export class SupervisorError extends Error {
  /** A machine-readable refusal that survives to the UI, when the supervisor sent one. */
  readonly code?: string;
  /** How long a refused caller waits before asking again, when the supervisor said. */
  readonly retryAfterMs?: number;
  constructor(message: string, options?: { code?: string; retryAfterMs?: number }) {
    super(message);
    this.name = "SupervisorError";
    if (options?.code !== undefined) this.code = options.code;
    if (options?.retryAfterMs !== undefined)
      this.retryAfterMs = options.retryAfterMs;
  }
}

export function createDockerSupervisorProvider(
  options: SupervisorOptions,
): ComputerProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const hostForPort =
    options.hostForPort ?? ((port) => `http://localhost:${port}`);

  async function call(
    path: string,
    method = "POST",
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SupervisorError(
        `The container supervisor at ${base} could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
      retryAfterMs?: number;
      stopped?: boolean;
      reset?: boolean;
      computers?: SupervisorComputerLocation[];
    } | null;
    if (!response.ok) {
      throw new SupervisorError(
        payload?.error ?? `The supervisor answered ${response.status}.`,
        {
          ...(typeof payload?.code === "string" ? { code: payload.code } : {}),
          ...(typeof payload?.retryAfterMs === "number"
            ? { retryAfterMs: payload.retryAfterMs }
            : {}),
        },
      );
    }
    return payload;
  }

  async function listRaw(): Promise<{
    computers: SupervisorComputerLocation[];
    maxComputers: number | null;
  }> {
    const body = (await call("/computers", "GET")) as {
      computers?: SupervisorComputerLocation[];
      maxComputers?: number;
    } | null;
    return {
      computers: body?.computers ?? [],
      maxComputers:
        typeof body?.maxComputers === "number" ? body.maxComputers : null,
    };
  }

  async function capacity(): Promise<{ maxComputers: number } | null> {
    const { maxComputers } = await listRaw();
    return maxComputers === null ? null : { maxComputers };
  }

  async function list(): Promise<ComputerLocation[]> {
    const { computers } = await listRaw();
    return computers.map((computer) => ({
      botId: computer.botId,
      status:
        computer.status.toLowerCase() === "running" ? "running" : "stopped",
      ...(computer.url
        ? { url: computer.url }
        : computer.port
          ? { url: hostForPort(computer.port) }
          : {}),
      ...(computer.startedAt ? { startedAt: computer.startedAt } : {}),
    }));
  }

  function statusFromLocation(
    botId: string,
    location: SupervisorComputerLocation | undefined,
  ): ComputerStatus {
    if (!location) return { botId, state: "absent" };

    const rawStatus = location.status.toLowerCase();
    switch (rawStatus) {
      case "running":
        return { botId, state: "ready" };
      case "created":
      case "restarting":
        return { botId, state: "starting" };
      case "paused":
      case "removing":
      case "exited":
        return { botId, state: "absent" };
      case "dead":
        return {
          botId,
          state: "unreachable",
          reason: `The computer reported state "${location.status}".`,
        };
      default:
        return {
          botId,
          state: "unreachable",
          reason: `The computer reported unknown state "${location.status}".`,
        };
    }
  }

  return {
    name: "Docker supervisor",
    isolation: "per-bot",

    /**
     * The URL of this Bot's computer, starting it if it is not already up.
     *
     * A computer that is running but has published no port is a computer nothing can reach, so that
     * is an error rather than a URL, the alternative is a caller quietly falling back to somebody
     * else's computer.
     */
    async locate(botId: string): Promise<string> {
      const sectorId = options.sectorForBot
        ? await options.sectorForBot(botId)
        : undefined;
      const state = (await call(
        `/computers/${encodeURIComponent(botId)}/ensure`,
        "POST",
        sectorId === undefined ? undefined : { sectorId },
      )) as SupervisorComputerLocation;
      // The supervisor says where it is, because only it knows whether these computers sit on a
      // shared network or answer on a published port.
      if (state?.url) return state.url;
      if (state?.port) return hostForPort(state.port);
      throw new SupervisorError(
        `The computer for ${botId} started but reported no address, so it cannot be reached.`,
      );
    },

    async status(botId: string): Promise<ComputerStatus> {
      try {
        const { computers } = await listRaw();
        return statusFromLocation(
          botId,
          computers.find((computer) => computer.botId === botId),
        );
      } catch (error) {
        return {
          botId,
          state: "unreachable",
          reason:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Unknown failure.",
        };
      }
    },

    async stop(botId: string): Promise<{ wasRunning: boolean }> {
      const result = (await call(
        `/computers/${encodeURIComponent(botId)}/stop`,
      )) as { stopped?: boolean } | null;
      return { wasRunning: result?.stopped === true };
    },

    async reset(botId: string): Promise<{ cleared: boolean }> {
      const result = (await call(
        `/computers/${encodeURIComponent(botId)}/reset`,
      )) as { reset?: boolean } | null;
      return { cleared: result?.reset === true };
    },

    list,
    capacity,
  };
}
