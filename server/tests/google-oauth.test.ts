import { describe, expect, test } from "bun:test";
import { createGoogleDriveAdapter } from "../src/connectors/google-drive";
import {
  buildAuthorisationUrl,
  connectedAccount,
  exchangeCode,
  refreshAccessToken,
  signState,
  verifyState,
} from "../src/connectors/google-oauth";

const client = {
  clientId: "123.apps.googleusercontent.com",
  clientSecret: "segredo",
  redirectUri: "http://localhost:3011/api/admin/connectors/oauth/callback",
};

describe("para onde mandar a pessoa consentir", () => {
  /**
   * O par que decide se a conexão dura mais que uma hora.
   *
   * O Google emite refresh token uma vez por concessão. Sem `prompt=consent`, quem já autorizou este
   * client antes volta do fluxo com um access token de sessenta minutos e nada mais — e a falha só
   * aparece no dia seguinte, quando a sincronização para sem ninguém ter mexido em nada.
   */
  test("pede acesso offline e força a tela de consentimento", () => {
    const url = new URL(buildAuthorisationUrl(client, "estado"));

    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  test("pede só leitura do Drive", () => {
    const url = new URL(buildAuthorisationUrl(client, "estado"));
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/drive.readonly",
    );
  });

  test("leva de volta exatamente a URL registrada no Console", () => {
    const url = new URL(buildAuthorisationUrl(client, "estado"));
    expect(url.searchParams.get("redirect_uri")).toBe(client.redirectUri);
  });
});

describe("o bilhete que atravessa o Google e volta", () => {
  const secret = "chave-do-deployment";

  test("volta dizendo qual pedido era", () => {
    const state = signState(secret, "cred-1", 1_000_000);
    expect(verifyState(secret, state, 1_000_000)).toBe("cred-1");
  });

  /**
   * Sem isto o callback aceita o `code` de qualquer um: alguém faz o próprio fluxo do Google e
   * entrega o resultado a esta URL, e o Drive que passa a ser sincronizado para dentro do índice de
   * conhecimento daqui é o dele.
   */
  test("um bilhete assinado com outra chave não vale", () => {
    const state = signState("outra-chave", "cred-1", 1_000_000);
    expect(verifyState(secret, state, 1_000_000)).toBeNull();
  });

  test("um bilhete com o id trocado não vale", () => {
    const state = signState(secret, "cred-1", 1_000_000);
    const forged = state.replace("cred-1", "cred-2");
    expect(verifyState(secret, forged, 1_000_000)).toBeNull();
  });

  test("um bilhete velho não vale", () => {
    const state = signState(secret, "cred-1", 1_000_000);
    expect(verifyState(secret, state, 1_000_000 + 11 * 60 * 1000)).toBeNull();
  });

  test("lixo não vale, e não explode", () => {
    expect(verifyState(secret, "isto-nao-e-um-bilhete", 1)).toBeNull();
    expect(verifyState(secret, "", 1)).toBeNull();
  });
});

/** Um Google de mentira, para exercitar a troca sem falar com o Google. */
function fakeGoogle(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; sent: URLSearchParams[] } {
  const sent: URLSearchParams[] = [];
  const fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    if (init?.body instanceof URLSearchParams) sent.push(init.body);
    return Response.json(body, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe("trocar o code pelos tokens", () => {
  test("devolve o token de longa duração quando ele vem", async () => {
    const google = fakeGoogle(200, {
      access_token: "acesso",
      refresh_token: "longa-duracao",
      expires_in: 3599,
    });

    const tokens = await exchangeCode(client, "o-code", google.fetch);

    expect(tokens.refreshToken).toBe("longa-duracao");
    expect(tokens.accessToken).toBe("acesso");
    expect(google.sent[0]?.get("grant_type")).toBe("authorization_code");
  });

  /**
   * Ausente, e não vazio. Quem chama precisa poder distinguir "o Google não emitiu" de "emitiu uma
   * string vazia", porque a primeira tem conserto — revogar o acesso e conectar de novo — e a
   * segunda seria um bug nosso.
   */
  test("diz que não veio token de longa duração, em vez de inventar um", async () => {
    const google = fakeGoogle(200, {
      access_token: "acesso",
      expires_in: 3600,
    });

    const tokens = await exchangeCode(client, "o-code", google.fetch);

    expect(tokens.refreshToken).toBeNull();
  });

  test("a recusa do Google chega inteira, para dizer onde arrumar", async () => {
    const google = fakeGoogle(400, {
      error: "redirect_uri_mismatch",
      error_description: "Bad Request",
    });

    expect(exchangeCode(client, "o-code", google.fetch)).rejects.toThrow(
      /Bad Request/,
    );
  });
});

describe("renovar o acesso", () => {
  test("usa o refresh token guardado", async () => {
    const google = fakeGoogle(200, { access_token: "novo", expires_in: 3600 });

    const renewed = await refreshAccessToken(
      client,
      "longa-duracao",
      google.fetch,
    );

    expect(renewed.accessToken).toBe("novo");
    expect(google.sent[0]?.get("grant_type")).toBe("refresh_token");
    expect(google.sent[0]?.get("refresh_token")).toBe("longa-duracao");
  });

  /**
   * O refresh token morre quando a pessoa revoga o acesso, troca a senha ou o app fica seis meses
   * sem uso. A mensagem tem de dizer isso, porque a ação é reconectar e não tentar de novo.
   */
  test("a recusa chega inteira quando o token foi revogado", async () => {
    const google = fakeGoogle(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    });

    expect(refreshAccessToken(client, "morto", google.fetch)).rejects.toThrow(
      /revoked/i,
    );
  });
});

describe("de quem é a conta conectada", () => {
  test("devolve o e-mail que o Google confirma", async () => {
    const fetch = (async () =>
      Response.json({
        user: { emailAddress: "pessoa@gmail.com" },
      })) as unknown as typeof globalThis.fetch;

    expect(await connectedAccount("acesso", fetch)).toBe("pessoa@gmail.com");
  });

  /**
   * Esta chamada existe para ser a prova de que o token serve. Um 401 aqui não pode virar "conectado
   * a uma conta sem nome" — foi exatamente uma credencial nunca verificada que fez a tela dizer
   * conectado enquanto nada chegava.
   */
  test("um token que não serve não vira conexão", async () => {
    const fetch = (async () =>
      Response.json(
        { error: { message: "Invalid Credentials" } },
        { status: 401 },
      )) as unknown as typeof globalThis.fetch;

    expect(connectedAccount("acesso", fetch)).rejects.toThrow(/Google recusou/);
  });
});

describe("o adaptador falando por OAuth", () => {
  /**
   * A mesma varredura, outra porta de entrada do token. O que importa é que nenhuma asserção RS256 é
   * assinada no caminho OAuth: uma conta pessoal não tem chave privada de conta de serviço nenhuma.
   */
  test("renova o acesso e lista o Drive inteiro", async () => {
    const asked: string[] = [];
    const fetch = (async (input: string | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({ access_token: "acesso", expires_in: 3600 });
      }
      if (url.includes("/changes/startPageToken")) {
        return Response.json({ startPageToken: "7" });
      }
      if (url.includes("/export")) return new Response("O texto do documento.");
      return Response.json({
        files: [
          {
            id: "doc-1",
            name: "Anotações",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-08-01T10:00:00Z",
          },
        ],
      });
    }) as unknown as typeof globalThis.fetch;

    const found = await createGoogleDriveAdapter({
      credential: {
        kind: "oauth",
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: "longa-duracao",
      },
      roots: [],
      fetch,
    }).discover({ cursor: null, mode: "sync" });

    expect(found.changes).toHaveLength(1);
    // Sem pastas nomeadas, a busca não filtra por pai — é o Drive inteiro, que é o que uma conta
    // pessoal recém-conectada quer dizer.
    expect(asked.some((url) => url.includes("in+parents"))).toBe(false);
  });
});
