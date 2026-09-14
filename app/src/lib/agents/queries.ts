import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * What a surface driving no Bot answers when asked which Bot it drives.
 *
 * Not a Bot id: no roster ever contains it, and the server answers 404 for it. It exists so a tool
 * handler always has a string to send, and it lives here — with the rest of what a Bot id is —
 * because a lookup keyed by a Bot id has to be able to recognise it.
 */
export const PLACEHOLDER_BOT_ID = "default";

export type AgentVisibility = "public" | "private";

/**
 * A coworker as the browser sees it.
 *
 * `canManage` and `systemOwned` are server-decided authorization facts; components render from the
 * returned flags rather than recomputing ownership rules.
 */
export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /**
   * O modelo que este Bot escolheu, quando escolheu um.
   *
   * Null é "o padrão do deployment" — a resposta do Bot que não decidiu nada —, e a tarefa herda
   * estes dois quando ela mesma não escolhe.
   */
  provider: string | null;
  model: string | null;
  /**
   * Se este Bot pode abrir endereços da rede interna deste deployment.
   *
   * Falso é o padrão, e é o que a ausência significa. Ligar isto dá ao navegador do Bot acesso aos
   * serviços que governam o deployment — inclusive à API que o governa.
   */
  allowPrivateNavigation: boolean;
  /** Whether a key is set for it. Never the key itself. */
  hasAuth: boolean;
  /**
   * Whether this coworker holds a credential for calling tools back.
   *
   * A boolean, because the token is readable exactly once: in the response that issued it. The
   * surface needs this only to decide between offering "generate" and "rotate".
   */
  hasCallbackToken: boolean;
  hidden: boolean;
  systemOwned: boolean;
  canManage: boolean;
  /**
   * Whether the signed-in person created this coworker.
   *
   * Separate from `canManage`, which is also true for administrators on everybody's coworkers. Split
   * a roster on `canManage` and an administrator's "mine" fills up with other people's work.
   */
  mine: boolean;
};

export const agentKeys = {
  all: ["agents"] as const,
  list: (hidden = false) => ["agents", "list", { hidden }] as const,
  detail: (agentId: string) => ["agents", "detail", agentId] as const,
};

export function agentListQueryOptions(hidden = false) {
  return queryOptions({
    queryKey: agentKeys.list(hidden),
    queryFn: (): Promise<AgentProfile[]> =>
      client(`/api/agents${hidden ? "?hidden=true" : ""}`, "agents", {
        fallback: "Não foi possível carregar os colegas",
      }),
  });
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: (): Promise<AgentProfile> =>
      client(`/api/agents/${agentId}`, "agent", {
        fallback: "Não foi possível carregar este colega",
      }),
  });
}

/** What the server said when it tried the endpoint. */
export type ConnectionVerdict =
  | { ok: true; events: string[] }
  | { ok: false; reason: string };

/**
 * Ask the server to reach a coworker's endpoint, from where a run will reach it.
 *
 * A plain function rather than a factory: the answer is about this moment, nothing caches it, and
 * there is no key for anything to invalidate. Fails closed, like the other verdicts here — an
 * endpoint that cannot be tested is reported as unreachable rather than thrown at the form.
 *
 * The unsaved key is sent so the test matches the form as it stands, not as it was last saved.
 */
export async function testAgentConnection(
  endpoint: string,
  key: string,
): Promise<ConnectionVerdict> {
  try {
    const response = await tryClient("/api/agents/test-connection", {
      method: "POST",
      body: {
        endpoint,
        ...(key.trim() ? { headers: { Authorization: key.trim() } } : {}),
      },
    });
    const body = (await response.json().catch(() => null)) as
      | ConnectionVerdict
      | { error?: string }
      | null;
    if (body && "ok" in body) return body;
    return {
      ok: false,
      reason:
        (body as { error?: string } | null)?.error ??
        "The connection could not be tested.",
    };
  } catch {
    return { ok: false, reason: "The connection could not be tested." };
  }
}
