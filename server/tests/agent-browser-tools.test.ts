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
import { createBrowserTools } from "../src/agent-runtime/browser-tools";
import type { ToolCallContext } from "../src/agent-runtime/contracts";
import {
  ActionRefusedError,
  type ComputerGateway,
  ComputerUnavailableError,
  ElementNotFoundError,
  HumanHasControlError,
  StaleSnapshotError,
} from "../src/computer/gateway";

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
      "fetch_page",
      "read_page",
      "snapshot_page",
      "click",
      "type_text",
      "press_key",
      "scroll",
      "select_option",
      "screenshot",
      "telemetry",
      "audit",
      "audit_focus",
      "set_viewport",
      "wait_for",
      "request_help",
      "read_form",
      "plan_form",
      "fill_form",
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

  test("ler e planejar um formulário não toca no navegador além do snapshot", async () => {
    const snapshots = { calls: 0 };
    const tools = toolsWith({
      snapshot: async () => {
        snapshots.calls += 1;
        return {
          snapshotId: 12,
          url: "https://loja.test/produtos/novo",
          title: "Novo produto",
          truncated: false,
          viewport: { width: 1280, height: 800 },
          elements: [
            { ref: "e1", role: "textbox", name: "Nome do produto" },
            { ref: "e2", role: "textbox", name: "Preço *" },
            { ref: "e3", role: "combobox", name: "Categoria" },
            { ref: "e4", role: "option", name: "Eletrônicos" },
            { ref: "e5", role: "button", name: "Salvar" },
          ],
        };
      },
    });

    const read = await tools.execute(
      { name: "read_form", arguments: {} },
      context,
    );
    expect(read.ok).toBe(true);
    const readResult = read.result as {
      snapshotId: number;
      fields: { ref: string; label: string; kind: string; required: boolean }[];
      required: string[];
      buttons: { ref: string; label: string }[];
    };
    expect(readResult.snapshotId).toBe(12);
    expect(readResult.fields.map((field) => field.ref)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(
      readResult.fields.find((field) => field.ref === "e3")?.options,
    ).toEqual(["Eletrônicos"]);
    expect(readResult.required).toEqual(["e2"]);
    expect(readResult.buttons).toEqual([
      { ref: "e5", label: "Salvar", role: "button" },
    ]);

    const plan = await tools.execute(
      {
        name: "plan_form",
        arguments: {
          values: [
            { label: "Nome do produto", value: "Caderno" },
            { label: "Preço", value: "29.90" },
            { label: "Fornecedor", value: "ACME" },
          ],
        },
      },
      context,
    );
    expect(plan.ok).toBe(true);
    const planResult = plan.result as {
      snapshotId: number;
      assignments: { ref: string; how: string; value: string }[];
      unknown: string[];
    };
    expect(planResult.snapshotId).toBe(12);
    expect(planResult.assignments).toEqual([
      {
        ref: "e1",
        label: "Nome do produto",
        kind: "text",
        how: "fill",
        value: "Caderno",
      },
      {
        ref: "e2",
        label: "Preço *",
        kind: "text",
        how: "fill",
        value: "29.90",
      },
    ]);
    expect(planResult.unknown).toEqual(["Fornecedor"]);
    // Duas leituras, dois snapshots: são ações diferentes, e o modelo recebe o id de cada uma.
    expect(snapshots.calls).toBe(2);
  });

  test("plan_form sem valores é resposta inválida, não um plano vazio", async () => {
    const tools = toolsWith({
      snapshot: async () => {
        throw new Error("não deveria chegar ao navegador");
      },
    });
    const outcome = await tools.execute(
      { name: "plan_form", arguments: {} },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("INVALID_ARGUMENTS");
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
        throw new ElementNotFoundError(
          "Element e9 is not on the page any more.",
        );
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
        throw new ComputerUnavailableError(
          "O computador não respondeu em 45s.",
        );
      },
    });
    const outcome = await tools.execute(
      { name: "read_page", arguments: {} },
      context,
    );
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
    const outcome = await tools.execute(
      { name: "screenshot", arguments: {} },
      context,
    );
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
    const outcome = await tools.execute(
      { name: "screenshot", arguments: {} },
      context,
    );
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
    await tools.execute(
      { name: "scroll", arguments: { deltaY: 200 } },
      context,
    );
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
    const outcome = await tools.execute(
      { name: "read_page", arguments: {} },
      {
        ...context,
        signal: controller.signal,
      },
    );
    // A chamada ainda acontece (o gateway é quem aborta), mas um erro com o sinal abortado é
    // reportado como interrupção, que é o que impede o loop de tratar como falha da ferramenta.
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("STOPPED");
  });

  test("fill_form preenche vários campos estáveis numa execução, sem devolver valores", async () => {
    const typed: { ref: string; snapshotId: number; text: string }[] = [];
    const selected: { ref: string; snapshotId: number; value: string }[] = [];
    let snapshots = 0;
    const tools = toolsWith({
      snapshot: async () => {
        snapshots += 1;
        return {
          snapshotId: snapshots,
          url: "https://loja.test/produtos/novo",
          title: "Novo produto",
          truncated: false,
          viewport: { width: 1280, height: 800 },
          elements: [
            { ref: "e1", role: "textbox", name: "Nome do produto" },
            { ref: "e2", role: "textbox", name: "Preço *" },
            { ref: "e3", role: "combobox", name: "Categoria" },
            { ref: "e4", role: "option", name: "Eletrônicos" },
          ],
        };
      },
      type: async (_botId, _actor, input) => {
        typed.push({
          ref: input.ref,
          snapshotId: input.snapshotId,
          text: input.text,
        });
        return {
          action: "type",
          ref: input.ref,
          characters: input.text.length,
          url: "https://loja.test/produtos/novo",
          elapsedMs: 40,
        };
      },
      select: async (_botId, _actor, input) => {
        selected.push({
          ref: input.ref,
          snapshotId: input.snapshotId,
          value: input.value,
        });
        return {
          action: "select",
          ref: input.ref,
          url: "https://loja.test/produtos/novo",
          elapsedMs: 30,
        };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: {
          values: [
            { label: "Nome do produto", value: "Caderno sigiloso" },
            { label: "Preço", value: "29.90" },
            { label: "Categoria", value: "Eletrônicos" },
          ],
        },
      },
      context,
    );
    expect(outcome.ok).toBe(true);
    const result = outcome.result as {
      snapshotId: number;
      filled: { label: string; ref: string }[];
      pending: string[];
      unknown: string[];
    };
    expect(result.filled).toEqual([
      { label: "Nome do produto", ref: "e1" },
      { label: "Preço *", ref: "e2" },
      { label: "Categoria", ref: "e3" },
    ]);
    expect(result.pending).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.snapshotId).toBe(3);
    // Cada campo usa a geração atual: nada de ref de snapshot antigo.
    expect(typed.map((call) => call.snapshotId)).toEqual([1, 2]);
    expect(selected.map((call) => call.snapshotId)).toEqual([3]);
    expect(snapshots).toBe(3);
    // Nenhum valor digitado volta na resposta.
    expect(JSON.stringify(outcome)).not.toContain("Caderno sigiloso");
    expect(JSON.stringify(outcome)).not.toContain("29.90");
  });

  test("fill_form para quando um re-render tira um campo do ar", async () => {
    const typed: string[] = [];
    let snapshots = 0;
    const tools = toolsWith({
      snapshot: async () => {
        snapshots += 1;
        const full = snapshots === 1;
        return {
          snapshotId: snapshots,
          url: "https://loja.test/produtos/novo",
          title: "Novo produto",
          truncated: false,
          viewport: { width: 1280, height: 800 },
          elements: full
            ? [
                { ref: "e1", role: "textbox", name: "Nome do produto" },
                { ref: "e2", role: "textbox", name: "Preço *" },
              ]
            : [{ ref: "e1", role: "textbox", name: "Nome do produto" }],
        };
      },
      type: async (_botId, _actor, input) => {
        typed.push(input.ref);
        return {
          action: "type",
          ref: input.ref,
          characters: 7,
          url: "https://loja.test/produtos/novo",
          elapsedMs: 40,
        };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: {
          values: [
            { label: "Nome do produto", value: "Caderno" },
            { label: "Preço", value: "29.90" },
          ],
        },
      },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.stale).toBe(true);
    expect(outcome.error?.code).toBe("STALE_SNAPSHOT");
    const result = outcome.result as {
      filled: { label: string }[];
      pending: string[];
    };
    expect(result.filled.map((field) => field.label)).toEqual([
      "Nome do produto",
    ]);
    expect(result.pending).toEqual(["Preço *"]);
    expect(typed).toEqual(["e1"]);
    expect(JSON.stringify(outcome)).not.toContain("29.90");
  });

  test("fill_form devolve a falha parcial exata e não tenta o resto", async () => {
    const typed: string[] = [];
    let selected = 0;
    let snapshots = 0;
    const tools = toolsWith({
      snapshot: async () => {
        snapshots += 1;
        return {
          snapshotId: snapshots,
          url: "https://loja.test/produtos/novo",
          title: "Novo produto",
          truncated: false,
          viewport: { width: 1280, height: 800 },
          elements: [
            { ref: "e1", role: "textbox", name: "Nome do produto" },
            { ref: "e2", role: "textbox", name: "Preço *" },
            { ref: "e3", role: "combobox", name: "Categoria" },
            { ref: "e4", role: "option", name: "Eletrônicos" },
          ],
        };
      },
      type: async (_botId, _actor, input) => {
        typed.push(input.ref);
        if (input.ref === "e2") {
          throw new ElementNotFoundError(
            "Element e2 is not on the page any more.",
          );
        }
        return {
          action: "type",
          ref: input.ref,
          characters: 7,
          url: "https://loja.test/produtos/novo",
          elapsedMs: 40,
        };
      },
      select: async () => {
        selected += 1;
        return {
          action: "select",
          url: "https://loja.test/produtos/novo",
          elapsedMs: 30,
        };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: {
          values: [
            { label: "Nome do produto", value: "Caderno" },
            { label: "Preço", value: "29.90" },
            { label: "Categoria", value: "Eletrônicos" },
          ],
        },
      },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.stale).toBe(true);
    expect(outcome.error?.code).toBe("ELEMENT_NOT_FOUND");
    const result = outcome.result as {
      filled: { label: string }[];
      pending: string[];
    };
    expect(result.filled.map((field) => field.label)).toEqual([
      "Nome do produto",
    ]);
    expect(result.pending).toEqual(["Preço *", "Categoria"]);
    expect(typed).toEqual(["e1", "e2"]);
    expect(selected).toBe(0);
  });

  test("fill_form interrompe antes do próximo campo quando a pessoa assume o controle", async () => {
    const typed: string[] = [];
    let snapshots = 0;
    const tools = toolsWith({
      snapshot: async () => {
        snapshots += 1;
        return {
          snapshotId: snapshots,
          url: "https://loja.test/checkout",
          title: "Checkout",
          truncated: false,
          viewport: { width: 1280, height: 800 },
          elements: [
            { ref: "e1", role: "textbox", name: "Nome do produto" },
            { ref: "e2", role: "textbox", name: "Preço *" },
          ],
        };
      },
      type: async (_botId, _actor, input) => {
        typed.push(input.ref);
        if (input.ref === "e2") {
          throw new HumanHasControlError(
            "A person has control of the computer right now.",
          );
        }
        return {
          action: "type",
          ref: input.ref,
          characters: 7,
          url: "https://loja.test/checkout",
          elapsedMs: 40,
        };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: {
          values: [
            { label: "Nome do produto", value: "Caderno" },
            { label: "Preço", value: "29.90" },
          ],
        },
      },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("HUMAN_CONTROL");
    expect(outcome.uncertain).toBeUndefined();
    const result = outcome.result as {
      filled: { label: string }[];
      pending: string[];
    };
    expect(result.filled.map((field) => field.label)).toEqual([
      "Nome do produto",
    ]);
    expect(result.pending).toEqual(["Preço *"]);
    expect(typed).toEqual(["e1", "e2"]);
  });

  test("fill_form nunca envia nem aperta Enter: só digita e seleciona", async () => {
    const typeInputs: Record<string, unknown>[] = [];
    let keys = 0;
    let clicks = 0;
    let snapshots = 0;
    const tools = toolsWith({
      snapshot: async () => {
        snapshots += 1;
        return {
          snapshotId: snapshots,
          url: "https://loja.test/produtos/novo",
          title: "Novo produto",
          truncated: false,
          viewport: { width: 1280, height: 800 },
          elements: [
            { ref: "e1", role: "textbox", name: "Nome do produto" },
            { ref: "e2", role: "textbox", name: "Preço *" },
          ],
        };
      },
      type: async (_botId, _actor, input) => {
        typeInputs.push({ ...input });
        return {
          action: "type",
          ref: input.ref,
          characters: 7,
          url: "https://loja.test/produtos/novo",
          elapsedMs: 40,
        };
      },
      key: async () => {
        keys += 1;
        return {
          action: "key",
          url: "https://loja.test/produtos/novo",
          elapsedMs: 10,
        };
      },
      click: async () => {
        clicks += 1;
        return {
          action: "click",
          url: "https://loja.test/produtos/novo",
          elapsedMs: 10,
        };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: {
          values: [
            { label: "Nome do produto", value: "Caderno" },
            { label: "Preço", value: "29.90" },
          ],
        },
      },
      context,
    );
    expect(outcome.ok).toBe(true);
    expect(snapshots).toBe(2);
    expect(keys).toBe(0);
    expect(clicks).toBe(0);
    expect(typeInputs).toHaveLength(2);
    for (const input of typeInputs) {
      expect("submit" in input).toBe(false);
    }
  });

  test("fill_form respeita recusa de política com o parcial do que já andou", async () => {
    const typed: string[] = [];
    let snapshots = 0;
    const tools = toolsWith({
      snapshot: async () => {
        snapshots += 1;
        return {
          snapshotId: snapshots,
          url: "https://loja.test/produtos/novo",
          title: "Novo produto",
          truncated: false,
          viewport: { width: 1280, height: 800 },
          elements: [
            { ref: "e1", role: "textbox", name: "Nome do produto" },
            { ref: "e2", role: "textbox", name: "Preço *" },
          ],
        };
      },
      type: async (_botId, _actor, input) => {
        typed.push(input.ref);
        if (input.ref === "e2") {
          throw new ActionRefusedError("Publicar exige aprovação.", "deny[2]");
        }
        return {
          action: "type",
          ref: input.ref,
          characters: 7,
          url: "https://loja.test/produtos/novo",
          elapsedMs: 40,
        };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: {
          values: [
            { label: "Nome do produto", value: "Caderno" },
            { label: "Preço", value: "29.90" },
          ],
        },
      },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.refused).toEqual({
      rule: "deny[2]",
      reason: "Publicar exige aprovação.",
    });
    const result = outcome.result as {
      filled: { label: string }[];
      pending: string[];
    };
    expect(result.filled.map((field) => field.label)).toEqual([
      "Nome do produto",
    ]);
    expect(result.pending).toEqual(["Preço *"]);
  });

  test("fill_form sem par válido é resposta inválida, não um preenchimento vazio", async () => {
    const tools = toolsWith({
      snapshot: async () => ({
        snapshotId: 1,
        url: "https://loja.test/produtos/novo",
        title: "Novo produto",
        truncated: false,
        viewport: { width: 1280, height: 800 },
        elements: [{ ref: "e1", role: "textbox", name: "Nome do produto" }],
      }),
      type: async () => {
        throw new Error("não deveria preencher sem campo casado");
      },
    });
    const empty = await tools.execute(
      { name: "fill_form", arguments: {} },
      context,
    );
    expect(empty.ok).toBe(false);
    expect(empty.error?.code).toBe("INVALID_ARGUMENTS");
    const noPairs = await tools.execute(
      { name: "fill_form", arguments: { values: [] } },
      context,
    );
    expect(noPairs.ok).toBe(false);
    expect(noPairs.error?.code).toBe("INVALID_ARGUMENTS");
    const unknown = await tools.execute(
      {
        name: "fill_form",
        arguments: { values: [{ label: "Fornecedor", value: "ACME" }] },
      },
      context,
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("INVALID_ARGUMENTS");
  });

  test("fill_form não finge preencher caixa de seleção: para com o parcial", async () => {
    let typed = 0;
    let selected = 0;
    const tools = toolsWith({
      snapshot: async () => ({
        snapshotId: 1,
        url: "https://loja.test/produtos/novo",
        title: "Novo produto",
        truncated: false,
        viewport: { width: 1280, height: 800 },
        elements: [{ ref: "e9", role: "checkbox", name: "Aceito os termos" }],
      }),
      type: async () => {
        typed += 1;
        return {
          action: "type",
          url: "https://loja.test/produtos/novo",
          elapsedMs: 10,
        };
      },
      select: async () => {
        selected += 1;
        return {
          action: "select",
          url: "https://loja.test/produtos/novo",
          elapsedMs: 10,
        };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: { values: [{ label: "Aceito os termos", value: "true" }] },
      },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("FIELD_NOT_SUPPORTED");
    const result = outcome.result as { filled: unknown[]; pending: string[] };
    expect(result.filled).toEqual([]);
    expect(result.pending).toEqual(["Aceito os termos"]);
    expect(typed).toBe(0);
    expect(selected).toBe(0);
  });
  test("fetch_page lê pelo motor sem pixels sem abrir sessão, com a tarefa na trilha", async () => {
    const seen: { botId: string; actor: unknown; url: string }[] = [];
    const tools = toolsWith({
      fetch: async (botId, actor, url) => {
        seen.push({ botId, actor, url });
        return {
          url,
          title: "Preços",
          text: "Caderno: 29.90",
          links: [{ text: "Comprar", href: "https://loja.test/comprar" }],
        };
      },
    });
    const outcome = await tools.execute(
      { name: "fetch_page", arguments: { url: "https://loja.test/precos" } },
      context,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      url: "https://loja.test/precos",
      title: "Preços",
    });
    expect(seen).toEqual([
      {
        botId: "bot-1",
        actor: { id: "pessoa-1", userId: "pessoa-1", runId: "run-1" },
        url: "https://loja.test/precos",
      },
    ]);
  });

  test("fetch_page sem url é resposta inválida, sem tocar no gateway", async () => {
    const tools = toolsWith({
      fetch: async () => {
        throw new Error("não deveria buscar sem endereço");
      },
    });
    const outcome = await tools.execute(
      { name: "fetch_page", arguments: {} },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("INVALID_ARGUMENTS");
  });

  test("fetch_page recusado pela política é terminal e não oferece Chromium", async () => {
    let navigations = 0;
    const tools = toolsWith({
      fetch: async () => {
        throw new ActionRefusedError(
          "Ler este endereço exige aprovação.",
          "deny[5]",
        );
      },
      navigate: async () => {
        navigations += 1;
        throw new Error("fallback automático seria contornar a recusa");
      },
    });
    const outcome = await tools.execute(
      { name: "fetch_page", arguments: { url: "https://loja.test/interno" } },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.refused).toEqual({
      rule: "deny[5]",
      reason: "Ler este endereço exige aprovação.",
    });
    expect(outcome.result).toBeUndefined();
    expect(navigations).toBe(0);
  });

  test("fetch_page só informa o Chromium quando o motor falha tecnicamente, sem chamá-lo", async () => {
    let navigations = 0;
    const tools = toolsWith({
      fetch: async () => {
        throw new ComputerUnavailableError(
          "O motor sem pixels não respondeu em 45s.",
        );
      },
      navigate: async () => {
        navigations += 1;
        throw new Error("não deveria navegar sozinho");
      },
    });
    const outcome = await tools.execute(
      { name: "fetch_page", arguments: { url: "https://loja.test/precos" } },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("COMPUTER_UNAVAILABLE");
    expect(outcome.refused).toBeUndefined();
    const result = outcome.result as {
      fallback: { tool: string; note: string };
    };
    expect(result.fallback.tool).toBe("navigate");
    expect(result.fallback.note).toContain("mesma política");
    expect(navigations).toBe(0);
  });

  test("uma chamada humana sem run não inventa identidade de auditoria", async () => {
    let actorSeen: unknown;
    const tools = toolsWith({
      click: async (_botId, actor) => {
        actorSeen = actor;
        return { action: "click", url: "https://exemplo.test/", elapsedMs: 10 };
      },
    });
    const human = {
      ...context,
      runId: undefined,
    } as unknown as ToolCallContext;
    await tools.execute(
      { name: "click", arguments: { ref: "e1", snapshotId: 1 } },
      human,
    );
    expect(actorSeen).toEqual({ id: "pessoa-1", userId: "pessoa-1" });
    expect(actorSeen).not.toHaveProperty("runId");
  });

  test("fill_form com rótulos duplicados não adivinha o campo: preenche o unívoco e informa o resto", async () => {
    const typed: string[] = [];
    const tools = toolsWith({
      snapshot: async () => ({
        snapshotId: 1,
        url: "https://loja.test/entrega",
        title: "Entrega",
        truncated: false,
        viewport: { width: 1280, height: 800 },
        elements: [
          { ref: "e1", role: "textbox", name: "Telefone" },
          { ref: "e2", role: "textbox", name: "Telefone" },
          { ref: "e3", role: "textbox", name: "Nome" },
        ],
      }),
      type: async (_botId, _actor, input) => {
        typed.push(input.ref);
        return {
          action: "type",
          ref: input.ref,
          characters: 4,
          url: "https://loja.test/entrega",
          elapsedMs: 40,
        };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: {
          values: [
            { label: "Telefone", value: "119999" },
            { label: "Nome", value: "Marina" },
          ],
        },
      },
      context,
    );
    expect(outcome.ok).toBe(true);
    const result = outcome.result as {
      filled: { label: string; ref: string }[];
      unknown: string[];
    };
    expect(result.filled).toEqual([{ label: "Nome", ref: "e3" }]);
    expect(result.unknown).toEqual(["Telefone"]);
    expect(typed).toEqual(["e3"]);
    expect(JSON.stringify(outcome)).not.toContain("119999");
  });

  test("fill_form só com rótulo duplicado recusa antes de tocar no navegador", async () => {
    let typed = 0;
    const tools = toolsWith({
      snapshot: async () => ({
        snapshotId: 1,
        url: "https://loja.test/entrega",
        title: "Entrega",
        truncated: false,
        viewport: { width: 1280, height: 800 },
        elements: [
          { ref: "e1", role: "textbox", name: "Telefone" },
          { ref: "e2", role: "textbox", name: "Telefone" },
        ],
      }),
      type: async () => {
        typed += 1;
        throw new Error("não deveria digitar num campo ambíguo");
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: { values: [{ label: "Telefone", value: "119999" }] },
      },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("INVALID_ARGUMENTS");
    expect(typed).toBe(0);
  });

  test("fill_form para quando um campo novo aparece no meio do preenchimento", async () => {
    const typed: string[] = [];
    let snapshots = 0;
    const tools = toolsWith({
      snapshot: async () => {
        snapshots += 1;
        const extra =
          snapshots === 1
            ? []
            : [{ ref: "e3", role: "textbox", name: "Cupom" }];
        return {
          snapshotId: snapshots,
          url: "https://loja.test/produtos/novo",
          title: "Novo produto",
          truncated: false,
          viewport: { width: 1280, height: 800 },
          elements: [
            { ref: "e1", role: "textbox", name: "Nome do produto" },
            { ref: "e2", role: "textbox", name: "Preço *" },
            ...extra,
          ],
        };
      },
      type: async (_botId, _actor, input) => {
        typed.push(input.ref);
        return {
          action: "type",
          ref: input.ref,
          characters: 7,
          url: "https://loja.test/produtos/novo",
          elapsedMs: 40,
        };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: {
          values: [
            { label: "Nome do produto", value: "Caderno" },
            { label: "Preço", value: "29.90" },
          ],
        },
      },
      context,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.stale).toBe(true);
    expect(outcome.error?.code).toBe("STALE_SNAPSHOT");
    const result = outcome.result as {
      filled: { label: string }[];
      pending: string[];
    };
    expect(result.filled.map((field) => field.label)).toEqual([
      "Nome do produto",
    ]);
    expect(result.pending).toEqual(["Preço *"]);
    expect(typed).toEqual(["e1"]);
    expect(JSON.stringify(outcome)).not.toContain("29.90");
  });

  test("fill_form never sends the next value to a redirected lookalike form", async () => {
    let snapshots = 0;
    const typed: string[] = [];
    const tools = toolsWith({
      snapshot: async () => ({
        snapshotId: ++snapshots,
        url:
          snapshots === 1
            ? "https://shop.test/form"
            : "https://other.test/form",
        title: "Form",
        truncated: false,
        viewport: { width: 1280, height: 800 },
        elements: [
          { ref: "e1", role: "textbox", name: "Name" },
          { ref: "e2", role: "textbox", name: "Address" },
        ],
      }),
      type: async (_botId, _actor, input) => {
        typed.push(input.text);
        return { action: "type", url: "https://shop.test/form", elapsedMs: 1 };
      },
    });
    const outcome = await tools.execute(
      {
        name: "fill_form",
        arguments: {
          values: [
            { label: "Name", value: "Local" },
            { label: "Address", value: "private-address" },
          ],
        },
      },
      context,
    );
    expect(outcome.stale).toBe(true);
    expect(typed).toEqual(["Local"]);
    expect(JSON.stringify(outcome)).not.toContain("private-address");
  });
});
