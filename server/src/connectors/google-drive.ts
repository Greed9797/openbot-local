import { createSign } from "node:crypto";
import type { ConnectorAdapter, ConnectorChange } from "./contract";

/**
 * O conector do Google Drive.
 *
 * Antes disto, `configureGoogleDrive` guardava a credencial, marcava a fonte como "configurada" e
 * parava aí: nenhuma linha do produto chamava o Drive. A tela dizia conectado e nenhum documento
 * jamais chegava.
 *
 * Autentica como conta de serviço com delegação em todo o domínio. Não é OAuth de usuário de
 * propósito — não há navegador para consentir num deployment que roda sozinho, e o que a organização
 * quer conceder é "leia estas pastas", não "leia o Drive de quem clicou".
 *
 * O que ele NÃO faz: ranquear, resumir ou embutir. Ele traz o texto e quem procura é a busca do
 * PostgreSQL. Ver knowledge-search.ts para o porquê de não haver embeddings aqui.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE = "https://www.googleapis.com/drive/v3";

/** Só leitura. A conta de serviço não tem por que poder escrever no Drive de ninguém. */
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/**
 * Os tipos que sabemos transformar em texto.
 *
 * Um Google Doc não é um arquivo: é exportado. Um PDF ou um .docx viria como bytes que este processo
 * não sabe ler, e adivinhar texto em cima de bytes binários enche o índice de lixo — por isso são
 * pulados em vez de baixados.
 */
const EXPORTABLE: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

const PLAIN = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

export type ServiceAccount = {
  client_email: string;
  private_key: string;
};

