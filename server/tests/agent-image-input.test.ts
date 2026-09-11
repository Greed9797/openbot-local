/**
 * A decisão de mostrar uma imagem a um modelo.
 *
 * Duas perguntas, respondidas em lugares diferentes: qual é a classificação da página (o deployment
 * diz, por host) e quais destinos aquela linha autoriza (a linha diz, e não muda depois). O teste
 * cobre as duas, e o caso que mais importa é o terceiro: uma linha sensível, que existe, é mostrada
 * no painel e não vai a modelo nenhum.
 */
import { describe, expect, test } from "bun:test";
import type { RunArtifactRow } from "../src/agent-runs/repository";
import {
  classifyCapture,
  imageForModel,
  refusalReason,
} from "../src/agent-runtime/image-input";

function row(overrides: Partial<RunArtifactRow> = {}): RunArtifactRow {
  return {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    stepId: null,
    kind: "screenshot",
    mime: "image/png",
    width: 1280,
    height: 800,
    hash: "a".repeat(64),
    bytes: 1234,
    storagePath: "/tmp/nao-existe.png",
    classification: "internal",
    protection: "none",
    retentionUntil: new Date(Date.now() + 86_400_000),
    allowedDestinations: ["panel", "model", "telegram"],
    metadata: { capturedAt: "2026-09-11T10:00:00.000Z" },
    createdAt: new Date(),
    ...overrides,
  };
}

describe("classifyCapture", () => {
  test("uma página comum vai para o modelo, o painel e o Telegram", () => {
    const result = classifyCapture({
      url: "https://exemplo.test/form",
      sensitiveHosts: [],
    });
    expect(result.classification).toBe("internal");
    expect(result.destinations).toEqual(["panel", "model", "telegram"]);
  });

  test("um host sensível fica só no painel, e o motivo nomeia o host", () => {
    const result = classifyCapture({
      url: "https://app.banco.test/extrato",
      sensitiveHosts: ["banco.test"],
    });
    expect(result.classification).toBe("sensitive");
    expect(result.destinations).toEqual(["panel"]);
    expect(result.reason).toContain("app.banco.test");
  });

  test("um subdomínio do host sensível também é sensível", () => {
    expect(
      classifyCapture({
        url: "https://prontuario.hospital.test/paciente/1",
        sensitiveHosts: ["hospital.test"],
      }).classification,
    ).toBe("sensitive");
  });

  test("um host parecido não é confundido", () => {
    expect(
      classifyCapture({
        url: "https://naobanco.test/",
        sensitiveHosts: ["banco.test"],
      }).classification,
    ).toBe("internal");
  });

  test("sem URL não há como classificar, e o padrão não libera nada além do comum", () => {
    const result = classifyCapture({ url: "", sensitiveHosts: [] });
    expect(result.classification).toBe("internal");
  });
});

describe("imageForModel", () => {
  test("uma imagem autorizada vira base64 com o metadado que a identifica", () => {
    const bytes = Buffer.from("imagem");
    const image = imageForModel(row(), bytes);
    expect(image).toEqual({
      artifactId: expect.any(String),
      mime: "image/png",
      width: 1280,
      height: 800,
      capturedAt: "2026-09-11T10:00:00.000Z",
      protected: false,
      data: bytes.toString("base64"),
    });
  });

  test("uma página sensível não vai a modelo nenhum", () => {
    const sensitive = row({
      classification: "sensitive",
      allowedDestinations: ["panel"],
    });
    expect(imageForModel(sensitive, Buffer.from("x"))).toBeUndefined();
    expect(refusalReason(sensitive)).toContain("sensível");
  });

  test("um segredo nunca vai, mesmo que a linha autorize", () => {
    const secret = row({
      classification: "secret",
      allowedDestinations: ["panel", "model"],
    });
    expect(imageForModel(secret, Buffer.from("x"))).toBeUndefined();
    expect(refusalReason(secret)).toContain("segredo");
  });

  test("um artefato vencido não é enviado", () => {
    const expired = row({ retentionUntil: new Date(Date.now() - 1_000) });
    expect(imageForModel(expired, Buffer.from("x"))).toBeUndefined();
  });

  test("uma máscara aplicada fica registrada no que o modelo recebe", () => {
    const masked = row({ protection: "masked" });
    expect(imageForModel(masked, Buffer.from("x"))?.protected).toBe(true);
  });
});
