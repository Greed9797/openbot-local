export type ConnectorStatus = {
  id: string;
  type: "google_drive" | "onedrive";
  name: string;
  roots: string[];
  configured: boolean;
  /**
   * De quem é a conta conectada, quando há uma.
   *
   * Nomear a conta é o que separa "configurado" de "funcionando": a tela dizia conectado a partir do
   * momento em que uma credencial fora guardada, sem que nada jamais tivesse falado com o Google.
   */
  account?: string | null;
};

export type ConnectorAdminService = {
  list: () => Promise<ConnectorStatus[]>;
  configureGoogleDrive?: (input: {
    serviceAccountJson: string;
    impersonationSubject: string;
    actorUserId: string;
  }) => Promise<ConnectorStatus>;
  /**
   * Puxar do Drive agora.
   *
   * Existe como ação e não só como agendamento porque a primeira pergunta de quem acabou de
   * configurar é "funcionou?", e a resposta honesta a essa pergunta é um número de documentos, não
   * uma tela dizendo "conectado". O worker deste repositório é um esqueleto que não agenda nada;
   * enquanto for, isto é o que faz a sincronização acontecer.
   */
  syncGoogleDrive?: (input: { mode: "sync" | "reconcile" }) => Promise<{
    documents: number;
    deleted: number;
  }>;
  /**
   * Começar o consentimento no navegador da pessoa.
   *
   * Devolve para onde mandá-la, e nada mais: o refresh token só existe depois que ela voltar.
   */
  startGoogleDriveOAuth?: (input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    actorUserId: string;
  }) => Promise<{ url: string }>;
  /** A volta do Google, com o `code` a trocar e o `state` a conferir. */
  completeGoogleDriveOAuth?: (input: {
    code: string;
    state: string;
    actorUserId: string;
  }) => Promise<{ account: string }>;
  /** Quais pastas varrer. Lista vazia significa o Drive inteiro. */
  setGoogleDriveRoots?: (roots: string[]) => Promise<ConnectorStatus>;
};

type KnowledgeSource = {
  type: "google-drive" | "microsoft-onedrive";
  roots: string[];
};

/**
 * O que a instância guarda sobre si.
 *
 * `auth` decide como a sincronização vai buscar o token, e existe porque as duas formas não são
 * intercambiáveis: uma conta pessoal não tem delegação de domínio, e uma organização não quer que a
 * sincronização morra quando quem clicou sair da empresa.
 */
type InstanceMetadata = {
  auth?: "service-account" | "oauth";
  impersonationSubject?: string;
  account?: string;
  roots?: string[];
};

export function createConnectorCatalogService(
  sources: KnowledgeSource[],
): ConnectorAdminService {
  return {
    list: async () =>
      sources.map((source) =>
        source.type === "google-drive"
          ? {
              id: "google-drive",
              type: "google_drive",
              name: "Google Drive",
              roots: source.roots,
              configured: false,
            }
          : {
              id: "microsoft-onedrive",
              type: "onedrive",
              name: "Microsoft OneDrive",
              roots: source.roots,
              configured: false,
            },
      ),
  };
}

/** O que foi guardado cifrado, de volta na forma que o adaptador entende. */
async function storedCredential(
  secrets: { reader: CredentialSecretReader; encryptionKey: string },
  credentialId: string,
  metadata: InstanceMetadata,
): Promise<DriveCredential> {
  const json = await decryptCredentialForUse(
    secrets.encryptionKey,
    secrets.reader,
    credentialId,
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("A credencial guardada do Google Drive não é um JSON.");
  }

  if (metadata.auth === "oauth" || typeof parsed.refreshToken === "string") {
    const { clientId, clientSecret, refreshToken } = parsed as {
      clientId?: string;
      clientSecret?: string;
      refreshToken?: string;
    };
    if (!clientId || !clientSecret || !refreshToken) {
      /*
       * Acontece de verdade quando alguém sai no meio do consentimento: a credencial pendente ficou
       * guardada com client id e secret, e sem o refresh token não existe conexão nenhuma. Dizer
       * "reconecte" é mais útil do que um 500 sobre um campo ausente.
       */
      throw new Error(
        "A conexão com o Google não foi concluída. Conecte o Drive novamente.",
      );
    }
    return { kind: "oauth", clientId, clientSecret, refreshToken };
  }

  const account = parsed as unknown as ServiceAccount;
  if (!account.client_email || !account.private_key) {
    throw new Error(
      "O JSON da conta de serviço não traz client_email e private_key.",
    );
  }
  return {
    kind: "service-account",
    serviceAccount: account,
    impersonationSubject: metadata.impersonationSubject ?? "",
  };
}

/**
 * Uma instância por conector, atualizada no lugar.
 *
 * Reconectar troca a credencial, não cria uma segunda linha: duas instâncias do mesmo Drive fariam
 * duas sincronizações concorrentes escrevendo os mesmos documentos, e a que ganhasse seria sorteada
 * pela ordem de chegada.
 */
