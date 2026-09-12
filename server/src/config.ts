/**
 * What the runtime can do. Two answers, and the default is the one that keeps every byte on this
 * deployment: `local` runs the CopilotKit SSE runtime with no vendor account, no licence token and
 * no outbound call, and durable threads come from this deployment's own PostgreSQL. `intelligence`
 * is the upstream contract, kept so a deployment that wants CopilotKit's hosted threads and memory
 * can still ask for it. Configuration the product cannot function without belongs at the boot
 * boundary.
 */
import { singleUserEnabled } from "./auth/dev-actor";
import type { ActionPolicy } from "./computer/policy";
import { parseActionPolicy } from "./computer/policy-store";

export type RuntimeCapabilities =
  | {
      mode: "local";
      durableHistory: true;
      intelligence?: undefined;
    }
  | {
      mode: "intelligence";
      durableHistory: true;
      intelligence: IntelligenceSettings;
    };

/** The Intelligence contract. Every field is required; see runtimeCapabilities. */
export type IntelligenceSettings = {
  apiUrl: string;
  gatewayWsUrl: string;
  apiKey: string;
  licenseToken: string;
};

export type DockerComputerConfig = {
  provider: "docker";
  baseUrl: string;
  supervisorToken?: string;
  token?: string;
  /** Se um Bot pode ser REGISTRADO num endereço interno. Ver a nota em `allowPrivateNavigation`. */
  allowPrivateHosts: boolean;
  /** Se o NAVEGADOR do Bot pode entrar na rede deste deployment. Outra pergunta, outra variável. */
  allowPrivateNavigation: boolean;
  policy?: ActionPolicy;
};

export type SharedComputerConfig = {
  provider: "shared";
  baseUrl: string;
  token?: string;
  /** Se um Bot pode ser REGISTRADO num endereço interno. Ver a nota em `allowPrivateNavigation`. */
  allowPrivateHosts: boolean;
  /** Se o NAVEGADOR do Bot pode entrar na rede deste deployment. Outra pergunta, outra variável. */
  allowPrivateNavigation: boolean;
  policy?: ActionPolicy;
};

export type ComputerConfig = DockerComputerConfig | SharedComputerConfig;

/**
 * Um modelo configurado neste deployment.
 *
 * `transport` é o dialeto, não a marca: `responses`, `messages` e `chat-completions` são três APIs
 * diferentes, e duas empresas podem usar o mesmo dialeto. `gemini` é a API nativa do Google, onde a
 * imagem vai como bytes. `delegated` é o modo em que a tarefa inteira é entregue a um serviço que
 * conduz o próprio ciclo — o do Codex, o de um CLI de agente.
 */
export type AgentModelConfig = {
  id: string;
  transport:
    | "responses"
    | "messages"
    | "chat-completions"
    | "gemini"
    | "delegated";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /**
   * O token que este deployment apresenta a um Bot gerenciado (transporte `delegated`).
   *
   * Separado de `apiKey` porque não é uma chave de fornecedor: é a identidade deste deployment diante
   * do serviço que ele mesmo hospeda, e quem a valida é o `hasManagedAgentToken` do outro lado.
   */
  agentToken?: string;
  /** Presumida pelo nome do modelo até o teste de canvas homologá-la. Ver providers/index.ts. */
  vision: boolean;
  tools: boolean;
};

/**
 * Roteamento opt-in de modelos (RQ-10): dois candidatos, no máximo uma escalada.
 *
 * Ausente é o modo fixo — provedor e modelo escolhidos são preservados sem substituição.
 * Presente, o id sintético `routed` passa a existir, e só a tarefa que o escolhe é roteada;
 * o padrão do deployment nunca vira `routed` sozinho. Ambos os ids precisam estar
 * configurados neste deployment, ser distintos e nunca ser o próprio `routed`.
 */
export type AgentRoutingPolicy = {
  primary: string;
  fallback?: string;
};
/**
 * The durable task runtime.
 *
 * Absent means the feature is off and its routes are not mounted, like the computer above. The
 * defaults are the small-VPS numbers from the PRD: one browser run at a time, forty steps, fifteen
 * minutes, and a human window measured in minutes rather than seconds.
 */