export type DriveOptions = {
  /** O JSON da conta de serviço, como veio do Google. */
  serviceAccount: ServiceAccount;
  /** Quem a conta de serviço personifica. Sem isto ela só vê o próprio Drive, que é vazio. */
  impersonationSubject: string;
  /** As pastas de topo declaradas em knowledge.yaml. Vazio significa o Drive inteiro. */
  roots: string[];
  /** Trocável nos testes, para não falar com o Google. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

const base64url = (input: Buffer | string) =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * O JWT que a conta de serviço troca por um token de acesso.
 *
 * `sub` é o que faz a delegação funcionar: sem ele o Google devolve um token válido para a própria
 * conta de serviço, que não enxerga documento nenhum da organização, e o sintoma é uma sincronização
 * que termina com sucesso e zero arquivos.
 */
export function buildAssertion(
  account: ServiceAccount,
  subject: string,
  now: number,
): string {
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      sub: subject,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(account.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** Quebra o texto em pedaços que cabem numa resposta, cortando em parágrafo quando dá. */
export function chunkText(text: string, size = 1500): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > size) {
    /*
     * Corta no último parágrafo antes do limite, e só no limite quando não há um. Cortar no meio de
     * uma frase é o que faz um trecho recuperado começar em "…e por isso a política exige".
     */
    const window = rest.slice(0, size);
    const boundary = window.lastIndexOf("\n\n");
    const cut = boundary > size / 2 ? boundary : size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  trashed?: boolean;
  parents?: string[];
};

export function createGoogleDriveAdapter(
  options: DriveOptions,
): ConnectorAdapter {
  const call = options.fetch ?? globalThis.fetch;
  const clock = options.now ?? Date.now;

  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    /* Trinta segundos de folga: um token que expira em trânsito volta como 401 sem explicação. */
    if (token && token.expiresAt - 30_000 > clock()) return token.value;

    const response = await call(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: buildAssertion(
          options.serviceAccount,
          options.impersonationSubject,
          clock(),
        ),
      }),
    });

    const payload = (await response.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
      error?: string;
    } | null;

    if (!response.ok || !payload?.access_token) {
      /*
       * A mensagem do Google é repassada inteira. "unauthorized_client" aqui quase sempre significa
       * que a delegação em todo o domínio não foi autorizada para este client id no Admin, e uma
       * mensagem genérica manda a pessoa procurar no lugar errado.
       */
      throw new Error(
        `O Google recusou a conta de serviço: ${
          payload?.error_description ?? payload?.error ?? response.status
        }`,
      );
    }

    token = {
      value: payload.access_token,
      expiresAt: clock() + (payload.expires_in ?? 3600) * 1000,
    };
    return token.value;
  }

  async function drive<T>(path: string, query: Record<string, string> = {}) {
    const url = new URL(`${DRIVE}${path}`);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    const response = await call(url, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    if (!response.ok) {
      throw new Error(
        `O Drive respondeu ${response.status} em ${path}: ${await response
          .text()
          .catch(() => "")}`.trim(),
      );
    }
    return (await response.json()) as T;
  }

  /** O texto de um arquivo, ou null quando não sabemos lê-lo. */
  async function contentOf(file: DriveFile): Promise<string | null> {
    const exportAs = EXPORTABLE[file.mimeType];
    const url = exportAs
      ? `${DRIVE}/files/${file.id}/export?mimeType=${encodeURIComponent(exportAs)}`
      : PLAIN.has(file.mimeType)
        ? `${DRIVE}/files/${file.id}?alt=media`
        : null;
    if (!url) return null;

    const response = await call(url, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    if (!response.ok) return null;
    return await response.text();
  }

  /** Os ids das pastas de topo nomeadas em knowledge.yaml. */
  async function rootIds(): Promise<string[]> {
    if (options.roots.length === 0) return [];
    const found: string[] = [];
    for (const name of options.roots) {
      const escaped = name.replace(/'/g, "\\'");
      const page = await drive<{ files?: DriveFile[] }>("/files", {
        q: `mimeType = 'application/vnd.google-apps.folder' and name = '${escaped}' and trashed = false`,
        fields: "files(id,name)",
        pageSize: "10",
      });
      for (const folder of page.files ?? []) found.push(folder.id);
    }
    return found;
  }

  async function upsertFor(file: DriveFile): Promise<ConnectorChange | null> {
    const text = await contentOf(file);
    if (text === null) return null;

    const chunks = chunkText(text);
    if (chunks.length === 0) return null;

    return {
      kind: "upsert",
      sourceId: file.id,
      title: file.name,
      canonicalUrl:
        file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
      /*
       * O carimbo de modificação como hash de conteúdo. O Drive já promete que ele muda quando o
       * arquivo muda, e calcular um digest exigiria baixar tudo em toda passada — que é exatamente o
       * trabalho que a sincronização incremental existe para evitar.
       */
      contentHash: file.modifiedTime ?? String(clock()),
      metadata: { mimeType: file.mimeType, modifiedTime: file.modifiedTime },
      chunks: chunks.map((content, position) => ({ position, content })),
      /*
       * Vazio, e não uma lista de quem pode ler.
       *
       * A permissão real está no Drive, e copiá-la para cá criaria uma segunda cópia que envelhece:
       * alguém perde o acesso lá e continua com ele aqui. Enquanto a recuperação for por deployment
       * e não por pessoa, a resposta honesta é não afirmar nada.
       */
      acls: [],
    };
  }

  return {
    async discover({ cursor, mode }) {
      const changes: ConnectorChange[] = [];

      /*
       * Duas passadas diferentes, não uma com filtro.
       *
       * Sem cursor, ou numa reconciliação, o Drive é varrido inteiro: é a primeira sincronização, ou
       * é a passada que existe para reencontrar o que a incremental deixou passar. Com cursor, só o
       * que mudou — que é o caso normal e o único que não custa uma listagem do Drive todo.
       */
      if (!cursor || mode === "reconcile") {
        const roots = await rootIds();
        const scope =
          roots.length > 0
            ? `(${roots.map((id) => `'${id}' in parents`).join(" or ")}) and `
            : "";

        let pageToken: string | undefined;
        do {
          const page = await drive<{
            files?: DriveFile[];
            nextPageToken?: string;
          }>("/files", {
            q: `${scope}trashed = false`,
            fields:
              "nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink,parents)",
            pageSize: "100",
            ...(pageToken ? { pageToken } : {}),
          });
          for (const file of page.files ?? []) {
            const change = await upsertFor(file);
            if (change) changes.push(change);
          }
          pageToken = page.nextPageToken;
        } while (pageToken);

        /* O ponto de partida das próximas passadas incrementais. */
        const start = await drive<{ startPageToken: string }>(
          "/changes/startPageToken",
        );
        return { changes, nextCursor: start.startPageToken };
      }

      let pageToken: string | undefined = cursor;
      let nextCursor: string | null = cursor;
      do {
        const page: {
          changes?: { fileId: string; removed?: boolean; file?: DriveFile }[];
          nextPageToken?: string;
          newStartPageToken?: string;
        } = await drive("/changes", {
          pageToken: pageToken as string,
          fields:
            "nextPageToken, newStartPageToken, changes(fileId, removed, file(id,name,mimeType,modifiedTime,webViewLink,trashed,parents))",
          pageSize: "100",
        });

        for (const change of page.changes ?? []) {
          /* Removido e na lixeira são a mesma coisa para quem lê: o documento saiu. */
          if (change.removed || change.file?.trashed || !change.file) {
            changes.push({ kind: "delete", sourceId: change.fileId });
            continue;
          }
          const upsert = await upsertFor(change.file);
          if (upsert) changes.push(upsert);
        }

        pageToken = page.nextPageToken;
        if (page.newStartPageToken) nextCursor = page.newStartPageToken;
      } while (pageToken);

      return { changes, nextCursor };
    },
  };
}
