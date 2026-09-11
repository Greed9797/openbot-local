/**
 * A ferramenta, do ponto de vista de quem a chama.
 *
 * O que o teste fixa é a tradução: uma recusa de política continua recusa, um ref vencido vira
 * "tire outro snapshot", uma pessoa no volante não vira repetição infinita, e uma ação que pode ter
 * acontecido sem confirmação para a tarefa em vez de ser repetida. É a diferença entre um agente que
 * erra uma vez e um que envia o formulário três vezes.
 *
 * O gateway é um dublê: o que está sendo testado é esta camada, e a política tem a suíte dela.
 */
import { describe, expect, test } from "bun:test";
import {
  ActionRefusedError,
  type ComputerGateway,
  ComputerUnavailableError,
  ElementNotFoundError,
  HumanHasControlError,
  StaleSnapshotError,
} from "../src/computer/gateway";
import { createBrowserTools } from "../src/agent-runtime/browser-tools";
import type { ToolCallContext } from "../src/agent-runtime/contracts";

const context: ToolCallContext = {
  runId: "run-1",
  botId: "bot-1",
  stepSeq: 3,
  actor: { id: "pessoa-1", userId: "pessoa-1" },
  signal: new AbortController().signal,
};

function toolsWith(gateway: Partial<ComputerGateway>) {
  return createBrowserTools({ gateway: gateway as ComputerGateway });
}

