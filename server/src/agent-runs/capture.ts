/**
 * Capturar a tela de uma tarefa, do jeito que o painel e o Telegram precisam.
 *
 * São três decisões numa ordem que não pode mudar: tirar a foto, classificá-la pela página em que ela
 * foi tirada, e guardá-la com os destinos que a classificação permite. Quem quiser a imagem depois
 * pergunta ao artefato — e é o artefato que responde se aquela imagem pode ir a um modelo.
 *
 * Mora aqui, e não na rota, porque a segunda superfície a pedir uma captura foi o Telegram, e a
 * resposta para "pode sair daqui?" não pode depender de quem perguntou.
 */
import type { ArtifactStore } from "../agent-runtime/artifact-store";
import { classifyCapture } from "../agent-runtime/image-input";
import type { CaptureClassification } from "../agent-runtime/image-input";
import type { ComputerGateway } from "../computer/gateway";
import type { AgentRunRow, RunArtifactRow } from "./repository";

/** O que uma captura precisa para existir: o navegador, o lugar onde ela fica e a classificação. */
export type RunVision = {
  gateway: ComputerGateway;
  artifacts: ArtifactStore;
  sensitiveHosts: string[];
  retentionDays: number;
};

export type CapturedScreen = {
  artifact: RunArtifactRow;
  classification: CaptureClassification;
  url: string;
};

export async function captureRunScreen(
  vision: RunVision,
  run: Pick<AgentRunRow, "id" | "botId">,
  options: { stepId?: string | null; capturedAt?: string } = {},
): Promise<CapturedScreen> {
  const shot = await vision.gateway.screenshot(run.botId);
  const url = shot.url ?? "";
  const classification = classifyCapture({
    url,
    sensitiveHosts: vision.sensitiveHosts,
  });
  const artifact = await vision.artifacts.capture({
    runId: run.id,
    stepId: options.stepId ?? null,
    kind: "screenshot",
    data: shot.base64,
    mime: "image/png",
    url,
    width: shot.width,
    height: shot.height,
    capturedAt: options.capturedAt ?? shot.capturedAt,
    classification: classification.classification,
    protection: (shot.masked ?? 0) > 0 ? "masked" : "none",
    allowedDestinations: classification.destinations,
    retentionDays: vision.retentionDays,
    metadata: { masked: shot.masked ?? 0, reason: classification.reason },
  });
  return { artifact, classification, url };
}