export type AgentRuntimeConfig = {
  enabled: boolean;
  /** Whether this process runs the queue. One replica says yes; the others would only duplicate. */
  workerEnabled: boolean;
  pollMs: number;
  concurrency: number;
  defaultProvider: string;
  defaultModel: string;
  /** Os modelos que este deployment pode chamar, na ordem em que são preferidos. */
  providers: AgentModelConfig[];
  /** Opt-in de roteamento; ausente mantém o modo fixo. Ver `AgentRoutingPolicy`. */
  routingPolicy?: AgentRoutingPolicy;
  /** How long a run lease lasts without a heartbeat; also the profile lock's TTL. */
  leaseTtlMs: number;
  maxSteps: number;
  maxRunMs: number;
  maxCorrections: number;
  artifactsDir: string;
  artifactRetentionDays: number;
  /**
   * Hosts cujas páginas são gravadas para o painel mas nunca enviadas a um modelo.
   *
   * Classificação de dados é uma decisão do deployment, e a lista vazia é o padrão: uma empresa que
   * trabalha com prontuários ou extratos escreve os hosts aqui e a captura dessas páginas passa a
   * ficar retida para revisão em vez de seguir para o provedor. Ver NFR-05.
   */
  sensitiveHosts: string[];
  /**
   * Quanto tempo uma aprovação espera antes de expirar.
   *
   * Um sim é para uma ação e para um momento: uma aprovação de ontem que valesse hoje autorizaria uma
   * página que já mudou. Vencida, o modelo precisa pedir de novo.
   */
  approvalTtlMs: number;
  /**
   * Termos que este deployment considera sensíveis além dos verbos conhecidos.
   *
   * O classificador cobre publicar, comprar, enviar e apagar em português e inglês; isto é para o que
   * só faz sentido na operação de alguém — o nome do ERP, o botão de fechamento de competência.
   */
  approvalPatterns: string[];
  waitingHumanMinutes: number;
  idleBrowserMinutes: number;
};

/**
 * Who a deployment lets in, and through which front door.
 *
 * One identity provider is a product decision somebody else already made. A company running this
 * has Google or Entra or Okta and is not going to acquire another, so the shape here is a set of
 * optional providers rather than one required one, and the deployment turns on whichever it has.
 */
export type AuthProviderId = "google" | "microsoft" | "okta";

/** An OAuth client, as every provider here needs one. */
export type OAuthClient = { clientId: string; clientSecret: string };

export type AuthConfig = {
  baseUrl: string;
  secret: string;
  trustedOrigins: string[];
  initialAdminEmails: string[];
  google?: OAuthClient;
  /**
   * `tenantId` decides who may sign in at all, so it is not a detail. `common` admits any Microsoft
   * account including personal ones, `organizations` any work or school account anywhere, and a GUID
   * admits one directory. A deployment that wants only its own company needs the GUID.
   */
  microsoft?: OAuthClient & { tenantId: string };
  /** Okta is an OIDC provider rather than a named one, so it is identified by its issuer. */
  okta?: OAuthClient & { issuer: string };
};

/**
 * The providers this deployment can actually sign somebody in with.
 *
 * Ordered, and deliberately not alphabetically: this is the order the buttons appear in, and it is
 * fixed here rather than left to object key order so the sign-in screen cannot change shape because
 * of how a configuration happened to be written.
 */
export function configuredAuthProviders(
  auth: AuthConfig | undefined,
): AuthProviderId[] {
  if (!auth) return [];
  const providers: AuthProviderId[] = [];
  if (auth.google) providers.push("google");
  if (auth.microsoft) providers.push("microsoft");
  if (auth.okta) providers.push("okta");
  return providers;
}

/**
 * O que este deployment aceita registrar como servidor MCP que não veio do catálogo revisado.
 *
 * `allowPrivateMcp` levanta a exigência de https e as regras de host do registro por URL — é o que
 * permite registrar uma API da casa. O endereço de credencial de nuvem continua recusado com ela
 * ligada, e por isso isto não é "qualquer endereço": é "os endereços deste deployment".
 */
export type PluginsConfig = {
  allowPrivateMcp: boolean;
};

