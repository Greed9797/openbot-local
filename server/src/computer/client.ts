import type { NavigateResult } from "./schema";
import { checkNavigationTarget } from "./target";

/** The computer did not accept or answer a request. */
export class ComputerUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerUnavailableError";
  }
}

/** The requested element is not on the current page. */
export class ElementNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ElementNotFoundError";
  }
}

/** The navigation target is not permitted. */
export class NavigationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NavigationRefusedError";
  }
}

/** The computer refused access to a path outside its workspace. */
export class WorkspaceRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRefusedError";
  }
}

/** The workspace request names a path or value that cannot be used. */
export class WorkspaceRequestError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRequestError";
  }
}

/** The page changed after the caller received its element references. */
export class StaleSnapshotError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StaleSnapshotError";
  }
}

/**
 * Transport options used inside the computer gateway.
 *
 * This is an internal seam. Application code uses ComputerGateway and does not
 * use this interface directly.
 */
export type ComputerTransportOptions = {
  token?: string;
  /**
   * Se o Bot pode NAVEGAR para dentro da rede deste deployment.
   *
   * Separado de `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS`, que responde outra pergunta: se um Bot pode
   * ser REGISTRADO num endereço interno — e a resposta ali é sim, porque `http://agent-codex:4202`
   * é exatamente onde os Bots deste deployment moram. As duas viviam na mesma variável, então
   * permitir o registro dos próprios Bots abria a rede interna para a navegação deles.
   *
   * O que isso valia na prática: `http://openbot:3001/api/admin/connectors` respondia ao navegador
   * do Bot, e num deployment de usuário único toda chamada que alcança aquela porta é de
   * administrador. Um Bot alcançando a API que o governa.
   */
  allowPrivateNavigation?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Internal HTTP interface used only by ComputerGateway. */
export interface ComputerTransport {
  call<T>(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  post<T>(
    baseUrl: string,
    botId: string,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  navigate(
    baseUrl: string,
    botId: string,
    url: string,
  ): Promise<NavigateResult>;
  /** Ler sem abrir. Passa pelo mesmo guarda de destino que `navigate`. */
  fetchPage(baseUrl: string, botId: string, url: string): Promise<unknown>;
}

/**
 * Send authenticated HTTP requests to one located agent-computer process.
 *
 * Lifecycle and location are deliberately absent. ComputerGateway owns those
 * operations through ComputerProvider.
 */
export function createComputerTransport(
  options: ComputerTransportOptions,
): ComputerTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 45_000;

  async function call<T>(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    timeoutMsOverride?: number,
  ): Promise<T> {
    if (caller?.aborted) {
      throw new ComputerUnavailableError("The action was stopped.");
    }

    /*
     * A browser action either happens in seconds or has gone wrong, so 45s is the right deadline for
     * it. A command is not that: the shell's own budget is 120s by default and up to 600s, and the
     * tool description tells the model to install packages. Giving up here first reported failure to
     * the person while the command carried on running to completion inside the container, and made
     * the shell's own limit unreachable. A caller with a longer limit of its own passes it in, and
     * this becomes the backstop rather than the limit.
     */
    const timeoutMs = timeoutMsOverride ?? defaultTimeoutMs;

    const target = baseUrl.replace(/\/$/, "");
    let response: Response;
    try {
      response = await doFetch(`${target}${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          "x-openbot-bot-id": botId,
          ...(options.token
            ? { "x-openbot-computer-token": options.token }
            : {}),
        },
        signal: caller
          ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ComputerUnavailableError(
        error instanceof Error && error.name === "TimeoutError"
          ? "The assistant's computer did not respond in time."
          : "The assistant's computer is not running.",
      );
    }

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      throwMappedError(response.status, body);
    }
    return body as T;
  }

  function post<T>(
    baseUrl: string,
    botId: string,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    return call<T>(
      baseUrl,
      botId,
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      caller,
      timeoutMs,
    );
  }

  async function navigate(
    baseUrl: string,
    botId: string,
    url: string,
  ): Promise<NavigateResult> {
    return post<NavigateResult>(baseUrl, botId, "/navigate", {
      url: aprovarDestino(url),
    });
  }

  /**
   * O mesmo guarda de `navigate`, e é o ponto: ler rápido é abrir uma página.
   *
   * `fetch` chegou depois, servido por outro motor, e passou direto — o gateway o governava pela
   * política e pela auditoria, mas nada olhava PARA ONDE ele apontava. Medido: pedir
   * `http://openbot:3001/api/admin/connectors` devolvia a resposta da própria API que governa este
   * Bot, e num deployment de usuário único toda chamada que alcança aquela porta é de administrador.
   *
   * Um caminho de leitura sem o guarda do outro é o guarda inteiro contornado por quem escrever
   * "leia" em vez de "abra".
   */
  async function fetchPage(
    baseUrl: string,
    botId: string,
    url: string,
  ): Promise<unknown> {
    return post<unknown>(baseUrl, botId, "/fetch", {
      url: aprovarDestino(url),
    });
  }

  function aprovarDestino(url: string): string {
    const verdict = checkNavigationTarget(url, {
      allowPrivateHosts: options.allowPrivateNavigation,
    });
    if (!verdict.allowed) {
      throw new NavigationRefusedError(verdict.reason);
    }
    return verdict.url;
  }

  return { call, post, navigate, fetchPage };
}

/** Map agent-computer responses to errors that a caller can act on. */
function throwMappedError(
  status: number,
  body: Record<string, unknown> | null,
): never {
  const detail =
    typeof body?.error === "string" ? body.error : `HTTP ${status}`;
  if (status === 409) {
    throw new StaleSnapshotError(detail);
  }
  if (status === 403) {
    throw new WorkspaceRefusedError(detail);
  }
  if (status === 400) {
    throw new WorkspaceRequestError(detail);
  }
  if (/waiting for locator|Timeout .* exceeded/i.test(detail)) {
    const ref = detail.match(/aria-ref=([A-Za-z0-9_-]+)/)?.[1];
    throw new ElementNotFoundError(
      `${ref ? `Element ${ref} is` : "That element is"} not on the page any more. Take a fresh snapshot and use the refs from it.`,
    );
  }
  throw new ComputerUnavailableError(detail);
}
