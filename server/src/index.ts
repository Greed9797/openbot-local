import { serve } from "bun";
import { createApprovalGate } from "./agent-runs/approvals";
import { createAgentRunRepository } from "./agent-runs/repository";
import { createAgentRunService } from "./agent-runs/service";
import { createAgentRunWorker } from "./agent-runs/worker";
import { createArtifactStore } from "./agent-runtime/artifact-store";
import { createBrowserTools } from "./agent-runtime/browser-tools";
import { createAgentRunExecutor } from "./agent-runtime/loop";
import { buildModelCatalog } from "./agent-runtime/model-catalog";
import { createModelConfigurationStore } from "./agent-runtime/model-configurations";
import { createGatewayObservationSource } from "./agent-runtime/observation";
import {
  createConfiguredProviders,
  serviceModels,
} from "./agent-runtime/providers";
import {
  createRoutedProvider,
  routedCatalogEntries,
} from "./agent-runtime/routed-provider";
import { createProviderRegistry } from "./agent-runtime/registry";
import { mintRunAssertion } from "./agents/callback-token";
import { createAgentProfileStore } from "./agents/profile-store";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { createApp } from "./app";
import { createAuditReader, createAuditStore, recordAuditEvent } from "./audit";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import { createRoleRepository } from "./auth/guards";
import { createIdentityProviderStore } from "./auth/identity-provider-store";
import type { OpenBotRole } from "./auth/roles";
import {
  createChannelEventHub,
  startChannelActivityListener,
} from "./channels/events";
import { createChannelStore } from "./channels/routes";
import { websocket as channelSocket } from "./channels/socket";
import { createStallGuard } from "./channels/stall-guard";
import { createThreadIdentity } from "./channels/thread-identity";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createComputerGateway } from "./computer/gateway";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import {
  createComputerProvider,
  describeComputerIsolation,
} from "./computer/provider";
import { createSnapshotStore } from "./computer/snapshot-store";
import { loadConfig } from "./config";
import { createConnectorAdminService } from "./connectors";
import { createKnowledgeSearch } from "./connectors/knowledge-search";
import {
  type IdentifyActor,
  type IdentifyUser,
  mountCopilotRuntime,
} from "./copilot";
import { DurableAgentRunner } from "./copilot-runner";
import {
  createCredentialAdminService,
  createCredentialStore,
  resolveModelApiKey,
} from "./credentials";
import { createDatabase } from "./db/client";
import { createPeopleStore } from "./people/store";
import { createPluginStore } from "./plugins/store";
import { grantedTools } from "./plugins/tools";
import { createTelegramClient } from "./telegram/client";
import { createTelegramHandler } from "./telegram/handler";
import { createTelegramNotifier } from "./telegram/notifier";
import { createTelegramPoller } from "./telegram/poller";
import { createTelegramSender } from "./telegram/sender";
import { createTelegramStore } from "./telegram/store";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: OpenBotRole;
}> {
  if (config.singleUser) {
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("A CopilotKit run requires a signed-in user.");
  }
  const roles = await roleRepository.rolesForUser(user.id);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A CopilotKit run requires an authorized user.");
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: roles.includes("admin") ? "admin" : "user",
  };
}

/** The Intelligence projection of {@link resolveRequestActor}: threads are scoped to this person. */
const identifyUser: IdentifyUser = async (request) => {
  const { id, name } = await resolveRequestActor(request);
  return { id, name };
};