describe("browser tools", () => {
  test("o catálogo oferece o que o PRD pede e nada de shell ou JavaScript", () => {
    const tools = toolsWith({});
    const names = tools.definitions().map((definition) => definition.name);
    expect(names).toEqual([
      "navigate",
      "read_page",
      "snapshot_page",
      "click",
      "type_text",
      "press_key",
      "scroll",
      "select_option",
      "screenshot",
      "wait_for",
      "request_help",
    ]);
    for (const forbidden of ["exec", "shell", "evaluate", "javascript"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  test("cada ferramenta declara os argumentos que o validador vai cobrar", () => {
    const tools = toolsWith({});
    for (const definition of tools.definitions()) {
      expect(definition.description.length).toBeGreaterThan(20);
      expect(definition.parameters.type).toBe("object");
    }
    const click = tools
      .definitions()
      .find((definition) => definition.name === "click");
    expect(click?.parameters.required).toEqual(["ref", "snapshotId"]);
  });

  test("uma recusa de política chega como recusa, com a regra", async () => {
    const tools = toolsWith({
      click: () => {
        throw new ActionRefusedError("Publicar exige aprovação.", "deny[2]");
      },
    });
    const outcome = await tools.execute(
      { name: "click", arguments: { ref: "e3", snapshotId: 7 } },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.refused).toEqual({
      rule: "deny[2]",
      reason: "Publicar exige aprovação.",
    });
  });

  test("um ref vencido pede outro snapshot em vez de virar erro", async () => {
    const tools = toolsWith({
      click: () => {
        throw new StaleSnapshotError("A página mudou.");
      },
    });
    const outcome = await tools.execute(
      { name: "click", arguments: { ref: "e3", snapshotId: 7 } },
      context,
    );
    expect(outcome.stale).toBe(true);
    expect(outcome.error?.code).toBe("STALE_SNAPSHOT");
    expect(outcome.refused).toBeUndefined();
  });

  test("um elemento que sumiu também", async () => {
    const tools = toolsWith({
      type: () => {
        throw new ElementNotFoundError("Element e9 is not on the page any more.");
      },
    });
    const outcome = await tools.execute(
      {
        name: "type_text",
        arguments: { ref: "e9", snapshotId: 2, text: "Produto" },
      },
      context,
    );
    expect(outcome.stale).toBe(true);
    expect(outcome.error?.code).toBe("ELEMENT_NOT_FOUND");
  });

  test("uma pessoa no volante tem código próprio, para a tarefa parar e esperar", async () => {
    const tools = toolsWith({
      click: () => {
        throw new HumanHasControlError(
          "A person has control of the computer right now.",
        );
      },
    });
    const outcome = await tools.execute(
      { name: "click", arguments: { ref: "e1", snapshotId: 1 } },
      context,
    );
    expect(outcome.error?.code).toBe("HUMAN_CONTROL");
    expect(outcome.uncertain).toBeUndefined();
  });

  test("uma ação enviada sem confirmação é incerta, nunca repetível", async () => {
    const tools = toolsWith({
      click: () => {
        throw new ComputerUnavailableError(
          "The assistant's computer did not respond in time.",
        );
      },
    });
    const outcome = await tools.execute(
      { name: "click", arguments: { ref: "e1", snapshotId: 1 } },
      context,
    );
    expect(outcome.uncertain).toBe(true);
    expect(outcome.error?.code).toBe("EFFECT_UNCERTAIN");
  });

  test("uma leitura que falhou é só uma leitura que falhou", async () => {
    const tools = toolsWith({
      read: () => {
        throw new ComputerUnavailableError("O computador não respondeu em 45s.");
      },
    });
    const outcome = await tools.execute({ name: "read_page", arguments: {} }, context);
    expect(outcome.uncertain).toBeUndefined();
    expect(outcome.error?.code).toBe("COMPUTER_UNAVAILABLE");
  });

  test("durante um segredo, olhar a tela é recusado com o motivo", async () => {
    const tools = toolsWith({
      control: async () =>
        ({
          holder: "human",
          since: new Date().toISOString(),
          requested: false,
          secretWanted: "a senha do banco",
        }) as Awaited<ReturnType<ComputerGateway["control"]>>,
    });
    const outcome = await tools.execute({ name: "screenshot", arguments: {} }, context);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("SECRET_PENDING");
  });

  test("pedir para olhar não captura agora: a imagem vem na observação seguinte", async () => {
    let captured = 0;
    const tools = toolsWith({
      control: async () =>
        ({
          holder: "bot",
          since: new Date().toISOString(),
          requested: false,
        }) as Awaited<ReturnType<ComputerGateway["control"]>>,
      screenshot: async () => {
        captured += 1;
        return {
          base64: "AAAA",
          width: 1,
          height: 1,
          capturedAt: new Date().toISOString(),
        };
      },
    });
    const outcome = await tools.execute({ name: "screenshot", arguments: {} }, context);
    expect(outcome.ok).toBe(true);
    expect(captured).toBe(0);
  });

  test("pedir ajuda para a tarefa e devolve o motivo", async () => {
    const tools = toolsWith({
      requestHelp: async () =>
        ({
          holder: "bot",
          since: new Date().toISOString(),
          requested: true,
          reason: "Há um CAPTCHA",
        }) as Awaited<ReturnType<ComputerGateway["requestHelp"]>>,
    });
    const outcome = await tools.execute(
      { name: "request_help", arguments: { reason: "Há um CAPTCHA" } },
      context,
    );
    expect(outcome.help?.reason).toBe("Há um CAPTCHA");
  });

  test("uma ferramenta que não existe não é executada", async () => {
    const tools = toolsWith({});
    const outcome = await tools.execute(
      { name: "shell", arguments: { command: "rm -rf /" } },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("UNKNOWN_TOOL");
  });

  test("um argumento faltando é resposta inválida do modelo, não falha do computador", async () => {
    const tools = toolsWith({});
    const outcome = await tools.execute(
      { name: "click", arguments: { ref: "e1" } },
      context,
    );
    expect(outcome.error?.code).toBe("INVALID_ARGUMENTS");
  });

  test("o texto digitado nunca volta no resultado", async () => {
    const tools = toolsWith({
      type: async () => ({
        action: "type",
        ref: "e2",
        characters: 9,
        submitted: false,
        url: "https://exemplo.test/",
        elapsedMs: 120,
      }),
    });
    const outcome = await tools.execute(
      {
        name: "type_text",
        arguments: { ref: "e2", snapshotId: 4, text: "segredo123" },
      },
      context,
    );
    expect(JSON.stringify(outcome.result)).not.toContain("segredo123");
    expect(JSON.stringify(outcome.result)).toContain("https://exemplo.test/");
  });

  test("o scroll vai como ação governada, sem deltaY inventado", async () => {
    const seen: unknown[] = [];
    const tools = toolsWith({
      scroll: async (botId, actor, input) => {
        seen.push({ botId, actor, input });
        return {
          action: "scroll",
          deltaY: 600,
          url: "https://exemplo.test/",
          elapsedMs: 30,
        };
      },
    });
    await tools.execute({ name: "scroll", arguments: {} }, context);
    await tools.execute({ name: "scroll", arguments: { deltaY: 200 } }, context);
    expect(seen).toEqual([
      {
        botId: "bot-1",
        actor: { id: "pessoa-1", userId: "pessoa-1", runId: "run-1" },
        input: {},
      },
      {
        botId: "bot-1",
        actor: { id: "pessoa-1", userId: "pessoa-1", runId: "run-1" },
        input: { deltaY: 200 },
      },
    ]);
  });

  test("toda ação leva a tarefa e o passo original para a trilha de auditoria", async () => {
    let actorSeen: unknown;
    const tools = toolsWith({
      click: async (_botId, actor) => {
        actorSeen = actor;
        return {
          action: "click",
          url: "https://exemplo.test/",
          elapsedMs: 10,
        };
      },
    });
    await tools.execute(
      { name: "click", arguments: { ref: "e1", snapshotId: 1 } },
      context,
    );
    expect(actorSeen).toEqual({
      id: "pessoa-1",
      userId: "pessoa-1",
      runId: "run-1",
    });
  });

  test("uma tarefa interrompida não continua executando", async () => {
    const controller = new AbortController();
    controller.abort();
    const tools = toolsWith({
      read: async () => {
        throw new Error("não deveria ser chamado");
      },
    });
    const outcome = await tools.execute({ name: "read_page", arguments: {} }, {
      ...context,
      signal: controller.signal,
    });
    // A chamada ainda acontece (o gateway é quem aborta), mas um erro com o sinal abortado é
    // reportado como interrupção, que é o que impede o loop de tratar como falha da ferramenta.
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("STOPPED");
  });
});
