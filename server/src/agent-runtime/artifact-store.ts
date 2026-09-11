/**
 * Onde as imagens de uma tarefa vivem, e por quanto tempo.
 *
 * O banco guarda o que um artefato É — tipo, dimensões, hash, classificação, destinos permitidos — e
 * o disco guarda os bytes. Separados porque os dois têm prazos e custos diferentes: uma linha é
 * pequena e some junto com a tarefa, uma imagem de 1280x800 ocupa centenas de kB e vive sete dias.
 *
 * Nada aqui decide o que pode sair: isso é `image-input.ts`. Este arquivo grava, lê e apaga, e
 * mantém a regra que o resto do sistema depende — nunca existe uma linha apontando para um arquivo
 * que não foi escrito.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AgentRunRepository,
  RunArtifactRow,
} from "../agent-runs/repository";

/** Quantos artefatos vencidos uma passagem do faxineiro apaga. */
const EXPIRY_BATCH = 50;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/json": "json",
};

export type CaptureInput = {
  runId: string;
  stepId?: string | null;
  kind: string;
  /** Base64, exactly as the computer returned it. */
  data: string;
  mime: string;
  url: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
  classification: RunArtifactRow["classification"];
  protection: RunArtifactRow["protection"];
  allowedDestinations: string[];
  /** Null keeps it forever, which is only right for something a deployment must be able to prove. */
  retentionDays: number | null;
  metadata?: Record<string, unknown>;
};

export interface ArtifactStore {
  capture(input: CaptureInput): Promise<RunArtifactRow>;
  /** The bytes, or undefined when the row is gone or its file with it. */
  read(
    id: string,
  ): Promise<{ row: RunArtifactRow; bytes: Buffer } | undefined>;
  /** Delete what is past its retention, file first, and say how many rows went. */
  deleteExpired(now?: Date, limit?: number): Promise<number>;
}

export function createArtifactStore(options: {
  repository: Pick<
    AgentRunRepository,
    "insertArtifact" | "artifact" | "expiredArtifacts" | "deleteArtifact"
  >;
  /** Where the bytes go. Relative paths resolve against the process's own directory. */
  root: string;
  /** How long an artifact is kept when the caller does not say. */
  retentionDays: number;
}): ArtifactStore {
  const root = resolve(options.root);

  function pathFor(runId: string, id: string, mime: string): string {
    const extension = EXTENSIONS[mime] ?? "bin";
    return join(root, runId, `${id}.${extension}`);
  }

  return {
    async capture(input: CaptureInput): Promise<RunArtifactRow> {
      const bytes = Buffer.from(input.data, "base64");
      const id = randomUUID();
      const storagePath = pathFor(input.runId, id, input.mime);

      /*
       * O arquivo primeiro, a linha depois.
       *
       * A ordem inversa deixaria uma janela em que uma linha aponta para nada: uma leitura nesse
       * intervalo responde "existe" e não tem o que devolver. Assim o pior caso é um arquivo sem
       * linha, que é lixo invisível que o faxineiro do sistema de arquivos pode recolher, e não um
       * artefato mentiroso.
       */
      await mkdir(dirname(storagePath), { recursive: true });
      await writeFile(storagePath, bytes);

      const retentionUntil =
        input.retentionDays === null
          ? null
          : new Date(Date.now() + input.retentionDays * 24 * 60 * 60 * 1_000);

      return options.repository.insertArtifact({
        runId: input.runId,
        stepId: input.stepId ?? null,
        kind: input.kind,
        mime: input.mime,
        width: input.width,
        height: input.height,
        hash: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        storagePath,
        classification: input.classification,
        protection: input.protection,
        retentionUntil,
        allowedDestinations: input.allowedDestinations,
        metadata: {
          url: input.url,
          capturedAt: input.capturedAt,
          ...(input.metadata ?? {}),
        },
      });
    },

    async read(id: string) {
      const row = await options.repository.artifact(id);
      if (!row) return undefined;
      try {
        return { row, bytes: await readFile(row.storagePath) };
      } catch {
        // A linha sem arquivo é o estado que a ordem de escrita acima evita. Acontecendo — volume
        // trocado, backup restaurado pela metade — a resposta honesta é "não tenho isto", e a linha
        // vai embora junto para não continuar prometendo.
        await options.repository.deleteArtifact(row.id).catch(() => undefined);
        return undefined;
      }
    },

    async deleteExpired(
      now: Date = new Date(),
      limit: number = EXPIRY_BATCH,
    ): Promise<number> {
      const expired = await options.repository.expiredArtifacts(now, limit);
      let deleted = 0;
      for (const row of expired) {
        await rm(row.storagePath, { force: true }).catch(() => undefined);
        await options.repository.deleteArtifact(row.id);
        deleted += 1;
      }
      return deleted;
    },
  };
}