/**
 * The authorization projection of the same person: agent visibility is decided from this.
 *
 * An unauthenticated request resolves to a person who owns nothing rather than an error, so the
 * runtime can still describe itself, `/info` reports the licence and the public roster, which is
 * what a deployment check reads to tell "the licence is invalid" apart from "chat is silently
 * broken". It grants nothing: this actor matches no private profile and is not an administrator,
 * and a run still fails in `identifyUser`, which has no anonymous case because a thread must belong
 * to somebody.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

const identifyActor: IdentifyActor = async (request) => {
  try {
    const { id, role } = await resolveRequestActor(request);
    return { id, role };
  } catch {
    return ANONYMOUS_ACTOR;
  }
};

const config = loadConfig();
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const database = createDatabase(config.databaseUrl);
await initializeDevActorUser(database, config.singleUser);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgentAgUiUrl,
  agentVault,
);
// Read here rather than beside the synchronise below, because the package names the deployment and
// the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(
  config.deploymentId ?? tenantPackage.tenantId,
);
const channelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
);
const channelEvents = createChannelEventHub();
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
// Its own connection is held for the life of the process; announced activity from any instance
// arrives here and is fanned out to connected members.
const channelActivityListener = await startChannelActivityListener(
  config.databaseUrl,
  channelEvents,
);
const roleRepository = createRoleRepository(database);
const loadAgentsForActor = createRuntimeAgentLoader(database, agentVault, {
  endpoint: config.managedAgentAgUiUrl,
  token: config.managedAgentToken,
});
await synchronizeTenantPackage(database, tenantPackage);
/*
 * Built before `auth`, because the deny list is consulted during sign-in and the store is what
 * holds it. It needs the administrator list too, so it can tell the screen which people the
 * deployment's configuration has already decided about.
 */
const peopleStore = createPeopleStore(
  database,
  config.auth?.initialAdminEmails ?? [],
);
const identityProviderStore = createIdentityProviderStore(database);
/*
 * Built before `auth` for the same reason the people store is: sign-in writes to the trail, and the
 * store that receives those rows has to exist before anything can sign in.
 */
const signInAuditStore = createAuditStore(database);
const auth = config.auth
  ? createAuth(
      config,
      database,
      (email) => peopleStore.isRevoked(email),
      signInAuditStore,
    )
  : undefined;
const computerProvider = config.computer
  ? createComputerProvider(config.computer)
  : undefined;

