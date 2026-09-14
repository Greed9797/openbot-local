import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  deploymentPackages,
} from "../db/schema";
import { authFromConfiguration, storeAgentAuth } from "./auth-header";
import {
  hashCallbackToken,
  mintCallbackToken,
  sameToken,
} from "./callback-token";
import { canManageAgent } from "./profile-policy";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DatabaseExecutor = Pick<Database, "select"> | Pick<Transaction, "select">;

/** Something that can read profiles: the pool, or a caller's open transaction. */
export type ProfileReadExecutor = DatabaseExecutor;

export type AgentProfileStore = {
  list(actor: AgentActor, hidden?: boolean): Promise<AgentProfile[]>;
  get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  getWithin(executor: ProfileReadExecutor, actor: AgentActor, id: string): Promise<AgentProfile | null>;
  runtimeSettings(botId: string): Promise<{ provider: string | null; model: string | null; allowPrivateNavigation: boolean } | null>;
  createWithin(executor: ProfileWriteExecutor, actor: AgentActor, input: CreateAgentInput): Promise<AgentProfile>;
  create(actor: AgentActor, input: CreateAgentInput): Promise<AgentProfile>;
  update(actor: AgentActor, id: string, input: CreateAgentInput): Promise<AgentProfile>;
  duplicate(actor: AgentActor, id: string): Promise<AgentProfile>;
  setHidden(actor: AgentActor, id: string, hidden: boolean): Promise<void>;
  softDelete(actor: AgentActor, id: string): Promise<void>;
  issueCallbackToken(actor: AgentActor, id: string): Promise<string>;
  revokeCallbackToken(actor: AgentActor, id: string): Promise<void>;
  agentForCallbackToken(hash: string): Promise<{ id: string } | null>;
};