export type DeploymentConfig = {
  databaseUrl: string;
  keyEncryptionKey: string;
  managedAgentAgUiUrl: URL;
  /** Secret sent only to the managed Bot endpoint. Never stored in an agent row. */
  managedAgentToken: string;
  /**
   * What this deployment calls itself, when more than one shares an Intelligence project.
   *
   * Absent, the tenant package's id stands in, which separates deployments running different
   * packages but not a copy of one running alongside the original. See channels/thread-identity.ts.
   */
  deploymentId: string | undefined;
  tenantPackageDirectory: string;
  runtime: RuntimeCapabilities;
  /**
   * How long a Bot's stream may say nothing before this deployment ends the turn, in milliseconds.
   *
   * Zero means no watchdog, and an unset variable means zero. A turn that is ended is a turn
   * somebody loses, so a deployment that has not said it wants that gets the behaviour it already
   * had. `.env.example` ships a value, so a new clone starts with the watch on and an upgraded
   * deployment does not acquire it without being asked.
   */
  agentStallTimeoutMs: number;
  oauth: {
    google?: { clientId: string; clientSecret: string };
  };
  auth?: AuthConfig;
  /**
   * Admit everybody as one fixed administrator instead of requiring sign-in.
   *
   * True only when no identity provider is configured. See auth/dev-actor.ts for what stops this
   * reaching somewhere other people can get to.
   */
  singleUser: boolean;
  /** Names OpenBot on the analytics the runtime already sends. Off with OPENBOT_ACCESSIBILITY_DISABLED. */
  accessibility: boolean;
  /**
   * Where the built app is, when this process serves it.
   *
   * Set in a container image that carries both. Unset in development, where Vite serves the app and
   * proxies the API here, so the server stays an API and nothing shadows a route.
   */
  appDistDir?: string;
  /**
   * The Bot computer. Absent means the feature is off and its routes are not mounted, rather than
   * mounted and failing: a capability that is not configured should be missing, not broken.
   */
  computer?: ComputerConfig;
  /** The durable task runtime. Present by default; switched off with AGENT_RUNTIME_ENABLED=off. */
  agentRuntime: AgentRuntimeConfig;
  /**
   * The secret a Bot presents when it calls a tool back through this server.
   *
   * A framework Bot runs its own tool loop, in its own process, which is what makes it a real
   * harness rather than a shape the browser drives. It still may not reach a vendor directly: it
   * calls here, and here is where the grant, the policy and the audit row are. This is what tells
   * that call apart from anybody else on the network.
   *
   * Absent means no Bot may call tools back, and a deployment that wanted them gets a refusal rather
   * than an open door.
   */
  agentToolToken?: string;
  /**
   * O bot do Telegram deste deployment.
   *
   * Ausente quando não há token: um deployment sem Telegram sobe normalmente, sem rotas de pareamento
   * e sem laço de leitura, em vez de recusar o boot por falta de uma credencial de canal.
   */
  telegram?: TelegramConfig;
  /** O que pode ser registrado como servidor MCP além do catálogo revisado. */
  plugins: PluginsConfig;
};

export type TelegramConfig = {
  token: string;
  /**
   * Quem pode falar com o bot, por id numérico.
   *
   * Lista vazia significa ninguém: o canal está configurado e o bot responde a todos com uma recusa.
   * É a leitura segura do que "não configurado" quer dizer, e é por isso que ela não abre o bot para
   * o mundo quando alguém esquece a variável.
   */
  allowedUserIds: string[];
  /** Identidade do bot nas tabelas. Muda quando há mais de um bot no mesmo deployment. */
  botId: string;
  /** Quanto tempo o getUpdates fica pendurado em cada chamada. */
  pollTimeoutSeconds: number;
  /** De quanto em quanto tempo a caixa de saída é verificada. */
  deliveryIntervalMs: number;
};

type Environment = Record<string, string | undefined>;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function optional(environment: Environment, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
}

/**
 * The key in `.env.example`, which every clone of this repository starts with.
 *
 * It is a valid key, which is the whole problem: it is the right length and the right encoding, so
 * nothing about it fails a check. A deployment that never changed it encrypts its credential vault
 * with a key printed in a public repository, and looks exactly like one that did.
 */
const PLACEHOLDER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function keyEncryptionKey(environment: Environment): string {
  const value = required(environment, "KEY_ENCRYPTION_KEY");
  const decoded = Buffer.from(value, "base64");

  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  /**
   * Refused in production, warned everywhere else. The placeholder is convenient locally and public
   * in any deployment.
   */
  if (value === PLACEHOLDER_KEY) {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "KEY_ENCRYPTION_KEY is still the example key from .env.example, which is public. Generate one with: openssl rand -base64 32",
      );
    }
    console.warn(
      "KEY_ENCRYPTION_KEY is the example key from .env.example, which is public. Fine locally. Generate a real one before deploying: openssl rand -base64 32",
    );
  }

  return value;
}

function url(environment: Environment, name: string): string | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

function requiredHttpUrl(environment: Environment, name: string): URL {
  const value = required(environment, name);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  return parsed;
}

