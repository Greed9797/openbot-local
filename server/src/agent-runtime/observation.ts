/**
 * O que o modelo vê do navegador, montado a partir do gateway.
 *
 * Uma observação é três leituras da mesma página — o mapa de elementos, o texto e, quando pedida, a
 * imagem — e a decisão de o que fazer com cada uma. A imagem é a única que sai daqui como artefato
 * autorizado: ela é classificada pelo host, gravada, e só então transformada no que um adaptador
 * manda ao provedor. Texto passa por `redactSecrets` antes de virar observação, porque o texto vai
 * para o passo da tarefa e para o modelo, e não há segunda chance de tirar um token de lá.
 *
 * Nada aqui executa ação nenhuma. Observar não muda a página, e o loop sempre observa antes de
 * decidir justamente para que a decisão seja sobre um estado que existiu.
 */
import { randomUUID } from "node:crypto";
import type { ComputerGateway } from "../computer/gateway";
import type {
  AgentObservation,
  ObservationRequest,
  ObservationSource,
  ObservationImage,
} from "./contracts";
import type { ArtifactStore } from "./artifact-store";
import { classifyCapture, imageForModel, refusalReason } from "./image-input";
import { redactSecrets } from "./redact";

export type GatewayObservationOptions = {
  gateway: ComputerGateway;
  artifacts: ArtifactStore;
  /** Hosts whose pages are captured for the panel but never sent to a model. */
  sensitiveHosts?: readonly string[];
  /** How long a captured image is kept. */
  retentionDays: number;
};

export function createGatewayObservationSource(
  options: GatewayObservationOptions,
): ObservationSource {
  const sensitiveHosts = options.sensitiveHosts ?? [];

  return {
    async observe(request: ObservationRequest): Promise<AgentObservation> {
      const { botId } = request;
      let control = await options.gateway.control(botId);
      let snapshot = await options.gateway.snapshot(botId);
      let page = snapshot.page ?? (await options.gateway.read(botId));
      for (
        let attempt = 0;
        snapshot.url !== page.url && attempt < 2;
        attempt += 1
      ) {
        request.signal.throwIfAborted();
        snapshot = await options.gateway.snapshot(botId);
        page = snapshot.page ?? (await options.gateway.read(botId));
      }
      if (snapshot.url !== page.url) {
        throw new Error(
          "The page changed while observing it. No coherent observation is available.",
        );
      }
      const redacted = redactSecrets(page.text);

      const images: ObservationImage[] = [];
      let imageNote: string | undefined;
      if (request.wantImage) {
        control = await options.gateway.control(botId);
        if (control.secretWanted) {
          // Nunca capturar durante um segredo: a foto devolveria ao modelo exatamente o valor que o
          // caminho do segredo existe para manter fora dele. Ver NFR-05.
          imageNote =
            "A person is entering a value the assistant must not see, so no capture was taken.";
        } else if (control.holder === "human") {
          imageNote = "A person has control, so no capture was taken.";
        } else {
          imageNote = await captureAndStore(request, images, snapshot.url);
        }
      }

      return {
        observationId: randomUUID(),
        runId: request.runId,
        url: snapshot.url || page.url,
        title: snapshot.title || page.title,
        text: redacted.text,
        truncated: page.truncated,
        elements: snapshot.elements,
        snapshotId: snapshot.snapshotId,
        viewport: snapshot.viewport,
        capturedAt: new Date().toISOString(),
        control: {
          holder: control.holder,
          secretPending: Boolean(control.secretWanted),
        },
        images,
        ...(imageNote ? { imageNote } : {}),
        redactions: redacted.redactions,
        // Sempre Chromium: a leitura rápida não tem página atrás e não é o que uma tarefa observa.
        textOnly: false,
      };
    },
  };

  /** Captura, classifica, grava, e devolve por que não deu — ou nada, quando deu. */
  async function captureAndStore(
    request: ObservationRequest,
    images: ObservationImage[],
    expectedUrl: string,
  ): Promise<string | undefined> {
    try {
      const shot = await options.gateway.screenshot(request.botId);
      const url = shot.url ?? "";
      if (url !== expectedUrl)
        return "The page changed before capture; the image was not retained or sent.";
      const classified = classifyCapture({ url, sensitiveHosts });
      const bytes = Buffer.from(shot.base64, "base64");
      const row = await options.artifacts.capture({
        runId: request.runId,
        stepId: null,
        kind: "screenshot",
        data: shot.base64,
        mime: "image/png",
        url,
        width: shot.width,
        height: shot.height,
        capturedAt: shot.capturedAt,
        classification: classified.classification,
        protection: (shot.masked ?? 0) > 0 ? "masked" : "none",
        allowedDestinations: classified.destinations,
        retentionDays: options.retentionDays,
        metadata: {
          masked: shot.masked ?? 0,
          classificationReason: classified.reason,
        },
      });
      const image = imageForModel(row, bytes);
      if (image) {
        images.push(image);
        return undefined;
      }
      return refusalReason(row);
    } catch (error) {
      // Uma captura que falhou não é uma tarefa que falhou: o modelo segue com o texto e os refs, e
      // a nota diz por que não há imagem para olhar.
      return error instanceof Error
        ? `The capture failed: ${error.message}`
        : "The capture failed.";
    }
  }
}