if (computerProvider?.warm) {
  void computerProvider.warm();
}
// What Bots may do on their computers. Configuration supplies the deployment's default; an
// administrator can change it while running, and a restart returns to the configured one.
const policyStore = createPolicyStore(
  config.computer?.policy ?? DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 *
 * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
 * unavailable, and the row is a note for a reader rather than something the server depends on.
 */
const bootAuditStore = createAuditStore(database);
const computerGateway = computerProvider
  ? createComputerGateway({
      provider: computerProvider,
      auditStore: bootAuditStore,
      policy: () => policyStore.get(),
      // In Postgres, so the ref a click carries resolves against the snapshot that produced it even
      // when the snapshot was taken by another server. A Map here would be blank on every replica
      // but the one that snapshotted, and the boundary would decide with no element to look at.
      snapshots: createSnapshotStore(database),
      /*
       * A pergunta é por Bot: o cadastro responde, e o interruptor do deployment continua valendo
       * como um "sim" para todos.
       *
       * `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` responde se um Bot pode ser REGISTRADO num endereço
       * interno — e a resposta é sim, porque é onde os Bots deste deployment moram. Enquanto as duas
       * perguntas dividiram a mesma variável, permitir o registro abria a rede interna para a
       * navegação: medido, o navegador do Bot lia `http://openbot:3001/api/admin/connectors`, que é
       * a API que o governa, com privilégio de administrador num deployment de usuário único.
       *
       * A permissão do Bot nasce desligada e é auditada: quem a liga está dizendo que aquele Bot
       * pode alcançar os serviços que governam este deployment, e a frase está no formulário.
       */
      allowPrivateNavigation: async (botId) => {
        if (config.computer?.allowPrivateNavigation) return true;
        try {
          const settings = await agentProfileStore.runtimeSettings(botId);
          return settings?.allowPrivateNavigation === true;
        } catch (error) {
          // Na dúvida, a resposta que não abre a rede — e dita em voz alta, porque um banco fora do
          // ar vira uma recusa de navegação que ninguém explicaria de outro jeito.
          console.warn(
            `Não foi possível ler a permissão de navegação do Bot ${botId}: ${String(error)}`,
          );
          return false;
        }
      },
      token: config.computer?.token,
    })
  : undefined;

/**
 * The durable task core: persistence, the state machine, and the routes over both.
 *
 * Mounted only when the runtime is enabled. The worker that drives queued runs is created after the
 * app, because it needs the executor — and the executor is built from the same gateway, so every
 * browser action a run takes still passes the policy and the audit trail rather than a new path.
 */
const agentRunRepository = createAgentRunRepository(database);
const agentRunService = config.agentRuntime.enabled
  ? createAgentRunService({
      repository: agentRunRepository,
      auditStore: bootAuditStore,
      defaults: {
        provider: config.agentRuntime.defaultProvider,
        model: config.agentRuntime.defaultModel,
        budget: {
          maxSteps: config.agentRuntime.maxSteps,
          maxMs: config.agentRuntime.maxRunMs,
          maxCorrections: config.agentRuntime.maxCorrections,
        },
        leaseTtlMs: config.agentRuntime.leaseTtlMs,
      },
      // O que o Bot escolheu, lido do perfil na hora de criar a tarefa: mudar a escolha vale para a
      // próxima tarefa sem reiniciar nada.
      botModel: (botId) => agentProfileStore.runtimeSettings(botId),
      /*
       * O catálogo em memória, lido a cada criação.
       *
       * Assim um `POST /api/models/refresh` passa a valer imediatamente: o serviço do CLI ganha
       * modelos sem deploy, e uma escolha nova não é recusada por uma lista velha.
       */
      knownModel: (provider, model) =>
        (modelCatalog?.models ?? []).some(
          (entrada) =>
            entrada.id === provider &&
            (model === "" || entrada.model === model),
        ),
    })
  : undefined;

/**
 * Onde as imagens de uma tarefa ficam, e o que pode sair delas.
 *
 * O diretório é configurável porque num container ele é um volume: apagar o container não pode
 * apagar as evidências de uma tarefa, e um volume que cresce sem prazo é uma conta que chega depois.
 * Por isso a retenção mora na linha, e não numa política escrita em algum lugar.
 */
const artifactStore = createArtifactStore({
  repository: agentRunRepository,
  root: config.agentRuntime.artifactsDir,
  retentionDays: config.agentRuntime.artifactRetentionDays,
});

/**
 * Os modelos deste deployment, e o registro do que existe.
 *
 * A lista vem do ambiente; a tabela é a cópia que a interface e o Telegram leem. Um deployment sem
 * credencial nenhuma sobe com zero provedores: as tarefas falham com `PROVIDER_UNAVAILABLE` e dizem
 * isso, em vez de o servidor não subir.
 */
const configuredProviders = createConfiguredProviders(
  config.agentRuntime.providers,
  {
    /*
     * Assinado aqui, onde a chave mora.
     *
     * Um provedor delegado entrega a tarefa inteira a outro processo, que age em nome desta pessoa
     * pelo navegador; a declaração é o que ele apresenta em cada chamada de ferramenta. Sem ela o
     * serviço do Codex roda sem servidor MCP e a tarefa termina sem ter aberto página nenhuma.
     */
    signRun: ({ botId, runId, actorId }) =>
      mintRunAssertion({ botId, actorId, runId }, config.keyEncryptionKey),
    /*
     * As skills concedidas a este Bot, lidas a cada turno.
     *
     * O store é declarado mais abaixo neste arquivo, e a leitura só acontece quando um turno roda —
     * depois do boot, que é quando ele existe. Conceder ou revogar no painel vale no turno seguinte,
     * sem reiniciar nada, que é a mesma promessa do caminho de passo (`plugins/tools.ts`).
     */
    skills: (botId) =>
      pluginStore.listForAgent(botId).then((held) => held.skills),
  },
);
/*
 * O `routed` opt-in (RQ-10): só existe com política configurada e candidatos construídos.
 * Sem ele, o registro é exatamente o de antes — o padrão continua sendo o primeiro da lista
 * e nenhum Bot muda de modelo sem ter escolhido `routed`.
 */
const routedProvider = createRoutedProvider({
  policy: config.agentRuntime.routingPolicy,
  providers: configuredProviders,
  configs: config.agentRuntime.providers,
});
if (config.agentRuntime.routingPolicy && !routedProvider) {
  console.warn(
    "AGENT_ROUTING_POLICY está configurada mas nenhum candidato foi construído: o id routed não foi registrado e as tarefas que o escolherem vão falhar com PROVIDER_UNAVAILABLE.",
  );
}
const providers = createProviderRegistry(
  routedProvider
    ? [...configuredProviders, routedProvider]
    : configuredProviders,
);
if (config.agentRuntime.enabled && config.agentRuntime.providers.length === 0) {
  console.warn(
    "Nenhum modelo está configurado para o runtime agêntico: as tarefas vão falhar com PROVIDER_UNAVAILABLE. Configure OPENAI_API_KEY, ANTHROPIC_API_KEY, AGENT_LOCAL_BASE_URL, AGENT_GEMINI_API_KEY, AGENT_CODEX_URL ou AGENT_OPENCODE_URL.",
  );
}

/*
 * O que a pessoa vê quando pergunta quais modelos existem — no painel, e na conferência do deploy.
 *
 * `undefined` com o runtime desligado, como as rotas que ele descreve: um deployment que não tem
 * tarefas não ganha uma tela de modelos que só descreveria tarefas.
 *
 * `let` e não `const` porque os serviços delegados entram depois do boot: a conta do CLI tem
 * modelos que só ela conhece, e a lista é perguntada a ela — no boot e a cada `POST
 * /api/models/refresh`. Um serviço fora do ar no boot custa a lista dele até alguém atualizar, e
 * não o deployment.
 */
const montarCatalogo = (serviceModels?: Record<string, string[]>) => {
  const catalogo = buildModelCatalog({
    providers,
    configurations: config.agentRuntime.providers,
    defaultProvider: config.agentRuntime.defaultProvider,
    ...(serviceModels ? { serviceModels } : {}),
  });
  // As linhas do `routed`: o id sintético com os modelos reais dos candidatos, nunca `default`.
  if (config.agentRuntime.routingPolicy) {
    catalogo.models.push(
      ...routedCatalogEntries({
        policy: config.agentRuntime.routingPolicy,
        providers: configuredProviders,
        configs: config.agentRuntime.providers,
      }),
    );
  }
  return catalogo;
};

let modelCatalog = config.agentRuntime.enabled ? montarCatalogo() : undefined;

const atualizarCatalogo = async (): Promise<void> => {
  if (!config.agentRuntime.enabled) return;
  const listados = await serviceModels(config.agentRuntime.providers);
  modelCatalog = montarCatalogo(listados);
};

const modelConfigurationStore = createModelConfigurationStore(database);
void modelConfigurationStore
  .sync(config.agentRuntime.providers)
  .catch((error) => {
    console.error("Não foi possível gravar os modelos configurados.", error);
  });
void atualizarCatalogo().catch((error) => {
  console.warn("Não foi possível perguntar os modelos aos serviços.", error);
});

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);
const pluginStore = createPluginStore({
  database,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
  allowPrivateMcp: config.plugins.allowPrivateMcp,
});

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "an administrator, saved in this deployment"
        : config.computer?.policy
          ? "configuration"
          : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything an administrator sets from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record whether each Bot has a computer of its own.
 *
 * A shared provider is a fine way to run on a laptop, but the shared isolation state must be visible
 * rather than inferred.
 */