function oauthClient(
  environment: Environment,
  provider: "GOOGLE" | "MICROSOFT" | "OKTA",
): OAuthClient | undefined {
  const clientId = optional(environment, `${provider}_OAUTH_CLIENT_ID`);
  const clientSecret = optional(environment, `${provider}_OAUTH_CLIENT_SECRET`);

  // Both or neither. One alone is a half-configured sign-in that fails at the first attempt rather
  // than at start-up, which is the worst moment to discover it.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      `${provider}_OAUTH_CLIENT_ID and ${provider}_OAUTH_CLIENT_SECRET must be set together`,
    );
  }

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function commaSeparated(environment: Environment, name: string): string[] {
  return (optional(environment, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Sign-in, if this deployment has an identity provider to sign people in with.
 *
 * Any one of the three turns authentication on. More than one is allowed and is the normal shape
 * for a company mid-migration, where some people are on Entra and some are still on Okta.
 *
 * Every combination that cannot work refuses at start-up rather than at somebody's first attempt to
 * sign in, which is the worst moment to discover it: a provider with half its credentials, a
 * provider with no session secret to mint against, or a session secret configured with no provider
 * to use it.
 */
function authConfig(
  environment: Environment,
  google: OAuthClient | undefined,
): AuthConfig | undefined {
  const microsoft = microsoftAuth(environment);
  const okta = oktaAuth(environment);

  const secret = optional(environment, "BETTER_AUTH_SECRET");
  const baseUrl = url(environment, "BETTER_AUTH_URL");

  if (!google && !microsoft && !okta) {
    if (secret || baseUrl) {
      throw new Error(
        "BETTER_AUTH_SECRET or BETTER_AUTH_URL is set but no identity provider is. Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_*, or unset both",
      );
    }
    return undefined;
  }
  if (!secret) {
    throw new Error("Sign-in requires BETTER_AUTH_SECRET");
  }
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  if (!baseUrl) {
    throw new Error("Sign-in requires BETTER_AUTH_URL");
  }

  /*
   * Somebody has to be an administrator, and only this says who.
   *
   * The role is written from this list and there is no route anywhere that changes one, so a
   * deployment that configures sign-in without it admits everybody as a plain user, shows nobody
   * the admin screens, and offers no way to promote anyone. Refusing at start-up is the only cheap
   * moment to catch that; the expensive one is after the first person has signed in.
   */
  const initialAdminEmails = commaSeparated(
    environment,
    "INITIAL_ADMIN_EMAILS",
  );
  if (initialAdminEmails.length === 0) {
    throw new Error(
      "Sign-in requires INITIAL_ADMIN_EMAILS naming at least one administrator. Nothing else grants the role, and no screen can promote somebody once the deployment is running",
    );
  }

  return {
    baseUrl,
    secret,
    trustedOrigins: commaSeparated(environment, "TRUSTED_ORIGINS").length
      ? commaSeparated(environment, "TRUSTED_ORIGINS")
      : ["http://localhost:3000"],
    initialAdminEmails,
    ...(google ? { google } : {}),
    ...(microsoft ? { microsoft } : {}),
    ...(okta ? { okta } : {}),
  };
}

/**
 * Entra ID, and which directory it admits.
 *
 * `common` by default, matching Microsoft's own default, and said out loud in `.env.example` because
 * it admits personal Microsoft accounts as well as work ones. A company that means "our staff"
 * wants its directory GUID here.
 */
function microsoftAuth(
  environment: Environment,
): (OAuthClient & { tenantId: string }) | undefined {
  const client = oauthClient(environment, "MICROSOFT");
  if (!client) return undefined;
  return {
    ...client,
    tenantId: optional(environment, "MICROSOFT_OAUTH_TENANT_ID") ?? "common",
  };
}

/**
 * Okta, which is an OIDC provider rather than a named one.
 *
 * The issuer is what makes it a particular Okta rather than Okta in general, so it is required
 * alongside the credentials rather than defaulted to anything.
 */
function oktaAuth(
  environment: Environment,
): (OAuthClient & { issuer: string }) | undefined {
  const client = oauthClient(environment, "OKTA");
  const issuer = url(environment, "OKTA_OAUTH_ISSUER");
  if (!client) {
    if (issuer) {
      throw new Error(
        "OKTA_OAUTH_ISSUER is set but OKTA_OAUTH_CLIENT_ID and OKTA_OAUTH_CLIENT_SECRET are not",
      );
    }
    return undefined;
  }
  if (!issuer) {
    throw new Error(
      "Okta sign-in requires OKTA_OAUTH_ISSUER, such as https://example.okta.com/oauth2/default",
    );
  }
  return { ...client, issuer };
}

/**
 * Resolve which runtime this deployment runs, or refuse to start.
 *
 * `local` is the default and needs nothing: the SSE runtime holds no vendor account, and threads are
 * this deployment's own rows. `intelligence` has to be asked for by name, and then all four values
 * are required together. A partial set is the more dangerous shape than none at all: it means
 * somebody intended to configure Intelligence and got it wrong, so failing on the partial set alone
 * let a completely unconfigured deployment through as if that were a choice.
 */
function runtimeCapabilities(environment: Environment): RuntimeCapabilities {
  const requested = (optional(environment, "RUNTIME_MODE") ?? "local").trim();

  if (requested !== "local" && requested !== "intelligence") {
    throw new Error(
      `RUNTIME_MODE must be "local" or "intelligence", not "${requested}".`,
    );
  }

  if (requested === "local") {
    return { mode: "local", durableHistory: true };
  }

  const settings = {
    apiUrl: url(environment, "INTELLIGENCE_API_URL"),
    gatewayWsUrl: url(environment, "INTELLIGENCE_GATEWAY_WS_URL"),
    apiKey: optional(environment, "INTELLIGENCE_API_KEY"),
    licenseToken: optional(environment, "COPILOTKIT_LICENSE_TOKEN"),
  };

  const missing = Object.entries({
    INTELLIGENCE_API_URL: settings.apiUrl,
    INTELLIGENCE_GATEWAY_WS_URL: settings.gatewayWsUrl,
    INTELLIGENCE_API_KEY: settings.apiKey,
    COPILOTKIT_LICENSE_TOKEN: settings.licenseToken,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `CopilotKit Intelligence is required and is not configured. Missing: ${missing.join(", ")}`,
    );
  }

  return {
    mode: "intelligence",
    durableHistory: true,
    intelligence: settings as IntelligenceSettings,
  };
}

function computerConfig(environment: Environment): ComputerConfig | undefined {
  const supervisorAddress = optional(environment, "COMPUTER_SUPERVISOR_URL");
  const sharedAddress = optional(environment, "AGENT_COMPUTER_URL");
  if (!supervisorAddress && !sharedAddress) {
    return undefined;
  }

  /*
   * The secret the computers require. Without it every call to a computer is refused, and that is the
   * intended failure: `agent-computer` drives a browser holding real logins and must not answer
   * unauthenticated callers that can reach its port.
   */
  const computerToken = optional(environment, "COMPUTER_TOKEN");

  const allowPrivateHosts =
    optional(environment, "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS") === "true";
  /**
   * Se o navegador do Bot pode entrar na rede deste deployment.
   *
   * Variável própria, e desligada por padrão. Antes ela era a mesma de cima, e ali a resposta tem de
   * ser "sim" — `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` é o que permite REGISTRAR um Bot em
   * `http://agent-codex:4202`, que é onde os Bots deste deployment moram. Uma variável respondendo
   * duas perguntas fez a permissão necessária numa abrir a outra: o navegador do Bot lia
   * `http://openbot:3001/api/admin/connectors`, a API que o governa, com privilégio de
   * administrador num deployment de usuário único.
   */
  const allowPrivateNavigation =
    optional(environment, "COMPUTER_ALLOW_PRIVATE_NAVIGATION") === "true";
  const policy = actionPolicy(environment);

  const supervisorUrl = url(environment, "COMPUTER_SUPERVISOR_URL");
  if (supervisorUrl) {
    const supervisorToken = optional(environment, "SUPERVISOR_TOKEN");
    return {
      provider: "docker",
      baseUrl: supervisorUrl,
      allowPrivateHosts,
      allowPrivateNavigation,
      ...(supervisorToken ? { supervisorToken } : {}),
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  const baseUrl = url(environment, "AGENT_COMPUTER_URL");
  if (!baseUrl) {
    return undefined;
  }

  return {
    provider: "shared",
    baseUrl,
    allowPrivateHosts,
    allowPrivateNavigation,
    ...(computerToken ? { token: computerToken } : {}),
    ...(policy ? { policy } : {}),
  };
}

/**
 * The action policy, as JSON in one variable.
 *
 * Refuses to start on malformed JSON or a policy of the wrong shape, rather than falling back to the
 * default. An operator who wrote a rule and mistyped it would otherwise get a running deployment that
 * silently permits what they had just tried to forbid, and no indication that anything was wrong.
 * Configuration the product cannot honour belongs at the boot boundary; see the note at the top.
 */
function actionPolicy(environment: Environment): ActionPolicy | undefined {
  const raw = optional(environment, "AGENT_COMPUTER_POLICY");
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_COMPUTER_POLICY must be valid JSON");
  }

  const result = parseActionPolicy(parsed);
  if (!result.ok) {
    throw new Error(`AGENT_COMPUTER_POLICY is invalid: ${result.error}`);
  }
  return result.policy;
}

/**
 * How long silence on a Bot's stream is allowed to last.
 *
 * Refuses to start on anything that is not a whole number of milliseconds, rather than falling back
 * to the default. Same reasoning as the action policy above it: an operator who meant to write a
 * two-minute timeout and typed something else would otherwise get a running deployment with a
 * silently different boundary, and no indication that anything was wrong.
 *
 * Zero is a legitimate value and means off. It is not the same as a malformed one.
 */
function accessibilityEnabled(environment: Environment): boolean {
  const off = optional(environment, "OPENBOT_ACCESSIBILITY_DISABLED");
  return off !== "true" && off !== "1";
}

function agentStallTimeoutMs(environment: Environment): number {
  const raw = optional(environment, "AGENT_STALL_TIMEOUT_MS");
  if (!raw) {
    return 0;
  }

  const milliseconds = Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "AGENT_STALL_TIMEOUT_MS must be a whole number of milliseconds, or 0 to switch the watchdog off",
    );
  }
  return milliseconds;
}

/** `AGENT_RUNTIME_ENABLED=off` and friends. Absent takes the default; nonsense refuses to boot. */
function flag(
  environment: Environment,
  name: string,
  fallback: boolean,
): boolean {
  const raw = optional(environment, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean such as true or false, or unset`);
}

function wholeNumber(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = optional(environment, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be a whole number of at least ${minimum}, or unset`,
    );
  }
  return value;
}

/**
 * Os modelos que este deployment consegue chamar, lidos do ambiente.
 *
 * Cada bloco só existe quando a credencial (ou, para um modelo local, o endereço) existe. É a mesma
 * pergunta que `configuredAuthProviders` faz para os provedores de identidade: um deployment tem o
 * que tem, e a interface mostra isso em vez de oferecer o que vai falhar.
 *
 * Visão é presumida pelo nome do modelo e pode ser negada em `AGENT_TEXT_ONLY_PROVIDERS`. A presunção
 * existe porque um nome de modelo sem visão recebendo uma imagem é um erro de payload, e o modo
 * seguro do outro lado é não mandar imagem nenhuma; negar explicitamente é o que um deployment faz
 * depois de rodar o teste de canvas contra o modelo e ver que ele não leu o que estava desenhado.
 */
function agentModels(environment: Environment): AgentModelConfig[] {
  const textOnly = new Set(
    commaSeparated(environment, "AGENT_TEXT_ONLY_PROVIDERS"),
  );
  const visionOverride = new Set(
    commaSeparated(environment, "AGENT_VISION_PROVIDERS"),
  );
  const visionFor = (id: string, model: string): boolean => {
    if (textOnly.has(id)) return false;
    if (visionOverride.has(id)) return true;
    return /gpt-5|gpt-4o|gpt-4\.1|o3|o4|claude|gemini|llava|qwen.*vl|pixtral|internvl/i.test(
      model,
    );
  };
  const models: AgentModelConfig[] = [];

  const openaiKey =
    optional(environment, "AGENT_OPENAI_API_KEY") ??
    optional(environment, "OPENAI_API_KEY");
  if (openaiKey) {
    const model =
      optional(environment, "AGENT_OPENAI_MODEL") ??
      optional(environment, "BOT_MODEL") ??
      "gpt-5.5";
    const baseUrl =
      optional(environment, "AGENT_OPENAI_BASE_URL") ??
      optional(environment, "OPENAI_BASE_URL");
    models.push({
      id: "openai-responses",
      transport: "responses",
      model,
      ...(baseUrl ? { baseUrl } : {}),
      apiKey: openaiKey,
      vision: visionFor("openai-responses", model),
      tools: true,
    });
  }

  const anthropicKey =
    optional(environment, "AGENT_ANTHROPIC_API_KEY") ??
    optional(environment, "ANTHROPIC_API_KEY");
  if (anthropicKey) {
    const model =
      optional(environment, "AGENT_ANTHROPIC_MODEL") ?? "claude-sonnet-4-5";
    const baseUrl =
      optional(environment, "AGENT_ANTHROPIC_BASE_URL") ??
      optional(environment, "ANTHROPIC_BASE_URL");
    models.push({
      id: "anthropic",
      transport: "messages",
      model,
      ...(baseUrl ? { baseUrl } : {}),
      apiKey: anthropicKey,
      vision: visionFor("anthropic", model),
      tools: true,
    });
  }

  const geminiKey =
    optional(environment, "AGENT_GEMINI_API_KEY") ??
    optional(environment, "GEMINI_API_KEY") ??
    optional(environment, "GOOGLE_API_KEY");
  if (geminiKey) {
    const model =
      optional(environment, "AGENT_GEMINI_MODEL") ?? "gemini-3.8-flash";
    const baseUrl = optional(environment, "AGENT_GEMINI_BASE_URL");
    models.push({
      id: "gemini",
      transport: "gemini",
      model,
      ...(baseUrl ? { baseUrl } : {}),
      apiKey: geminiKey,
      vision: visionFor("gemini", model),
      tools: true,
    });
  }

  const localBaseUrl = optional(environment, "AGENT_LOCAL_BASE_URL");
  if (localBaseUrl) {
    const model = optional(environment, "AGENT_LOCAL_MODEL") ?? "llama3.1";
    const localKey = optional(environment, "AGENT_LOCAL_API_KEY");
    models.push({
      id: "local",
      transport: "chat-completions",
      model,
      baseUrl: localBaseUrl,
      ...(localKey ? { apiKey: localKey } : {}),
      vision: visionFor("local", model),
      // Um modelo local pode não ter ferramentas; a variável existe para dizer isso sem descobrir na
      // primeira chamada.
      tools: flag(environment, "AGENT_LOCAL_TOOLS", true),
    });
  }

  /*
   * Os agentes delegados: serviços próprios que conduzem o ciclo inteiro e falam AG-UI.
   *
   * Um por CLI, porque cada um tem o seu jeito de ganhar ferramentas e a sua conta — o Codex, o
   * OpenCode, o MiMo. Do lado do runtime são o mesmo adaptador: o que muda é o endereço, e é por
   * isso que acrescentar um CLI novo é uma variável de ambiente e não um caminho de código.
   */
  const agentToken = optional(environment, "MANAGED_AGENT_TOKEN");
  const delegated = (
    id: string,
    prefix: string,
    url: string,
  ): AgentModelConfig => ({
    id,
    transport: "delegated",
    model: optional(environment, `${prefix}_MODEL`) ?? `${id} default`,
    baseUrl: url,
    // O mesmo token que os nossos serviços validam do outro lado. Ausente num deployment que aponta
    // para um AG-UI de terceiro: aí o cabeçalho não vai, e quem exigir autenticação diz isso.
    ...(agentToken ? { agentToken } : {}),
    // Presumida, e negável: quem roda o CLI é que sabe se o modelo dele enxerga a página.
    vision: flag(environment, `${prefix}_VISION`, true),
    tools: true,
  });

  const codexUrl =
    optional(environment, "AGENT_CODEX_URL") ??
    optional(environment, "MANAGED_AGENT_AG_UI_URL");
  if (codexUrl) models.push(delegated("codex", "AGENT_CODEX", codexUrl));

  for (const [id, prefix] of [
    ["opencode", "AGENT_OPENCODE"],
    ["mimo", "AGENT_MIMO"],
  ] as const) {
    const url = optional(environment, `${prefix}_URL`);
    if (url) models.push(delegated(id, prefix, url));
  }

  return models;
}

function telegramConfig(environment: Environment): TelegramConfig | undefined {
  const token = optional(environment, "TELEGRAM_BOT_TOKEN");
  if (!token) return undefined;
  return {
    token,
    allowedUserIds: commaSeparated(environment, "TELEGRAM_ALLOWED_USER_IDS"),
    botId: optional(environment, "TELEGRAM_BOT_ID") ?? "default",
    pollTimeoutSeconds: wholeNumber(
      environment,
      "TELEGRAM_POLL_SECONDS",
      25,
      1,
    ),
    deliveryIntervalMs:
      wholeNumber(environment, "TELEGRAM_DELIVERY_INTERVAL_SECONDS", 5, 1) *
      1_000,
  };
}

/**
 * A política opt-in de roteamento, como JSON numa variável.
 *
 * `AGENT_ROUTING_POLICY='{"primary":"openai-responses","fallback":"local"}'`: os ids são os
 * mesmos que a tarefa escolhe em `provider`, e precisam estar configurados — id desconhecido,
 * auto-referência a `routed` ou primário igual ao fallback recusam o boot em vez de rotear
 * para um candidato que não existe. Ausente é o modo fixo.
 */
function agentRoutingPolicy(
  environment: Environment,
  providers: AgentModelConfig[],
): AgentRoutingPolicy | undefined {
  const raw = optional(environment, "AGENT_ROUTING_POLICY");
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'AGENT_ROUTING_POLICY must be JSON like {"primary":"openai-responses","fallback":"local"}.',
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      'AGENT_ROUTING_POLICY must be JSON like {"primary":"openai-responses","fallback":"local"}.',
    );
  }
  const primary =
    "primary" in parsed && typeof parsed.primary === "string"
      ? parsed.primary.trim()
      : "";
  const fallbackRaw = "fallback" in parsed ? parsed.fallback : undefined;
  const fallback =
    typeof fallbackRaw === "string"
      ? fallbackRaw.trim()
      : fallbackRaw === undefined
        ? undefined
        : "";
  if (!primary) {
    throw new Error(
      'AGENT_ROUTING_POLICY needs a non-empty "primary" provider id.',
    );
  }
  if (fallbackRaw !== undefined && !fallback) {
    throw new Error(
      'AGENT_ROUTING_POLICY "fallback" must be a non-empty provider id.',
    );
  }
  for (const id of fallback ? [primary, fallback] : [primary]) {
    if (id === "routed") {
      throw new Error(
        'AGENT_ROUTING_POLICY candidates cannot be "routed" itself.',
      );
    }
    if (!providers.some((provider) => provider.id === id)) {
      throw new Error(
        `AGENT_ROUTING_POLICY points at "${id}", which is not configured. Configured: ${providers.map((provider) => provider.id).join(", ") || "none"}`,
      );
    }
  }
  if (fallback && fallback === primary) {
    throw new Error(
      'AGENT_ROUTING_POLICY "primary" and "fallback" must differ.',
    );
  }
  return fallback ? { primary, fallback } : { primary };
}

