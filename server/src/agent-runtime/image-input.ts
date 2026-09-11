/**
 * De uma captura para o que o modelo pode ver.
 *
 * A pergunta deste arquivo é uma só: esta imagem pode sair para um modelo? A resposta é uma decisão
 * de classificação, não uma propriedade da imagem, e é por isso que ela mora aqui separada do
 * armazenamento. A imagem capturada é a mesma; o que muda é para onde ela pode ir.
 *
 * A ordem é sempre: capturar, classificar, decidir destinos, e só então montar o que um adaptador
 * transforma em bloco de imagem. Uma página sensível — dívida, saúde, credenciais, o que o
 * deployment listar — fica retida para revisão no painel em vez de ser enviada a um provedor por
 * padrão. Ver NFR-05.
 */
import type { RunArtifactRow } from "../agent-runs/repository";
import type { ObservationImage } from "./contracts";

/** Para onde um artefato pode ir. Negado por ausência, como toda decisão de acesso neste projeto. */
export const ARTIFACT_DESTINATIONS = ["panel", "model", "telegram"] as const;
export type ArtifactDestination = (typeof ARTIFACT_DESTINATIONS)[number];

const ALL: ArtifactDestination[] = [...ARTIFACT_DESTINATIONS];
/** O que uma página marcada como sensível ainda pode fazer: ser vista por quem tem sessão. */
const PANEL_ONLY: ArtifactDestination[] = ["panel"];

export type CaptureClassification = {
  classification: RunArtifactRow["classification"];
  destinations: ArtifactDestination[];
  /** Why, for the step and for whoever reviews it. Never a guess: it names the rule that matched. */
  reason: string;
};

/**
 * Classifica uma captura pelo host da página.
 *
 * Sensível é uma decisão do deployment, não do código: uma empresa que trabalha com prontuários
 * lista os hosts dos prontuários. A lista vazia — o padrão — deixa tudo em `internal`, que ainda é
 * uma classificação, e não uma licença: a imagem continua presa à retenção e aos destinos decididos
 * aqui.
 */
export function classifyCapture(options: {
  url: string;
  sensitiveHosts: readonly string[];
}): CaptureClassification {
  const host = hostOf(options.url);
  const sensitive = options.sensitiveHosts.find(
    (candidate) => host === candidate || host.endsWith(`.${candidate}`),
  );
  if (sensitive) {
    return {
      classification: "sensitive",
      destinations: PANEL_ONLY,
      reason: `o host ${host} está na lista de páginas sensíveis deste deployment`,
    };
  }
  return {
    classification: "internal",
    destinations: ALL,
    reason: "página comum deste deployment",
  };
}

/**
 * O que mandar ao modelo, ou nada.
 *
 * `undefined` não é um erro: é a resposta para "não envie esta imagem", e quem chama trata a
 * ausência como tal. Nunca devolve uma imagem sem permissão explícita na linha — a lista de
 * destinos é a autorização, e ela é gravada junto com o artefato, não recalculada aqui.
 */
export function imageForModel(
  row: RunArtifactRow,
  bytes: Buffer,
  now: Date = new Date(),
): ObservationImage | undefined {
  if (!row.allowedDestinations.includes("model")) return undefined;
  if (row.classification === "secret") return undefined;
  if (row.retentionUntil && row.retentionUntil.getTime() <= now.getTime()) return undefined;
  const capturedAt =
    typeof row.metadata?.capturedAt === "string"
      ? row.metadata.capturedAt
      : row.createdAt.toISOString();
  return {
    artifactId: row.id,
    mime: row.mime,
    width: row.width,
    height: row.height,
    capturedAt,
    protected: row.protection !== "none",
    // Base64 on the way to an adapter only. It is never written to a step, an event or a log.
    data: bytes.toString("base64"),
  };
}

/** Por que não foi, em uma frase, para o passo registrar o motivo em vez de omitir o campo. */
export function refusalReason(
  row: RunArtifactRow,
  now: Date = new Date(),
): string {
  if (row.classification === "secret") {
    return "o artefato foi classificado como segredo e não é enviado a nenhum modelo";
  }
  if (!row.allowedDestinations.includes("model")) {
    return "a página é sensível neste deployment: a imagem ficou para revisão no painel";
  }
  if (row.retentionUntil && row.retentionUntil.getTime() <= now.getTime()) {
    return "o artefato passou do prazo de retenção";
  }
  return "o artefato não tem permissão para ir a um modelo";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
