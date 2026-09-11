/**
 * Chamadas HTTP aos provedores, com os dois erros que importam.
 *
 * A diferença entre "tente de novo" e "não adianta tentar" é a diferença entre uma resposta que
 * chegou tarde e um pedido que o provedor recusou. O loop usa isto: `retryable` decide se a chamada
 * é repetida, e uma recusa (400, 401, 403, 404, modelo inexistente, imagem não suportada) não gasta
 * as retentativas para depois falhar do mesmo jeito.
 */

/** O provedor não respondeu, respondeu com erro de servidor, ou pediu para esperar. Vale tentar de novo. */
export class ProviderUnavailableError extends Error {
  readonly retryable = true;

  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** O provedor respondeu recusando o pedido. Tentar de novo dá o mesmo resultado. */
export class ProviderRejectedError extends Error {
  readonly retryable = false;

  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderRejectedError";
  }
}

export type PostJsonOptions = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

/**
 * Um POST, e a resposta decodificada.
 *
 * O tempo limite é local a cada chamada porque um modelo pode demorar minutos: um limite global de
 * transporte acabaria matando um passo que estava apenas pensando, e a tarefa falharia por um motivo
 * que não é o dela.
 */
export async function postJson(
  options: PostJsonOptions,
): Promise<Record<string, unknown>> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  let response: Response;
  try {
    response = await doFetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(options.body),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ProviderUnavailableError(
        "A chamada ao modelo foi interrompida.",
      );
    }
    throw new ProviderUnavailableError(
      error instanceof Error && error.name === "TimeoutError"
        ? `O provedor não respondeu em ${options.timeoutMs} ms.`
        : `Não foi possível falar com o provedor: ${
            error instanceof Error ? error.message : "erro desconhecido"
          }`,
    );
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const detail = describeFailure(text);
    // 429 e 5xx são o provedor pedindo uma segunda chance; o resto é uma resposta a este pedido.
    const retryable = response.status === 429 || response.status >= 500;
    const message = `O provedor respondeu ${response.status}: ${detail}`;
    throw retryable
      ? new ProviderUnavailableError(message, response.status)
      : new ProviderRejectedError(message, response.status);
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderUnavailableError(
      `O provedor devolveu algo que não é JSON (${text.slice(0, 120)}).`,
    );
  }
}

/** O suficiente para uma pessoa entender o motivo, sem despejar a resposta inteira no passo. */
function describeFailure(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Não era JSON; o texto cru já diz o suficiente.
  }
  return text.slice(0, 300) || "sem detalhes";
}

/** Nunca um valor não-string entra numa mensagem. */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
