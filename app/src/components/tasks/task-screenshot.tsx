import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  requestTaskScreenshot,
  taskArtifactUrl,
} from "@/lib/tasks/queries";

/**
 * A captura sob demanda da tela do navegador da tarefa.
 *
 * Guarda só o id do artefato: os bytes vêm por `<img>` com os cookies da sessão, em vez de um
 * fetch manual que teria de recriar a autenticação. Um 502 (o navegador não respondeu) ou 503 (o
 * deployment não tem navegador) é frase do servidor e aparece como mensagem em linha — nunca como
 * tela branca, porque a tarefa continua legível sem a imagem.
 */
export function TaskScreenshot({ runId }: { runId: string }) {
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [capturando, setCapturando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          disabled={capturando}
          type="button"
          variant="outline"
          onClick={async () => {
            setCapturando(true);
            setErro(null);
            try {
              const artifact = await requestTaskScreenshot(runId);
              setArtifactId(artifact.id);
            } catch (thrown) {
              setErro(
                thrown instanceof Error
                  ? thrown.message
                  : "Não foi possível capturar a tela.",
              );
            } finally {
              setCapturando(false);
            }
          }}
        >
          {capturando ? "Capturando…" : "Capturar tela"}
        </Button>
      </div>
      {erro ? (
        <p className="text-destructive text-sm" role="alert">
          {erro}
        </p>
      ) : null}
      {artifactId && !erro ? (
        <img
          alt="Captura da tela da tarefa"
          className="max-w-full rounded-md border"
          src={taskArtifactUrl(runId, artifactId)}
        />
      ) : null}
    </div>
  );
}