async function rememberDriveInstance(
  database: Database,
  credentialId: string,
  sourceMetadata: InstanceMetadata,
): Promise<void> {
  const [existing] = await database
    .select({ id: connectorInstances.id })
    .from(connectorInstances)
    .where(eq(connectorInstances.type, "google_drive"));
  if (existing) {
    await database
      .update(connectorInstances)
      .set({ credentialId, sourceMetadata, updatedAt: new Date() })
      .where(eq(connectorInstances.id, existing.id));
    return;
  }
  await database
    .insert(connectorInstances)
    .values({ type: "google_drive", credentialId, sourceMetadata });
}

/** A fonte declarada em `knowledge.yaml`. Sem ela este deployment não oferece o Drive. */
function requireDriveSource(sources: KnowledgeSource[]): KnowledgeSource {
  const source = sources.find((item) => item.type === "google-drive");
  if (!source) {
    throw new Error("O Google Drive não está habilitado por knowledge.yaml.");
  }
  return source;
}

export function createConnectorAdminService(
  sources: KnowledgeSource[],
  database: Database,
  credentials: CredentialAdminService,
  /**
   * Como ler de volta o JSON da conta de serviço, e com que chave.
   *
   * Opcional porque a configuração funciona sem: guardar a credencial nunca precisou abri-la. É
   * sincronizar que precisa, e um deployment que não passe isto simplesmente não oferece o botão.
   */
  secrets?: { reader: CredentialSecretReader; encryptionKey: string },
): ConnectorAdminService {
  const catalog = createConnectorCatalogService(sources);
  return {
    /**
     * The catalogue, with each entry told whether this deployment has configured it.
     *
     * `knowledge.yaml` says what a deployment may connect to rather than what it has, so whether a
     * connector is configured is read from the instances table instead.
     */
    list: async () => {
      const instances = new Map(
        (
          await database
            .select({
              type: connectorInstances.type,
              sourceMetadata: connectorInstances.sourceMetadata,
            })
            .from(connectorInstances)
        ).map((row) => [row.type, row.sourceMetadata as InstanceMetadata]),
      );
      return (await catalog.list()).map((connector) => {
        const instance = instances.get(connector.type);
        return {
          ...connector,
          configured: instance !== undefined,
          /*
           * As pastas da instância ganham das do pacote. `knowledge.yaml` diz a que este deployment
           * PODE se conectar, com os nomes do pacote de exemplo; o que a pessoa escolheu depois de
           * conectar o Drive dela é o que vale.
           */
          roots: instance?.roots ?? connector.roots,
          account: instance?.account ?? null,
        };
      });
    },
    configureGoogleDrive: async (input) => {
      const source = requireDriveSource(sources);
      const credential = await credentials.create({
        kind: "connector",
        provider: "google_drive",
        keyId: input.impersonationSubject,
        metadata: {},
        plaintext: input.serviceAccountJson,
        actorUserId: input.actorUserId,
      });
      const sourceMetadata = {
        roots: source.roots,
        impersonationSubject: input.impersonationSubject,
      };
      await rememberDriveInstance(database, credential.id, sourceMetadata);
      return {
        id: "google-drive",
        type: "google_drive",
        name: "Google Drive",
        roots: source.roots,
        configured: true,
      };
    },

    ...(secrets
      ? {
          syncGoogleDrive: async ({ mode }) => {
            const source = requireDriveSource(sources);

            const [instance] = await database
              .select({
                id: connectorInstances.id,
                credentialId: connectorInstances.credentialId,
                sourceMetadata: connectorInstances.sourceMetadata,
              })
              .from(connectorInstances)
              .where(eq(connectorInstances.type, "google_drive"));

            if (!instance?.credentialId) {
              throw new Error("O Google Drive ainda não foi configurado.");
            }

            const metadata = (instance.sourceMetadata ??
              {}) as InstanceMetadata;

            const adapter = createGoogleDriveAdapter({
              credential: await storedCredential(
                secrets,
                instance.credentialId,
                metadata,
              ),
              roots: metadata.roots ?? source.roots,
            });

            const persistence = createSyncPersistence(database, instance.id);
            let documents = 0;
            let deleted = 0;

            await runConnector(
              {
                discover: async (input) => {
                  const found = await adapter.discover(input);
                  for (const change of found.changes) {
                    if (change.kind === "delete") deleted += 1;
                    else documents += 1;
                  }
                  return found;
                },
              },
              persistence,
              mode,
            );

            return { documents, deleted };
          },

          startGoogleDriveOAuth: async (input) => {
            requireDriveSource(sources);
            /*
             * A credencial é guardada ANTES de existir refresh token, e é isso que o `state` carrega.
             * O client secret não pode voltar do Google dentro do state — sai desta máquina e volta
             * pela barra de endereço de um navegador —, então o que atravessa é só o id de uma linha
             * cifrada que já está aqui.
             */
            const pending = await credentials.create({
              kind: "connector",
              provider: "google_drive",
              keyId: "pendente",
              metadata: { auth: "oauth", stage: "pending" },
              plaintext: JSON.stringify({
                clientId: input.clientId,
                clientSecret: input.clientSecret,
                redirectUri: input.redirectUri,
              }),
              actorUserId: input.actorUserId,
            });

            return {
              url: buildAuthorisationUrl(
                { clientId: input.clientId, redirectUri: input.redirectUri },
                signState(secrets.encryptionKey, pending.id, Date.now()),
              ),
            };
          },

          completeGoogleDriveOAuth: async (input) => {
            requireDriveSource(sources);

            const pendingId = verifyState(
              secrets.encryptionKey,
              input.state,
              Date.now(),
            );
            if (!pendingId) {
              /*
               * Nada sobre o que exatamente não bateu. Um callback que explica se o problema foi a
               * assinatura ou o prazo ensina a quem está tentando forjar um qual dos dois ajustar.
               */
              throw new Error(
                "Este pedido de conexão não confere. Comece de novo.",
              );
            }

            const stored = JSON.parse(
              await decryptCredentialForUse(
                secrets.encryptionKey,
                secrets.reader,
                pendingId,
              ),
            ) as {
              clientId?: string;
              clientSecret?: string;
              redirectUri?: string;
            };
            if (
              !stored.clientId ||
              !stored.clientSecret ||
              !stored.redirectUri
            ) {
              throw new Error("O pedido de conexão guardado está incompleto.");
            }

            const client = {
              clientId: stored.clientId,
              clientSecret: stored.clientSecret,
              redirectUri: stored.redirectUri,
            };
            const tokens = await exchangeCode(client, input.code);
            if (!tokens.refreshToken) {
              /*
               * Sem refresh token a conexão dura uma hora e morre calada. O Google só emite um por
               * concessão, então isto significa que esta conta já autorizou este client antes —
               * revogar em myaccount.google.com/permissions faz a próxima tentativa emitir de novo.
               */
              throw new Error(
                "O Google não devolveu um token de longa duração. Remova o acesso deste app em myaccount.google.com/permissions e conecte de novo.",
              );
            }

            // Antes de dizer que deu certo. É a única prova de que o token serve para ler o Drive.
            const account = await connectedAccount(tokens.accessToken);

            const credential = await credentials.rotate({
              kind: "connector",
              provider: "google_drive",
              keyId: account,
              metadata: { auth: "oauth" },
              plaintext: JSON.stringify({
                clientId: client.clientId,
                clientSecret: client.clientSecret,
                refreshToken: tokens.refreshToken,
              }),
              actorUserId: input.actorUserId,
              previousCredentialId: pendingId,
            });

            const [existing] = await database
              .select({ sourceMetadata: connectorInstances.sourceMetadata })
              .from(connectorInstances)
              .where(eq(connectorInstances.type, "google_drive"));
            const previous = (existing?.sourceMetadata ??
              {}) as InstanceMetadata;

            await rememberDriveInstance(database, credential.id, {
              auth: "oauth",
              account,
              /*
               * Vazio, e não as pastas do pacote de exemplo.
               *
               * `knowledge.yaml` nomeia "Policies" e "Compliance", que existem no Drive de ninguém.
               * Herdá-las aqui produz a falha mais cara deste conector: conecta, sincroniza, termina
               * com sucesso e zero documentos. Vazio significa o Drive inteiro, que é o que alguém
               * que acabou de conectar a própria conta quis dizer.
               */
              roots: previous.roots ?? [],
            });

            return { account };
          },

          setGoogleDriveRoots: async (roots) => {
            const source = requireDriveSource(sources);
            const [instance] = await database
              .select({
                credentialId: connectorInstances.credentialId,
                sourceMetadata: connectorInstances.sourceMetadata,
              })
              .from(connectorInstances)
              .where(eq(connectorInstances.type, "google_drive"));
            if (!instance?.credentialId) {
              throw new Error("O Google Drive ainda não foi conectado.");
            }

            const metadata = (instance.sourceMetadata ??
              {}) as InstanceMetadata;
            const chosen = roots.map((name) => name.trim()).filter(Boolean);
            await rememberDriveInstance(database, instance.credentialId, {
              ...metadata,
              roots: chosen,
            });

            return {
              id: "google-drive",
              type: "google_drive",
              name: "Google Drive",
              roots: chosen.length > 0 ? chosen : source.roots,
              configured: true,
              account: metadata.account ?? null,
            };
          },
        }
      : {}),
  };
}

import { eq } from "drizzle-orm";
import {
  createGoogleDriveAdapter,
  type DriveCredential,
  type ServiceAccount,
} from "./connectors/google-drive";
import {
  buildAuthorisationUrl,
  connectedAccount,
  exchangeCode,
  signState,
  verifyState,
} from "./connectors/google-oauth";
import { runConnector } from "./connectors/run";
import { createSyncPersistence } from "./connectors/sync-persistence";
import type {
  CredentialAdminService,
  CredentialSecretReader,
} from "./credentials";
import { decryptCredentialForUse } from "./credentials";
import type { Database } from "./db/client";
import { connectorInstances } from "./db/schema";