const isolation = describeComputerIsolation(computerProvider);

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  payload: {
    isolation: isolation.isolation,
    note: isolation.note,
  },
}).catch(() => undefined);

console.info(
  JSON.stringify({
    type: "computer-isolation",
    provider: computerProvider ? computerProvider.name : "none",
    isolation: isolation.isolation,
    ...(isolation.warning ? { warning: isolation.warning } : {}),
  }),
);

/*
 * O que este processo faz com tarefas, em uma linha.
 *
 * Um deployment que sobe sem provedor, sem worker ou sem Telegram parece igual a um que subiu certo:
 * as tarefas ficam na fila em silêncio. A linha diz os três de uma vez, no formato que o resto do
 * boot já usa, para que a primeira pergunta — "por que a tarefa não anda?" — se responda no log.
 */
console.info(
  JSON.stringify({
    type: "agent-runtime",
    enabled: config.agentRuntime.enabled,
    worker: config.agentRuntime.workerEnabled,
    providers: providers.list().length,
    defaultProvider: config.agentRuntime.defaultProvider,
    artifactsDir: config.agentRuntime.artifactsDir,
    approvals:
      config.agentRuntime.approvalPatterns.length > 0
        ? "extra-patterns"
        : "default",
    telegram: config.telegram
      ? {
          bot: config.telegram.botId,
          allowedUsers: config.telegram.allowedUserIds.length,
          running: Boolean(
            agentRunService && config.agentRuntime.workerEnabled,
          ),
        }
      : "off",
  }),
);
/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      type: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    }),
  );
});

