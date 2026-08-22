export type ConnectorStatus = {
  id: string;
  type: "google_drive" | "onedrive";
  name: string;
  roots: string[];
  configured: boolean;
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
};

type KnowledgeSource = {
  type: "google-drive" | "microsoft-onedrive";
  roots: string[];
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
      const configured = new Set(
        (
          await database
            .select({ type: connectorInstances.type })
            .from(connectorInstances)
        ).map((row) => row.type),
      );
      return (await catalog.list()).map((connector) => ({
        ...connector,
        configured: configured.has(connector.type),
      }));
    },
    configureGoogleDrive: async (input) => {
      const source = sources.find((item) => item.type === "google-drive");
      if (!source)
        throw new Error("Google Drive is not enabled by knowledge.yaml");
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
      const [existing] = await database
        .select({ id: connectorInstances.id })
        .from(connectorInstances)
        .where(eq(connectorInstances.type, "google_drive"));
      if (existing) {
        await database
          .update(connectorInstances)
          .set({
            credentialId: credential.id,
            sourceMetadata,
            updatedAt: new Date(),
          })
          .where(eq(connectorInstances.id, existing.id));
      } else {
        await database.insert(connectorInstances).values({
          type: "google_drive",
          credentialId: credential.id,
          sourceMetadata,
        });
      }
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
            const source = sources.find((item) => item.type === "google-drive");
            if (!source) {
              throw new Error(
                "O Google Drive não está habilitado por knowledge.yaml.",
              );
            }

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

            const json = await decryptCredentialForUse(
              secrets.encryptionKey,
              secrets.reader,
              instance.credentialId,
            );

            let account: ServiceAccount;
            try {
              account = JSON.parse(json) as ServiceAccount;
            } catch {
              throw new Error(
                "A credencial guardada não é um JSON de conta de serviço.",
              );
            }
            if (!account.client_email || !account.private_key) {
              throw new Error(
                "O JSON da conta de serviço não traz client_email e private_key.",
              );
            }

            const metadata = (instance.sourceMetadata ?? {}) as {
              impersonationSubject?: string;
              roots?: string[];
            };

            const adapter = createGoogleDriveAdapter({
              serviceAccount: account,
              impersonationSubject: metadata.impersonationSubject ?? "",
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
        }
      : {}),
  };
}

import { eq } from "drizzle-orm";
import { runConnector } from "./connectors/run";
import type {
  CredentialAdminService,
  CredentialSecretReader,
} from "./credentials";
import { decryptCredentialForUse } from "./credentials";
import { createSyncPersistence } from "./connectors/sync-persistence";
import {
  createGoogleDriveAdapter,
  type ServiceAccount,
} from "./connectors/google-drive";
import type { Database } from "./db/client";
import { connectorInstances } from "./db/schema";
