/**
 * Uma pergunta sobre uma captura, respondida por um modelo que vê.
 *
 * Não é um passo de tarefa: não há ferramenta, histórico nem próxima ação, e nada do que o modelo
 * responder vira decisão — só texto para a pessoa. Por isso o caminho é o mesmo adaptador que a
 * tarefa usa, com instruções próprias, e o resultado é a mensagem final.
 *
 * O modelo que responde é escolhido entre os que o deployment configurou, e não o da tarefa: a
 * tarefa pode estar rodando num modelo de texto, e a pergunta é sobre a imagem. Quando nenhum modelo
 * do deployment vê imagens, isso é dito — em vez de a captura ser mandada para um modelo que não a
 * entende e responder algo plausível sobre nada.
 */
import type { AgentRunRow } from "../agent-runs/repository";
import type {
  AgentModelProvider,
  ModelCapabilities,
  ObservationImage,
} from "./contracts";

/** O papel de quem descreve uma tela. Pede o formato que o adaptador sabe ler, e nada além. */
const INSTRUCTIONS = [
  "Você descreve uma captura de tela para a pessoa que opera este navegador.",
  "Responda com JSON puro, sem cercas de código: {\"final\":\"sua resposta em texto\"}.",
  "Diga o que está visível e o que isso significa para a tarefa. Não invente o que não está na imagem.",
  "Se a imagem não permitir responder, diga isso na resposta e o que seria preciso para responder.",
].join("\n");

export class NoVisionModelError extends Error {
  constructor() {
    super(
      "Nenhum modelo configurado neste deployment vê imagens. Configure um modelo com visão para analisar a tela.",
    );
    this.name = "NoVisionModelError";
  }
}

/** O primeiro modelo configurado que enxerga, na ordem de preferência do deployment. */
export function visionProvider(
  providers: { list(): { id: string; capabilities: ModelCapabilities }[] },
  get: (id: string) => AgentModelProvider | undefined,
): AgentModelProvider | undefined {
  for (const entry of providers.list()) {
    if (entry.capabilities.vision) {
      const provider = get(entry.id);
      if (provider) return provider;
    }
  }
  return undefined;
}

export async function analyzeImage(options: {
  provider: AgentModelProvider;
  run: Pick<AgentRunRow, "id" | "botId" | "objective">;
  question: string;
  image: ObservationImage;
  signal: AbortSignal;
}): Promise<string> {
  const { provider, run, question, image } = options;
  if (!provider.capabilities.vision) throw new NoVisionModelError();

  const result = await provider.run(
    {
      runId: run.id,
      botId: run.botId,
      objective: question,
      observation: {
        observationId: `analysis-${image.artifactId}`,
        runId: run.id,
        url: "",
        title: "",
        text: "",
        truncated: false,
        elements: [],
        snapshotId: 0,
        viewport: { width: image.width ?? 0, height: image.height ?? 0 },
        capturedAt: image.capturedAt,
        control: { holder: "bot", secretPending: false },
        images: [image],
        textOnly: false,
        redactions: 0,
      },
      history: [],
      tools: [],
      budget: { maxSteps: 1, maxMs: 60_000, maxCorrections: 0 },
      usage: { steps: 0, activeMs: 0, modelCalls: 0, toolCalls: 0 },
      capabilities: provider.capabilities,
      instructions: INSTRUCTIONS,
    },
    { signal: options.signal },
  );

  if (result.kind === "final") return result.message;
  throw new Error(
    result.kind === "help"
      ? result.reason
      : "O modelo não respondeu sobre a imagem.",
  );
}