/**
 * The watch on Bot streams, built once and shared by every run.
 *
 * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
 * running long after the run request has been answered, because in Intelligence mode that request is
 * answered in about a second and the Bot keeps writing for as long as it has something to say.
 *
 * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
 */
const stallGuard = createStallGuard({
  stallMs: config.agentStallTimeoutMs,
  auditStore: bootAuditStore,
});

/**
 * Thread history for the local runtime.
 *
 * Built and warmed before the runtime is mounted, because the first request may ask for a thread's
 * messages and the read is synchronous: whatever is going to answer it has to already be in memory.
 * In `intelligence` mode this stays undefined and CopilotKit holds the threads instead.
 */
const threadHistoryRunner =
  config.runtime.mode === "local"
    ? await (async () => {
        const runner = new DurableAgentRunner(database);
        const restored = await runner.preload();
        console.log(`Local thread history: ${restored} thread(s) restored.`);
        return runner;
      })()
    : undefined;

/**
 * O Telegram: o mesmo runtime, com outra porta de entrada.
 *
 * Construído antes do app porque as rotas de pareamento montam a partir daqui, e depois do serviço de
 * tarefas porque a conversa só existe para conduzi-las. Um deployment sem token não monta nada disto —
 * não há bot para receber mensagem, e uma tela de pareamento que não leva a lugar nenhum é pior do que
 * nenhuma tela.
 */
const telegram =
  config.telegram && agentRunService
    ? (() => {
        const store = createTelegramStore(database);
        const client = createTelegramClient({ token: config.telegram.token });
        const vision = computerGateway
          ? {
              gateway: computerGateway,
              artifacts: artifactStore,
              sensitiveHosts: config.agentRuntime.sensitiveHosts,
              retentionDays: config.agentRuntime.artifactRetentionDays,
            }
          : undefined;
        const handler = createTelegramHandler({
          store,
          runs: agentRunService,
          allowedUserIds: config.telegram.allowedUserIds,
          ...(vision ? { vision } : {}),
          providers,
        });
        const poller = createTelegramPoller({
          store,
          handler,
          client,
          botId: config.telegram.botId,
          onError: (error) => {
            console.error("A leitura do Telegram falhou.", error);
          },
        });
        const sender = createTelegramSender({
          store,
          client,
          intervalMs: config.telegram.deliveryIntervalMs,
        });
        return {
          store,
          client,
          poller,
          sender,
          notifier: createTelegramNotifier({
            store,
            repository: agentRunRepository,
          }),
        };
      })()
    : undefined;

if (config.telegram && !agentRunService) {
  console.warn(
    "TELEGRAM_BOT_TOKEN está configurado, mas o runtime de tarefas está desligado (AGENT_RUNTIME_ENABLED): a conversa não sobe. Ligue o runtime para usar o Telegram.",
  );
}

