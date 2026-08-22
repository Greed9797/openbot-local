import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  buildAssertion,
  chunkText,
  createGoogleDriveAdapter,
} from "../src/connectors/google-drive";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const account = {
  client_email: "sync@projeto.iam.gserviceaccount.com",
  private_key: privateKey as string,
};

const decode = (segment: string) =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

describe("a asserção que troca por um token", () => {
  /**
   * `sub` é o que faz a delegação valer.
   *
   * Sem ele o Google devolve um token perfeitamente válido para a própria conta de serviço, que não
   * enxerga documento nenhum da organização. O sintoma é uma sincronização que termina com sucesso e
   * zero arquivos, e nada no caminho reclama.
   */
  test("personifica a pessoa nomeada, e não a conta de serviço", () => {
    const claims = decode(
      buildAssertion(account, "diretoria@empresa.com", 1_700_000_000_000).split(
        ".",
      )[1] as string,
    );

    expect(claims.sub).toBe("diretoria@empresa.com");
    expect(claims.iss).toBe(account.client_email);
  });

  test("pede só leitura", () => {
    const claims = decode(
      buildAssertion(account, "a@b.com", 1_700_000_000_000).split(
        ".",
      )[1] as string,
    );
    expect(claims.scope).toBe("https://www.googleapis.com/auth/drive.readonly");
  });

  test("expira em uma hora, que é o máximo que o Google aceita", () => {
    const claims = decode(
      buildAssertion(account, "a@b.com", 1_700_000_000_000).split(
        ".",
      )[1] as string,
    );
    expect(claims.exp - claims.iat).toBe(3600);
  });
});

describe("cortar o texto em trechos", () => {
  test("um texto curto continua inteiro", () => {
    expect(chunkText("Política de reembolso.")).toEqual([
      "Política de reembolso.",
    ]);
  });

  test("nada vira nada, e não um trecho vazio", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  /**
   * Cortar no parágrafo é o que separa um trecho legível de um que começa no meio de uma frase.
   * Um trecho recuperado que abre com "…e por isso a política exige" é inútil para citar.
   */
  test("prefere cortar no fim de um parágrafo", () => {
    const first = `${"a".repeat(800)}\n\n${"b".repeat(800)}`;
    const chunks = chunkText(first, 1000);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(800));
    expect(chunks[1]).toBe("b".repeat(800));
  });

  test("corta no limite quando não há parágrafo onde cortar", () => {
    const chunks = chunkText("c".repeat(2500), 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.length).toBe(1000);
  });
});

/** Um Drive de mentira, para exercitar o adaptador sem falar com o Google. */
function fakeDrive(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("oauth2.googleapis.com")) {
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    for (const [fragment, body] of Object.entries(responses)) {
      if (url.includes(fragment)) {
        return typeof body === "string"
          ? new Response(body)
          : Response.json(body);
      }
    }
    return Response.json({ files: [] });
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

describe("descobrir o que mudou", () => {
  test("uma primeira passada varre tudo e devolve o cursor das próximas", async () => {
    const drive = fakeDrive({
      "/files?": {
        files: [
          {
            id: "doc-1",
            name: "Política de despesas",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-08-01T10:00:00Z",
            webViewLink: "https://docs.google.com/d/doc-1",
          },
        ],
      },
      "/export": "O limite por viagem é de mil reais.",
      "/changes/startPageToken": { startPageToken: "42" },
    });

    const adapter = createGoogleDriveAdapter({
      serviceAccount: account,
      impersonationSubject: "a@b.com",
      roots: [],
      fetch: drive.fetch,
    });

    const found = await adapter.discover({ cursor: null, mode: "sync" });

    expect(found.nextCursor).toBe("42");
    expect(found.changes).toHaveLength(1);
    const [change] = found.changes;
    if (change?.kind !== "upsert") throw new Error("esperava um upsert");
    expect(change.title).toBe("Política de despesas");
    expect(change.chunks[0]?.content).toContain("mil reais");
    /* O carimbo de modificação faz as vezes de hash: o Drive promete que ele muda quando o arquivo muda. */
    expect(change.contentHash).toBe("2026-08-01T10:00:00Z");
  });

  /**
   * Um PDF é bytes que este processo não sabe ler. Baixar e indexar assim mesmo encheria a busca de
   * lixo binário, que depois volta como "trecho encontrado" numa resposta.
   */
  test("pula o que não sabe transformar em texto", async () => {
    const drive = fakeDrive({
      "/files?": {
        files: [
          { id: "pdf-1", name: "Contrato.pdf", mimeType: "application/pdf" },
        ],
      },
      "/changes/startPageToken": { startPageToken: "7" },
    });

    const found = await createGoogleDriveAdapter({
      serviceAccount: account,
      impersonationSubject: "a@b.com",
      roots: [],
      fetch: drive.fetch,
    }).discover({ cursor: null, mode: "sync" });

    expect(found.changes).toEqual([]);
  });

  test("um arquivo na lixeira vira uma exclusão", async () => {
    const drive = fakeDrive({
      "/changes?": {
        changes: [
          {
            fileId: "doc-9",
            file: {
              id: "doc-9",
              name: "Antigo",
              mimeType: "text/plain",
              trashed: true,
            },
          },
        ],
        newStartPageToken: "99",
      },
    });

    const found = await createGoogleDriveAdapter({
      serviceAccount: account,
      impersonationSubject: "a@b.com",
      roots: [],
      fetch: drive.fetch,
    }).discover({ cursor: "50", mode: "sync" });

    expect(found.changes).toEqual([{ kind: "delete", sourceId: "doc-9" }]);
    expect(found.nextCursor).toBe("99");
  });

  test("a recusa do Google chega inteira, para dizer onde arrumar", async () => {
    const fetch = (async (input: string | URL) => {
      if (String(input).includes("oauth2")) {
        return Response.json(
          {
            error: "unauthorized_client",
            error_description:
              "Client is unauthorized to retrieve access tokens",
          },
          { status: 401 },
        );
      }
      return Response.json({});
    }) as unknown as typeof globalThis.fetch;

    const adapter = createGoogleDriveAdapter({
      serviceAccount: account,
      impersonationSubject: "a@b.com",
      roots: [],
      fetch,
    });

    expect(adapter.discover({ cursor: null, mode: "sync" })).rejects.toThrow(
      /unauthorized/i,
    );
  });
});
