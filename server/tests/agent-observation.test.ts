/**
 * A observação que o modelo recebe, montada a partir do gateway.
 *
 * O que se prova: os três pedidos são feitos ao computador (controle, mapa de elementos, texto), o
 * texto passa por redação antes de virar observação, a imagem só existe quando foi pedida e quando a
 * classificação permite, e a captura é recusada durante um segredo — a regra que impede que a foto
 * devolva ao modelo o valor que o caminho do segredo existe para esconder.
 */
import { describe, expect, test } from "bun:test";
import type { CaptureInput } from "../src/agent-runtime/artifact-store";
import type {
  ComputerGateway,
  ControlState,
  ScreenshotResult,
} from "../src/computer/gateway";
import { createGatewayObservationSource } from "../src/agent-runtime/observation";

const actor = { id: "pessoa-1", runId: "run-1" };

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function controlState(overrides: Partial<ControlState> = {}): ControlState {
  return {
    holder: "bot",
    since: new Date().toISOString(),
    requested: false,
    ...overrides,
  };
}

/** O armazém de mentira guarda o que foi mandado, para o teste poder olhar a classificação. */
function fakeArtifacts() {
  const captures: CaptureInput[] = [];
  return {
    captures,
    store: {
      async capture(input: CaptureInput) {
        captures.push(input);
        return {
          id: `artifact-${captures.length}`,
          runId: input.runId,
          stepId: null,
          kind: input.kind,
          mime: input.mime,
          width: input.width,
          height: input.height,
          hash: "hash",
          bytes: 100,
          storagePath: "/tmp/x.png",
          classification: input.classification,
          protection: input.protection,
          retentionUntil: new Date(Date.now() + 86_400_000),
          allowedDestinations: input.allowedDestinations,
          metadata: { capturedAt: input.capturedAt },
          createdAt: new Date(),
        };
      },
    },
  };
}

function source(gateway: Partial<ComputerGateway>, sensitiveHosts: string[] = []) {
  const artifacts = fakeArtifacts();
  return {
    artifacts,
    observation: createGatewayObservationSource({
      gateway: gateway as ComputerGateway,
      artifacts: artifacts.store as never,
      sensitiveHosts,
      retentionDays: 7,
    }),
  };
}

const baseGateway: Partial<ComputerGateway> = {
  control: async () => controlState(),
  snapshot: async () => ({
    snapshotId: 12,
    url: "https://exemplo.test/form",
    title: "Formulário",
    elements: [
      { ref: "e1", role: "textbox", name: "Nome do produto" },
      { ref: "e2", role: "button", name: "Publicar" },
    ],
    truncated: false,
    viewport: { width: 1280, height: 800 },
  }),
  read: async () => ({
    url: "https://exemplo.test/form",
    title: "Formulário",
    text: "Nome do produto\nPublicar",
    truncated: false,
  }),
};

describe("a observação pelo gateway", () => {
  test("junta elementos, texto e a geração dos refs", async () => {
    const { observation, artifacts } = source(baseGateway);
    const result = await observation.observe({
      runId: "run-1",
      botId: "bot-1",
      actor,
      wantImage: false,
      signal: new AbortController().signal,
    });

    expect(result.snapshotId).toBe(12);
    expect(result.elements).toHaveLength(2);
    expect(result.text).toContain("Nome do produto");
    expect(result.viewport).toEqual({ width: 1280, height: 800 });
    expect(result.control).toEqual({ holder: "bot", secretPending: false });
    expect(result.images).toEqual([]);
    expect(result.textOnly).toBe(false);
    expect(artifacts.captures).toEqual([]);
  });

  test("o texto é redigido antes de virar observação", async () => {
    const { observation } = source({
      ...baseGateway,
      read: async () => ({
        url: "https://exemplo.test/",
        title: "Conta",
        text: "token: sk-proj-abcdefghijklmnopqrstuv e o resto",
        truncated: false,
      }),
    });
    const result = await observation.observe({
      runId: "run-1",
      botId: "bot-1",
      actor,
      wantImage: false,
      signal: new AbortController().signal,
    });
    expect(result.text).not.toContain("sk-proj-abcdefghijklmnopqrstuv");
    expect(result.redactions).toBe(1);
  });

  test("quando a imagem é pedida, ela é capturada, classificada e entregue", async () => {
    let captured = 0;
    const { observation, artifacts } = source({
      ...baseGateway,
      screenshot: async (): Promise<ScreenshotResult> => {
        captured += 1;
        return {
          base64: PIXEL_PNG,
          width: 1280,
          height: 800,
          capturedAt: "2026-09-11T10:00:00.000Z",
          url: "https://exemplo.test/form",
          masked: 1,
        };
      },
    });
    const result = await observation.observe({
      runId: "run-1",
      botId: "bot-1",
      actor,
      wantImage: true,
      signal: new AbortController().signal,
    });

    expect(captured).toBe(1);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.data).toBe(PIXEL_PNG);
    expect(result.images[0]?.protected).toBe(true);
    expect(artifacts.captures[0]).toMatchObject({
      kind: "screenshot",
      mime: "image/png",
      classification: "internal",
      protection: "masked",
      allowedDestinations: ["panel", "model", "telegram"],
      metadata: { masked: 1 },
    });
  });

  test("uma página sensível é gravada mas não vai ao modelo", async () => {
    const { observation, artifacts } = source(
      {
        ...baseGateway,
        screenshot: async (): Promise<ScreenshotResult> => ({
          base64: PIXEL_PNG,
          width: 1280,
          height: 800,
          capturedAt: "2026-09-11T10:00:00.000Z",
          url: "https://app.banco.test/extrato",
        }),
      },
      ["banco.test"],
    );
    const result = await observation.observe({
      runId: "run-1",
      botId: "bot-1",
      actor,
      wantImage: true,
      signal: new AbortController().signal,
    });
    expect(result.images).toEqual([]);
    expect(result.imageNote).toContain("sensível");
    expect(artifacts.captures[0]?.classification).toBe("sensitive");
    expect(artifacts.captures[0]?.allowedDestinations).toEqual(["panel"]);
  });

  test("durante um segredo, nenhuma captura é feita", async () => {
    let captured = 0;
    const { observation } = source({
      ...baseGateway,
      control: async () => controlState({ secretWanted: "a senha do banco" }),
      screenshot: async () => {
        captured += 1;
        throw new Error("não deveria capturar");
      },
    });
    const result = await observation.observe({
      runId: "run-1",
      botId: "bot-1",
      actor,
      wantImage: true,
      signal: new AbortController().signal,
    });
    expect(captured).toBe(0);
    expect(result.images).toEqual([]);
    expect(result.control.secretPending).toBe(true);
    expect(result.imageNote).toContain("must not see");
  });

  test("uma captura que falhou não derruba a observação", async () => {
    const { observation } = source({
      ...baseGateway,
      screenshot: async () => {
        throw new Error("A person is entering a value");
      },
    });
    const result = await observation.observe({
      runId: "run-1",
      botId: "bot-1",
      actor,
      wantImage: true,
      signal: new AbortController().signal,
    });
    expect(result.text).toContain("Nome do produto");
    expect(result.imageNote).toContain("A person is entering a value");
  });
});