const app = createApp(
  config,
  auth,
  roleRepository,
  createAuditReader(database),
  createCredentialAdminService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database),
  ),
  createPackageStatusReader(database),
  createConnectorAdminService(
    tenantPackage.knowledgeSources,
    database,
    createCredentialAdminService(
      config.keyEncryptionKey,
      credentialStore,
      createAuditStore(database),
    ),
    // O que permite abrir a credencial de volta na hora de sincronizar. Guardar nunca precisou dela.
    { reader: credentialStore, encryptionKey: config.keyEncryptionKey },
  ),
  // The runtime call: the model, per-actor agent loading, and the two identity
  // functions are how a run is attributed to a person.
  mountCopilotRuntime(
    config,
    tenantPackage.model,
    loadAgentsForActor,
    () =>
      resolveModelApiKey({
        encryptionKey: config.keyEncryptionKey,
        reader: credentialStore,
        provider: tenantPackage.model.provider,
        keyId: tenantPackage.model.credentialSecretRef,
        environment: process.env,
      }),
    identifyUser,
    identifyActor,
    stallGuard,
    // Tools run here, not in the browser. Each one still executes through the plugin store, so the
    // grant, the policy and the audit row are exactly where they were.
    (actorId) => (botId) =>
      grantedTools({ store: pluginStore, botId, actorId }),
    /*
     * What the deployment tells a remote Bot about the run it is starting.
     *
     * Signed here, where the encryption key lives, so the runtime module never holds a secret. The Bot
     * hands this back when it calls a tool, and it is where the Bot id and the person's name come
     * from: its own token proves which agent is calling, this proves who it is calling for, and
     * neither is read out of the request body any more.
     */
    (actorId) => (botId, runId) =>
      mintRunAssertion({ botId, actorId, runId }, config.keyEncryptionKey),
    // Where thread history lives. Undefined in `intelligence` mode, where CopilotKit holds it.
    threadHistoryRunner,
  ),
  // The only path to an acting call.
  computerGateway,
  policyStore,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,
  // Who has signed in, and what an administrator may do about them.
  peopleStore,
  // The enterprise identity providers registered here. Read as facts about the deployment rather
  // than through Better Auth's own listing, which answers per person. See identity-provider-store.ts.
  identityProviderStore,
  createKnowledgeSearch(database),
  // Durable tasks. Undefined when the runtime is switched off, which unmounts the routes.
  agentRunService,
  // As rotas de imagem: capturar, classificar e guardar são a mesma decisão, e sem o gateway não há
  // de onde capturar.
  computerGateway
    ? {
        gateway: computerGateway,
        artifacts: artifactStore,
        sensitiveHosts: config.agentRuntime.sensitiveHosts,
        retentionDays: config.agentRuntime.artifactRetentionDays,
      }
    : undefined,
  // O Telegram, quando há token. As rotas de pareamento existem mesmo sem o runtime: ligar o chat é
  // o passo anterior a ter tarefas.
  telegram ? telegram.store : undefined,
  // Quais modelos existem. Descreve o mesmo runtime que o serviço acima; com ele desligado, some.
  config.agentRuntime.enabled ? () => modelCatalog : undefined,
  config.agentRuntime.enabled ? atualizarCatalogo : undefined,
);

/**
 * O executor das tarefas: o ciclo observar→decidir→agir, e o worker que o alimenta.
 *
 * Montado aqui, e não dentro do serviço, porque ele precisa das três coisas que só o boot tem: o
 * gateway (por onde toda ação passa), os provedores configurados e o armazém de artefatos. Sem
 * computador não há o que observar, então o worker não sobe: as tarefas ficam na fila visíveis em vez
 * de falharem sozinhas por um motivo que ninguém pediu.
 */