export type ProfileWriteExecutor = ProfileReadExecutor & { insert: Database["insert"] };

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} was not found.`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentNotManageableError extends Error {
  constructor(id: string) {
    super(`Agent ${id} cannot be managed by this actor.`);
    this.name = "AgentNotManageableError";
  }
}

export class ProtectedAgentError extends Error {
  constructor(id: string) {
    super(`Agent ${id} is protected.`);
    this.name = "ProtectedAgentError";
  }
}

const joinedProjection = {
  id: agents.id,
  name: agents.name,
  title: agentProfiles.title,
  roleDescription: agentProfiles.roleDescription,
  avatarSeed: agentProfiles.avatarSeed,
  visibility: agentProfiles.visibility,
  ownerUserId: agentProfiles.ownerUserId,
  packageId: deploymentPackages.id,
  hiddenAt: agentPreferences.hiddenAt,
  deletedAt: agentProfiles.deletedAt,
  /* The hash, only so a surface can say whether one exists. It never leaves this module. */
  callbackTokenHash: agentProfiles.callbackTokenHash,
  configuration: agents.configuration,
};

function joinedProfiles(executor: DatabaseExecutor, actor: AgentActor) {
  return executor
    .select(joinedProjection)
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .leftJoin(
      agentPreferences,
      and(
        eq(agentPreferences.agentId, agents.id),
        eq(agentPreferences.userId, actor.id),
      ),
    )
    .leftJoin(deploymentPackages, eq(deploymentPackages.id, agents.packageId));
}

function accessFilter(actor: AgentActor) {
  if (actor.role === "admin") return undefined;

  return or(
    eq(agentProfiles.visibility, "public"),
    eq(agentProfiles.ownerUserId, actor.id),
  );
}

function mapProfile(
  row: Awaited<
    ReturnType<ReturnType<typeof joinedProfiles>["execute"]>
  >[number],
): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    roleDescription: row.roleDescription,
    avatarSeed: row.avatarSeed,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    systemOwned: row.packageId !== null,
    hasCallbackToken: row.callbackTokenHash !== null,
    hidden: row.hiddenAt !== null,
    deletedAt: row.deletedAt,
    endpoint: endpointOf(row.configuration),
    provider: textoDe(row.configuration, "provider"),
    model: textoDe(row.configuration, "model"),
    allowPrivateNavigation: flagDe(row.configuration, "allowPrivateNavigation"),
    // Whether a key is set, never which. The form needs to show "a key is set" so a person does not
    // wipe one by saving an unrelated edit; showing the value would put a secret in a screenshot.
    hasAuth: authFromConfiguration(row.configuration) !== null,
  };
}

/**
 * The AG-UI address this coworker runs on, read back out of its stored configuration.
 *
 * Needed so an edit does not destroy it. The edit form is the same form as create, so without the
 * current endpoint to fill it with, saving a change of title would submit an empty endpoint and
 * convert an external agent back into the built-in one. That failure is silent and total: the Bot
 * keeps working, so nothing looks broken, and it is simply no longer their agent.
 */
function endpointOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const endpoint = (configuration as { endpoint?: unknown }).endpoint;
  return typeof endpoint === "string" ? endpoint : null;
}

/**
 * Uma chave de texto do jsonb, normalizada.
 *
 * Vazio é `null`, e não string vazia: "este Bot não escolheu provedor" e "este Bot escolheu o
 * provedor de nome vazio" são a mesma coisa para quem lê, mas só a primeira é verdade. É aqui que o
 * `""` que o formulário manda quando a pessoa limpa o campo vira ausência.
 */
function textoDe(
  configuration: unknown,
  chave: "provider" | "model",
): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  // `in` e não um índice por string: com a chave literal o TypeScript estreita o tipo e entrega
  // `unknown`, que é validado abaixo. Um `Record<string, unknown>` aqui seria uma afirmação sobre a
  // forma do jsonb que ninguém checou.
  const valor =
    chave === "provider"
      ? "provider" in configuration
        ? configuration.provider
        : undefined
      : "model" in configuration
        ? configuration.model
        : undefined;
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

/** Uma chave booleana do jsonb. Ausente, de outro tipo, ou `false`: as três são "não". */
function flagDe(
  configuration: unknown,
  chave: "allowPrivateNavigation",
): boolean {
  if (!configuration || typeof configuration !== "object") return false;
  if (!(chave in configuration)) return false;
  return configuration.allowPrivateNavigation === true;
}

async function findAccessibleProfile(
  executor: DatabaseExecutor,
  actor: AgentActor,
  id: string,
): Promise<AgentProfile | null> {
  const [row] = await joinedProfiles(executor, actor).where(
    and(
      eq(agents.id, id),
      isNull(agentProfiles.deletedAt),
      accessFilter(actor),
    ),
  );
  return row ? mapProfile(row) : null;
}

async function lockProfileMutationRows(executor: DatabaseExecutor, id: string) {
  await executor
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, id))
    .for("update");
  await executor
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, id))
    .for("update");
}

/**
 * Share-lock a profile so it stays readable to concurrent callers but cannot be deleted or renamed
 * until this transaction ends. `lockProfileMutationRows` takes the exclusive counterpart, so a
 * deletion racing a reference blocks here instead of committing underneath it.
 */
async function lockProfileReadRow(executor: DatabaseExecutor, id: string) {
  await executor
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, id))
    .for("share");
}

function requireManageable(actor: AgentActor, profile: AgentProfile) {
  if (profile.systemOwned) throw new ProtectedAgentError(profile.id);
  if (!canManageAgent(actor, profile)) {
    throw new AgentNotManageableError(profile.id);
  }
}

function newAgentId() {
  return `agent_${crypto.randomUUID()}`;
}

/**
 * Which agent a token belongs to.
 *
 * Selected by hash and then compared in constant time. The lookup alone would be enough to identify
 * the row, and the comparison is what keeps a timing difference from confirming a partial guess
 * against an index.
 */
async function findByTokenHash(
  database: Database,
  hash: string,
): Promise<{ id: string } | null> {
  const rows = await database
    .select({
      agentId: agentProfiles.agentId,
      hash: agentProfiles.callbackTokenHash,
    })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.callbackTokenHash, hash),
        isNull(agentProfiles.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row?.hash) return null;
  return sameToken(row.hash, hash) ? { id: row.agentId } : null;
}

export function createAgentProfileStore(
  database: Database,
  managedAgentAgUiUrl: URL,
  /**
   * Where a customer agent's key is kept. Optional so a deployment without a vault still runs; an
   * agent with a key then simply cannot be created, which is better than storing it in the clear.
   */
  vault?: { store: CredentialStore; encryptionKey: string },
): AgentProfileStore {
  const managedConfiguration = {
    endpoint: managedAgentAgUiUrl.toString(),
  };
  type WriteExecutor = ProfileReadExecutor & { insert: Database["insert"] };
  async function insertProfileRow(executor: WriteExecutor, actor: AgentActor, input: CreateAgentInput): Promise<AgentProfile> {
    const id = newAgentId();
    await executor.insert(agents).values({
      id,
      name: input.name,
      type: "remote_ag_ui",
      configuration: {
        ...(input.endpoint ? { endpoint: input.endpoint } : managedConfiguration),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.allowPrivateNavigation ? { allowPrivateNavigation: true } : {}),
        ...(input.auth && vault
          ? {
              auth: await storeAgentAuth({
                store: vault.store,
                encryptionKey: vault.encryptionKey,
                agentId: id,
                header: input.auth.header,
                value: input.auth.value,
              }),
            }
          : {}),
      },
    });
    await executor.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: actor.id,
      title: input.title,
      roleDescription: input.roleDescription,
      avatarSeed: id,
      visibility: input.visibility,
    });
    const profile = await findAccessibleProfile(executor, actor, id);
    if (!profile) throw new AgentNotFoundError(id);
    return profile;
  }
  return {
    async list(actor, hidden = false) {
      const rows = await joinedProfiles(database, actor).where(
        and(
          isNull(agentProfiles.deletedAt),
          accessFilter(actor),
          hidden
            ? isNotNull(agentPreferences.hiddenAt)
            : isNull(agentPreferences.hiddenAt),
        ),
      );
      return rows.map(mapProfile);
    },

    get(actor, id) {
      return findAccessibleProfile(database, actor, id);
    },

    async getWithin(executor, actor, id) {
      await lockProfileReadRow(executor, id);
      return findAccessibleProfile(executor, actor, id);
    },

    async runtimeSettings(botId) {
      /*
       * Lê a linha do agente direto, sem ator: quem chama é execução — criar uma tarefa, decidir se
       * o navegador pode entrar na rede interna —, e o ator dessas decisões é o Bot, identificado
       * pelo id. Um Bot apagado devolve null, e o chamador trata como "sem escolha nenhuma", que é
       * a resposta que não amplia nada.
       */
      const [row] = await database
        .select({ configuration: agents.configuration })
        .from(agents)
        .where(eq(agents.id, botId))
        .limit(1);
      if (!row) return null;
      return {
        provider: textoDe(row.configuration, "provider"),
        model: textoDe(row.configuration, "model"),
        allowPrivateNavigation: flagDe(
          row.configuration,
          "allowPrivateNavigation",
        ),
      };
    },

    async createWithin(executor, actor, input) {
      return insertProfileRow(executor, actor, input);
    },

    create(actor, input) {
      return database.transaction(async (transaction) => {
        return insertProfileRow(transaction as unknown as WriteExecutor, actor, input);
      });
    },

    update(actor, id, input) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const updatedAt = new Date();
          /**
           * The endpoint and the key change here too, not only at creation.
           *
           * The form sends both and the route validates both, so an edit that dropped them looked
           * like it had worked: the screen reported success and the Bot kept answering at the old
           * address, which is the worst way to move an endpoint. A key is replaced only when one is
           * supplied, because the form cannot show what is stored and sending nothing means "leave
           * it alone" rather than "remove it".
           */
          const [row] = await transaction
            .select({ configuration: agents.configuration })
            .from(agents)
            .where(eq(agents.id, id))
            .limit(1);
          const configuration: Record<string, unknown> = {
            ...((row?.configuration ?? {}) as Record<string, unknown>),
            ...(input.endpoint ? { endpoint: input.endpoint } : {}),
            ...(input.auth && vault
              ? {
                  auth: await storeAgentAuth({
                    store: vault.store,
                    encryptionKey: vault.encryptionKey,
                    agentId: id,
                    header: input.auth.header,
                    value: input.auth.value,
                  }),
                }
              : {}),
          };

          /*
           * O que a pessoa limpou sai, e o que ela não tocou fica.
           *
           * O formulário manda provedor e modelo sempre, então string vazia é "volte ao padrão do
           * deployment" — não há outro jeito de desfazer a escolha. Ausente é outra coisa: um
           * cliente que não conhece estes campos (o Telegram, um script) edita o título sem apagar
           * a configuração de modelo que não sabe que existe.
           */
          if (input.provider !== undefined) {
            if (input.provider.trim()) {
              configuration.provider = input.provider.trim();
            } else {
              delete configuration.provider;
            }
          }
          if (input.model !== undefined) {
            if (input.model.trim()) {
              configuration.model = input.model.trim();
            } else {
              delete configuration.model;
            }
          }
          if (input.allowPrivateNavigation !== undefined) {
            if (input.allowPrivateNavigation) {
              configuration.allowPrivateNavigation = true;
            } else {
              delete configuration.allowPrivateNavigation;
            }
          }
          await transaction
            .update(agents)
            .set({ name: input.name, configuration, updatedAt })
            .where(eq(agents.id, id));
          await transaction
            .update(agentProfiles)
            .set({
              title: input.title,
              roleDescription: input.roleDescription,
              visibility: input.visibility,
              updatedAt,
            })
            .where(eq(agentProfiles.agentId, id));

          const updated = await findAccessibleProfile(transaction, actor, id);
          if (!updated) throw new AgentNotFoundError(id);
          return updated;
        },
        { isolationLevel: "read committed" },
      );
    },

    duplicate(actor, id) {
      return database.transaction(async (transaction) => {
        const source = await findAccessibleProfile(transaction, actor, id);
        if (!source) throw new AgentNotFoundError(id);

        const duplicateId = newAgentId();
        await transaction.insert(agents).values({
          id: duplicateId,
          name: source.name,
          type: "remote_ag_ui",
          configuration: managedConfiguration,
        });
        await transaction.insert(agentProfiles).values({
          agentId: duplicateId,
          ownerUserId: actor.id,
          title: source.title,
          roleDescription: source.roleDescription,
          avatarSeed: source.avatarSeed,
          visibility: "private",
        });

        const duplicate = await findAccessibleProfile(
          transaction,
          actor,
          duplicateId,
        );
        if (!duplicate) throw new AgentNotFoundError(duplicateId);
        return duplicate;
      });
    },

    setHidden(actor, id, hidden) {
      return database.transaction(async (transaction) => {
        const profile = await findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);

        await transaction
          .insert(agentPreferences)
          .values({
            userId: actor.id,
            agentId: id,
            hiddenAt: hidden ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [agentPreferences.userId, agentPreferences.agentId],
            set: { hiddenAt: hidden ? new Date() : null },
          });
      });
    },

    softDelete(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const deletedAt = new Date();
          await transaction
            .update(agentProfiles)
            .set({ deletedAt, updatedAt: deletedAt })
            .where(eq(agentProfiles.agentId, id));
        },
        { isolationLevel: "read committed" },
      );
    },

    issueCallbackToken(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          /*
           * Whoever may change the agent may credential it.
           *
           * The same gate as renaming it or repointing its endpoint, and repointing the endpoint is
           * the more dangerous of the two: it decides which process the token is for.
           */
          requireManageable(actor, profile);

          const token = mintCallbackToken();
          const issuedAt = new Date();
          await transaction
            .update(agentProfiles)
            .set({
              callbackTokenHash: hashCallbackToken(token),
              callbackTokenIssuedAt: issuedAt,
              updatedAt: issuedAt,
            })
            .where(eq(agentProfiles.agentId, id));

          // The only time it is readable. Nothing here writes it to a log.
          return token;
        },
        { isolationLevel: "read committed" },
      );
    },

    revokeCallbackToken(actor, id) {
      return database.transaction(
        async (transaction) => {
          await lockProfileMutationRows(transaction, id);
          const profile = await findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const now = new Date();
          await transaction
            .update(agentProfiles)
            .set({
              callbackTokenHash: null,
              callbackTokenIssuedAt: null,
              updatedAt: now,
            })
            .where(eq(agentProfiles.agentId, id));
        },
        { isolationLevel: "read committed" },
      );
    },

    agentForCallbackToken(hash) {
      return findByTokenHash(database, hash);
    },
  };
}