function agentRuntimeConfig(environment: Environment): AgentRuntimeConfig {
  const providers = agentModels(environment);
  const defaultProvider =
    optional(environment, "AGENT_DEFAULT_PROVIDER") ??
    providers[0]?.id ??
    "codex";
  if (
    optional(environment, "AGENT_DEFAULT_PROVIDER") &&
    !providers.some((provider) => provider.id === defaultProvider)
  ) {
    // Escolher explicitamente um provedor que não existe é erro de configuração, e o lugar de
    // descobrir isso é o boot: em execução, cada tarefa falharia por um motivo que ninguém lê.
    throw new Error(
      `AGENT_DEFAULT_PROVIDER aponta para ${defaultProvider}, que não está configurado. Configure-o (por exemplo com a credencial do provedor) ou remova a variável. Configurados: ${
        providers.map((provider) => provider.id).join(", ") || "nenhum"
      }`,
    );
  }
  const defaultModel =
    optional(environment, "AGENT_DEFAULT_MODEL") ??
    providers.find((provider) => provider.id === defaultProvider)?.model ??
    "default";
  const concurrency = wholeNumber(environment, "AGENT_CONCURRENCY", 1, 1);
  if (concurrency > 4) {
    throw new Error("AGENT_CONCURRENCY must be between 1 and 4");
  }
  const routingPolicy = agentRoutingPolicy(environment, providers);
  return {
    enabled: flag(environment, "AGENT_RUNTIME_ENABLED", true),
    workerEnabled: flag(environment, "AGENT_WORKER_ENABLED", true),
    pollMs: wholeNumber(environment, "AGENT_POLL_MS", 1_000, 100),
    concurrency,
    defaultProvider,
    defaultModel,
    providers,
    ...(routingPolicy ? { routingPolicy } : {}),
    leaseTtlMs: wholeNumber(environment, "AGENT_LEASE_TTL_MS", 60_000, 5_000),
    maxSteps: wholeNumber(environment, "AGENT_MAX_STEPS", 40, 1),
    maxRunMs: wholeNumber(environment, "AGENT_MAX_RUN_MS", 900_000, 10_000),
    maxCorrections: wholeNumber(environment, "AGENT_MAX_CORRECTIONS", 2, 0),
    artifactsDir:
      optional(environment, "AGENT_ARTIFACTS_DIR") ?? "./.artifacts",
    artifactRetentionDays: wholeNumber(
      environment,
      "AGENT_ARTIFACT_RETENTION_DAYS",
      7,
      0,
    ),
    sensitiveHosts: commaSeparated(environment, "AGENT_SENSITIVE_HOSTS").map(
      (host) => host.toLowerCase(),
    ),
    approvalTtlMs:
      wholeNumber(environment, "AGENT_APPROVAL_TTL_MINUTES", 30, 1) * 60_000,
    approvalPatterns: commaSeparated(environment, "AGENT_APPROVAL_PATTERNS"),
    waitingHumanMinutes: wholeNumber(
      environment,
      "AGENT_WAITING_HUMAN_MINUTES",
      15,
      1,
    ),
    idleBrowserMinutes: wholeNumber(
      environment,
      "AGENT_IDLE_BROWSER_MINUTES",
      10,
      1,
    ),
  };
}