if (agentRunService && computerGateway && config.agentRuntime.workerEnabled) {
  const executor = createAgentRunExecutor({
    repository: agentRunRepository,
    auditStore: bootAuditStore,
    providers,
    // O que distingue uma escolha de um padrão: ver `AgentRunInput.model`.
    defaultModel: config.agentRuntime.defaultModel,
    observations: createGatewayObservationSource({
      gateway: computerGateway,
      artifacts: artifactStore,
      sensitiveHosts: config.agentRuntime.sensitiveHosts,
      retentionDays: config.agentRuntime.artifactRetentionDays,
    }),
    tools: createBrowserTools({ gateway: computerGateway }),
    /*
     * O portão que pergunta antes de publicar, comprar ou apagar.
     *
     * Construído com o mesmo repositório do runtime, porque a aprovação é uma linha presa à tarefa e
     * ao hash da ação: quem aprova não autoriza "o modelo", autoriza aquele clique.
     */
    approvals: createApprovalGate({
      repository: agentRunRepository,
      ttlMs: config.agentRuntime.approvalTtlMs,
      extraPatterns: config.agentRuntime.approvalPatterns,
    }),
    // Quem avisa quem pediu. Ausente quando não há Telegram: a tarefa não depende de ter um canal.
    ...(telegram ? { notifier: telegram.notifier } : {}),
    leaseTtlMs: config.agentRuntime.leaseTtlMs,
    maxCorrections: config.agentRuntime.maxCorrections,
    maxRefusals: 2,
    maxProviderRetries: 1,
  });
  const worker = createAgentRunWorker({
    repository: agentRunRepository,
    service: agentRunService,
    execute: executor,
    owner: `server:${process.pid}`,
    pollMs: config.agentRuntime.pollMs,
    leaseTtlMs: config.agentRuntime.leaseTtlMs,
    concurrency: config.agentRuntime.concurrency,
    housekeeping: async () => {
      await artifactStore.deleteExpired();
      /*
       * Aprovações vencidas viram `expired` no relógio do worker, e não quando alguém olha. Uma
       * aprovação de ontem que continuasse `pending` deixaria o painel pedindo uma decisão que já não
       * vale, e o modelo esperando por ela.
       */
      const expired = await agentRunRepository.expireApprovals(new Date());
      if (expired > 0) {
        await recordAuditEvent(bootAuditStore, {
          eventType: "agent_run.recovered",
          targetType: "agent_run",
          payload: { approvalsExpired: expired },
        }).catch(() => undefined);
      }
    },
  });
  worker.start();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void worker.stop();
    });
  }
}

/*
 * O Telegram só roda onde o worker roda.
 *
 * Ler updates é barato, mas responder a eles cria tarefas — e um processo que não conduz a fila
 * deixaria cada mensagem como uma tarefa parada na fila, sem ninguém para executá-la. Um deployment
 * com várias réplicas liga isto na réplica que tem o worker, que é a mesma decisão que
 * AGENT_WORKER_ENABLED já expressa.
 */
if (telegram && agentRunService && config.agentRuntime.workerEnabled) {
  await telegram.poller.start();
  await telegram.sender.start();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void telegram.poller.stop();
      void telegram.sender.stop();
    });
  }
  console.info(
    JSON.stringify({
      type: "telegram",
      bot: config.telegram?.botId,
      allowedUsers: config.telegram?.allowedUserIds.length ?? 0,
      note:
        (config.telegram?.allowedUserIds.length ?? 0) === 0
          ? "TELEGRAM_ALLOWED_USER_IDS está vazio: o bot responde a qualquer pessoa com uma recusa até que a lista seja configurada."
          : "Somente os ids listados falam com este bot.",
    }),
  );
}

/**
 * The live screen, proxied.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app.
 */
