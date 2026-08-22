import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Entrar no Google como uma pessoa, e não como uma organização.
 *
 * A conta de serviço com delegação em todo o domínio continua existindo ao lado disto, e para uma
 * empresa continua sendo o caminho certo: ela concede "leia estas pastas" uma vez, no Admin, sem
 * depender de ninguém clicar. O que ela não faz é funcionar numa conta pessoal — delegação em todo o
 * domínio pressupõe um domínio, e uma conta @gmail.com não tem Admin Console onde autorizar o client
 * id. Configurar conta de serviço ali é um caminho que nunca termina: o Google aceita a chave,
 * devolve um token válido para a própria conta de serviço, e a sincronização termina com sucesso e
 * zero arquivos.
 *
 * Por isso este arquivo. Quem consente é a pessoa dona do Drive, no navegador dela, e o que volta é
 * um refresh token que vale para a conta dela e mais nenhuma.
 */

const AUTHORISE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ABOUT_URL = "https://www.googleapis.com/drive/v3/about";

/** Só leitura. Nada aqui precisa poder escrever no Drive de ninguém. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Quanto tempo um pedido de consentimento continua sendo aceito de volta. */
const STATE_TTL_MS = 10 * 60 * 1000;

export type GoogleOAuthClient = {
  clientId: string;
  clientSecret: string;
  /** Exatamente o mesmo que está registrado no Google Cloud, caractere por caractere. */
  redirectUri: string;
};

export type GoogleTokens = {
  accessToken: string;
  /** Ausente quando o Google decide não emitir um novo — ver `buildAuthorisationUrl`. */
  refreshToken: string | null;
  expiresInSeconds: number;
};

/**
 * Para onde mandar a pessoa consentir.
 *
 * `access_type=offline` com `prompt=consent` juntos, e não só o primeiro: o Google emite refresh
 * token uma única vez por concessão, então quem já autorizou este client antes volta do fluxo com um
 * access token de uma hora e nenhum refresh token. Como o refresh token é a única coisa que faz a
 * sincronização continuar existindo amanhã, forçar a tela de consentimento é o que separa "conectado"
 * de "conectado até o fim da tarde".
 */
export function buildAuthorisationUrl(
  client: Pick<GoogleOAuthClient, "clientId" | "redirectUri">,
  state: string,
): string {
  const url = new URL(AUTHORISE_URL);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * O bilhete que prova que esta volta corresponde àquela ida.
 *
 * Sem ele o endpoint de callback aceita um `code` de qualquer um: alguém faz o próprio fluxo do
 * Google e entrega o resultado à URL deste deployment, e o Drive que passa a ser sincronizado é o
 * dele, dentro do índice de conhecimento daqui. Assinado em vez de guardado numa tabela porque a
 * única coisa que precisa sobreviver entre as duas requisições é isto, e uma tabela para uma linha
 * que vive dez minutos é infraestrutura que alguém vai ter de limpar depois.
 */
export function signState(
  secret: string,
  credentialId: string,
  now: number,
): string {
  const payload = `${credentialId}.${now}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

/** O id da credencial que este state carrega, ou null se ele não confere ou já passou da hora. */
export function verifyState(
  secret: string,
  state: string,
  now: number,
): string | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [credentialId, issuedAt, signature] = parts as [string, string, string];

  const expected = createHmac("sha256", secret)
    .update(`${credentialId}.${issuedAt}`)
    .digest("hex");
  // Comparação de tempo constante: um `===` aqui vaza, pelo tempo de resposta, quantos caracteres do
  // começo da assinatura o palpite acertou, e isso é o bastante para construir uma válida.
  const offered = Buffer.from(signature, "hex");
  const truth = Buffer.from(expected, "hex");
  if (offered.length !== truth.length || !timingSafeEqual(offered, truth)) {
    return null;
  }

  const stamp = Number.parseInt(issuedAt, 10);
  if (!Number.isFinite(stamp) || now - stamp > STATE_TTL_MS || now < stamp) {
    return null;
  }
  return credentialId;
}

/** A mensagem do Google, inteira, porque cada uma manda a pessoa a um lugar diferente do Console. */
async function refused(response: Response): Promise<never> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    error_description?: string;
  } | null;
  throw new Error(
    `O Google recusou: ${
      payload?.error_description ?? payload?.error ?? response.status
    }`,
  );
}

/** Troca o `code` que voltou na URL pelos tokens que valem de verdade. */
export async function exchangeCode(
  client: GoogleOAuthClient,
  code: string,
  call: typeof globalThis.fetch = globalThis.fetch,
): Promise<GoogleTokens> {
  const response = await call(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) return refused(response);

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) return refused(response);

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresInSeconds: payload.expires_in ?? 3600,
  };
}

/** Um access token novo a partir do refresh token guardado. */
export async function refreshAccessToken(
  client: Pick<GoogleOAuthClient, "clientId" | "clientSecret">,
  refreshToken: string,
  call: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const response = await call(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) return refused(response);

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) return refused(response);
  return {
    accessToken: payload.access_token,
    expiresInSeconds: payload.expires_in ?? 3600,
  };
}

/**
 * De quem é o Drive que acabou de ser conectado.
 *
 * Chamado no fim do fluxo, antes de dizer que deu certo, porque é a única prova de que o token
 * serve para alguma coisa — e porque a tela dizer "conectado" sem nomear a conta foi exatamente o
 * que deixou passar, até aqui, uma credencial que nunca tinha falado com o Google.
 */
export async function connectedAccount(
  accessToken: string,
  call: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const url = new URL(ABOUT_URL);
  url.searchParams.set("fields", "user(emailAddress,displayName)");
  const response = await call(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return refused(response);
  const payload = (await response.json()) as {
    user?: { emailAddress?: string };
  };
  const email = payload.user?.emailAddress?.trim();
  if (!email) throw new Error("O Google não disse de quem é esta conta.");
  return email;
}
