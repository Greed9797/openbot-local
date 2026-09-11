/**
 * O catálogo de modelos: o que a operação confere no deploy, e o que o runtime realmente alcança.
 *
 * A pergunta que este arquivo prende é a que se faz depois de subir um serviço novo: "o motor que eu
 * configurei chegou ao runtime?". Ela não pode ser decorativa. O catálogo é a interseção entre o que o
 * ambiente declarou e o que foi construído — anunciar um modelo que a primeira tarefa não alcança é
 * pior do que não anunciar nenhum —, e `AGENT_OPENCODE_VISION=off` tem de chegar ao provedor, não só
 * ao `.env`: com visão presumida, todo passo pede captura a um modelo que não lê imagem.
 *
 * O caminho exercitado é o do boot (ambiente → config → registro → catálogo), não um objeto montado à
 * mão, porque o defeito que se quer pegar mora exatamente entre essas peças.
 */
import { describe, expect, test } from "bun:test";
import { buildModelCatalog } from "../src/agent-runtime/model-catalog";
import { createConfiguredProviders } from "../src/agent-runtime/providers";
import { createProviderRegistry } from "../src/agent-runtime/registry";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/** O ambiente de um deployment que acabou de ligar um CLI de agente como motor. */
function environmentWithCli(overrides: Record<string, string> = {}) {
  return testEnvironment({
    AGENT_CLI: "opencode",
    AGENT_OPENCODE_URL: "http://agent-cli:4210/ag-ui",
    AGENT_OPENCODE_MODEL: "opencode-go/deepseek-v4.1-flash",
    ...overrides,
  });
}

/** O catálogo como o boot o monta: o ambiente entra, a lista sai. */
function catalogFor(environment: Record<string, string | undefined>) {
  const config = loadConfig(environment);
  const providers = createProviderRegistry(
    createConfiguredProviders(config.agentRuntime.providers),
  );
  return {
    config,
    providers,
    catalog: buildModelCatalog({
      providers,
      configurations: config.agentRuntime.providers,
      defaultProvider: config.agentRuntime.defaultProvider,
    }),
  };
}

describe("o catálogo de modelos", () => {
  test("o CLI de agente configurado aparece com o modelo dele e o ciclo delegado", () => {
    const { catalog } = catalogFor(environmentWithCli());
    const opencode = catalog.models.find((entry) => entry.id === "opencode");

    expect(opencode).toEqual({
      id: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
      transport: "delegated",
      capabilities: {
        vision: true,
        // O runtime não entrega catálogo de ferramentas a quem conduz o próprio ciclo.
        tools: false,
        streaming: true,
        mode: "delegated",
      },
      default: false,
    });
  });

  test("escolhido como padrão, o CLI é quem conduz a tarefa sem escolha", () => {
    const { catalog } = catalogFor(
      environmentWithCli({ AGENT_DEFAULT_PROVIDER: "opencode" }),
    );

    expect(catalog.default).toBe("opencode");
    expect(catalog.models.filter((entry) => entry.default)).toEqual([
      expect.objectContaining({ id: "opencode" }),
    ]);
  });

  test("AGENT_OPENCODE_VISION=off chega ao provedor, e não só ao .env", () => {
    // O caso real: o CLI roda um modelo de texto. Com a visão presumida pelo adaptador, cada passo
    // pediria captura de tela a um modelo que não lê imagem — e a análise de tela escolheria esse
    // provedor, porque `analyze-image` pega o primeiro que diz enxergar.
    const { catalog } = catalogFor(
      environmentWithCli({ AGENT_OPENCODE_VISION: "off" }),
    );

    expect(
      catalog.models.find((entry) => entry.id === "opencode")?.capabilities
        .vision,
    ).toBe(false);
    // O que não foi negado continua presumido: o Codex segue com visão.
    expect(
      catalog.models.find((entry) => entry.id === "codex")?.capabilities.vision,
    ).toBe(true);
  });

  test("provedor que não foi construído não entra na lista", () => {
    // Sem credencial o adaptador nem existe (`createProviderFor` devolve `undefined`), e a tarefa que
    // escolhesse esse id falharia com PROVIDER_UNAVAILABLE. A lista é do que dá para rotear.
    const config = loadConfig(testEnvironment());
    const providers = createProviderRegistry(
      createConfiguredProviders([
        ...config.agentRuntime.providers,
        {
          id: "gemini",
          transport: "gemini",
          model: "gemini-3.8-flash",
          vision: true,
          tools: true,
        },
      ]),
    );
    const catalog = buildModelCatalog({
      providers,
      configurations: [
        ...config.agentRuntime.providers,
        {
          id: "gemini",
          transport: "gemini",
          model: "gemini-3.8-flash",
          vision: true,
          tools: true,
        },
      ],
      defaultProvider: config.agentRuntime.defaultProvider,
    });

    expect(catalog.models.some((entry) => entry.id === "gemini")).toBe(false);
    expect(catalog.models.length).toBeGreaterThan(0);
  });

  test("a resposta não carrega credencial nem endereço", () => {
    // `baseUrl` pode ter usuário e senha embutidos (`https://user:senha@host/v1`), e a chave de um
    // fornecedor não tem o que fazer numa leitura. A projeção é campo a campo por isso.
    const config = loadConfig(
      testEnvironment({
        AGENT_OPENCODE_URL:
          "https://usuario:segredo@agent-cli.interno:4210/ag-ui",
        MANAGED_AGENT_TOKEN: "token-do-deployment",
      }),
    );
    const providers = createProviderRegistry(
      createConfiguredProviders(config.agentRuntime.providers),
    );
    const catalog = buildModelCatalog({
      providers,
      configurations: config.agentRuntime.providers,
      defaultProvider: config.agentRuntime.defaultProvider,
    });
    const serialised = JSON.stringify(catalog);

    expect(serialised).not.toContain("segredo");
    expect(serialised).not.toContain("usuario");
    expect(serialised).not.toContain("agent-cli.interno");
    expect(serialised).not.toContain("token-do-deployment");
  });
});

describe("a rota /api/models", () => {
  const actor = {
    id: "user-1",
    email: "member@openbot.test",
    role: "user",
  } as const;

  const catalog = { default: "opencode", models: [] };

  /**
   * `createApp` recebe seus serviços por posição, e o catálogo é o último.
   *
   * Posições 4–24: auditReader, credentialService, packageStatusReader, connectorService,
   * copilotHandler, computerGateway, computerPolicy, agentProfileStore, channelStore, channelEvents,
   * auditStore, componentStore, pluginStore, sandboxedStore, threadIdentity, peopleStore,
   * identityProviders, knowledgeSearch, agentRunService, agentVision, telegramStore.
   */
  function appWith(session: unknown) {
    return createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: async () => session },
      },
      { rolesForUser: async () => ["user"] },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      catalog,
    );
  }

  test("exige sessão: quem pergunta o que existe aqui já está dentro", async () => {
    const response = await appWith(null).request(
      "http://openbot.test/api/models",
    );

    expect(response.status).toBe(401);
  });

  test("responde a lista para quem está dentro", async () => {
    const response = await appWith({
      user: {
        id: actor.id,
        email: actor.email,
        name: "OpenBot Member",
        image: "https://example.test/member.png",
      },
    }).request("http://openbot.test/api/models");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
  });

  test("não existe sem runtime: um deployment sem tarefas não descreve modelos", async () => {
    const response = await createApp(loadConfig(testEnvironment())).request(
      "http://openbot.test/api/models",
    );

    expect(response.status).toBe(404);
  });
});