const toStreamUrl = (baseUrl: string, botId: string) =>
  // The Bot travels in the query, because a websocket upgrade carries no custom header for the
  // computer to read and every call it serves is per Bot. The secret travels the same way and for the
  // same reason, this socket is the one a person can type into, so it is the last thing that should
  // be reachable without it.
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(config.computer?.token ?? "")}`;

/**
 * Which Bot's screen. The Bot is named in the path and its computer is located the same way every
 * other call locates it, so the live stream cannot point at a different Bot's browser.
 */
const streamPathBotId = (pathname: string): string | null => {
  const match = pathname.match(/^\/api\/computers\/([^/]+)\/stream$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = { upstream: string; inward?: WebSocket };

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: the app proxies
 * the computer stream, and it pushes channel activity through Hono's adapter. So this one
 * dispatches on what the upgrade attached, a proxy socket carries `upstream`, a Hono socket does
 * not, rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

serve<SocketData>({
  port,
  /*
   * O teto do Bun, e não o padrão dele.
   *
   * O padrão é dez segundos de silêncio, e um Bot que pensa antes de falar fica calado mais que isso
   * o tempo todo: o fluxo SSE morria no meio da resposta com ECONNRESET, sem uma linha de log dos
   * dois lados, e o que a pessoa via era a conversa parar. 255 é o máximo que o Bun aceita; passar
   * disso exige o Bot mandar sinal de vida, que é o que agent-codex faz com um evento CUSTOM.
   */
  idleTimeout: 255,
  async fetch(request, server) {
    const url = new URL(request.url);
    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId !== null &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (!config.computer) {
        return new Response("No computer is configured.", { status: 503 });
      }
      // The session guard, applied by hand because middleware does not run on an upgrade. An
      // unauthenticated socket here would be the whole point of the proxy defeated.
      const actor = await resolveRequestActor(request).catch(() => null);
      if (!actor) {
        return new Response("Sign in first.", { status: 401 });
      }
      // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
      // so signing in is not enough: without this, anybody signed in watches anybody's Bot work.
      if (
        !(await agentProfileStore
          .get({ id: actor.id, role: actor.role }, streamBotId)
          .catch(() => null))
      ) {
        return new Response("There is no such Bot.", { status: 404 });
      }
      /*
       * Through the gateway, not the provider.
       *
       * `gateway.locate` runs checkComputerAddress; `provider.locate` does not, and the URL built
       * below carries COMPUTER_TOKEN in its query string. A provider that answered with a foreign
       * host was handed the deployment's computer token, which is the case that check was written
       * for. Every acting path already went through the gateway; this one did not.
       */
      let upstream: string;
      try {
        const streamBase = computerGateway
          ? await computerGateway.locate(streamBotId)
          : undefined;
        if (!streamBase) {
          return new Response("No computer address is configured.", {
            status: 503,
          });
        }
        upstream = toStreamUrl(streamBase, streamBotId);
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent.
        return new Response(
          error instanceof Error
            ? error.message
            : "That Bot's computer could not be reached.",
          { status: 502 },
        );
      }
      if (server.upgrade(request, { data: { upstream } })) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    return app.fetch(request, { server });
  },
  websocket: {
    open(ws) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.open(asChannelSocket(ws));
        return;
      }
      const inward = new WebSocket(ws.data.upstream);
      ws.data.inward = inward;
      // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
      // should be dropped, not queued, because a stale frame is worse than a missing one.
      inward.onmessage = (event) => {
        try {
          ws.send(String(event.data));
        } catch {
          inward.close();
        }
      };
      inward.onclose = () => ws.close();
      inward.onerror = () => ws.close();
    },
    message(ws, raw) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.message(asChannelSocket(ws), raw);
        return;
      }
      if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
    },
    close(ws, code, reason) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.close(asChannelSocket(ws), code, reason);
        return;
      }
      ws.data.inward?.close();
    },
  },
});

if (config.singleUser) {
  // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
  console.warn(
    "No identity provider is configured, so every request is treated as " +
      `${DEV_ACTOR.email} (administrator). Configure GOOGLE_OAUTH_*, ` +
      "MICROSOFT_OAUTH_* or OKTA_OAUTH_* before anybody else can reach this.",
  );
}

// The activity listener holds a connection of its own for the life of the process. Released on the
// way out, so a watch-mode restart does not leave one behind on every reload.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void channelActivityListener.stop().finally(() => process.exit(0));
  });
}

console.info(`OpenBot server listening on http://localhost:${port}`);