/**
 * O que este deployment aceita registrar como servidor MCP, além do catálogo revisado.
 *
 * `PLUGINS_ALLOW_PRIVATE_MCP` é a decisão do administrador de apontar o deployment para uma API
 * própria, que quase sempre mora na rede interna e fala http em vez de https. Ela não é uma
 * permissão de Bot nem de tarefa: vale para o registro, e o que ela abre é o servidor passar a
 * fazer requisição para onde for apontado, com o token do cofre no cabeçalho. Desligada por padrão,
 * e cada servidor registrado por essa porta diz na auditoria que veio por ela.
 *
 * O endereço de credencial de nuvem continua fora mesmo com o interruptor ligado — a regra está em
 * `plugins/catalogue.ts`, junto das outras do formato da URL.
 */
function pluginsConfig(environment: Environment): PluginsConfig {
  return {
    allowPrivateMcp:
      optional(environment, "PLUGINS_ALLOW_PRIVATE_MCP") === "true",
  };
}

export function loadConfig(
  environment: Environment = process.env,
): DeploymentConfig {
  const google = oauthClient(environment, "GOOGLE");
  const auth = authConfig(environment, google);
  const telegram = telegramConfig(environment);

  return {
    databaseUrl: required(environment, "DATABASE_URL"),
    keyEncryptionKey: keyEncryptionKey(environment),
    managedAgentAgUiUrl: requiredHttpUrl(
      environment,
      "MANAGED_AGENT_AG_UI_URL",
    ),
    managedAgentToken: required(environment, "MANAGED_AGENT_TOKEN"),
    deploymentId: optional(environment, "DEPLOYMENT_ID"),
    tenantPackageDirectory:
      optional(environment, "TENANT_PACKAGE_DIR") ?? "../examples/fintech",
    runtime: runtimeCapabilities(environment),
    agentStallTimeoutMs: agentStallTimeoutMs(environment),
    oauth: { google },
    auth,
    singleUser: singleUserEnabled(
      environment,
      configuredAuthProviders(auth).length > 0,
    ),
    accessibility: accessibilityEnabled(environment),
    ...(optional(environment, "APP_DIST_DIR")
      ? { appDistDir: optional(environment, "APP_DIST_DIR") as string }
      : {}),
    computer: computerConfig(environment),
    agentRuntime: agentRuntimeConfig(environment),
    ...(optional(environment, "AGENT_TOOL_TOKEN")
      ? { agentToolToken: optional(environment, "AGENT_TOOL_TOKEN") as string }
      : {}),
    ...(telegram ? { telegram } : {}),
    plugins: pluginsConfig(environment),
  };
}
