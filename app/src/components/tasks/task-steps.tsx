import { type StepView, taskArtifactUrl } from "@/lib/tasks/queries";

const ROTULOS_TIPO: Record<StepView["kind"], string> = {
  observation: "Observação",
  decision: "Decisão",
  action: "Ação",
  execution: "Execução",
  note: "Nota",
  delegated: "Delegada",
};

/** Um bloco nomeado de JSON do passo, omitido quando o passo não o tem. */
function BlocoJson({
  titulo,
  valor,
}: {
  titulo: string;
  valor: Record<string, unknown> | null;
}) {
  if (!valor) return null;
  return (
    <div>
      <p className="font-medium text-muted-foreground text-xs">{titulo}</p>
      <pre className="mt-1 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs leading-relaxed">
        {JSON.stringify(valor, null, 2)}
      </pre>
    </div>
  );
}

/**
 * A recusa como frase, quando o passo tem uma.
 *
 * O JSON cru continua ali embaixo, e continua sendo a verdade inteira — isto é o que um leitor
 * precisa para entender em dois segundos que a política barrou a ação, e o que fazer quando o
 * motivo é a rede interna: a permissão é do Bot, e é aqui que se diz onde ligá-la.
 */
function Recusa({ resultado }: { resultado: Record<string, unknown> | null }) {
  const refused = resultado?.refused as
    | { reason?: unknown; cause?: unknown }
    | undefined;
  if (!refused || typeof refused.reason !== "string") return null;
  return (
    <div
      className="rounded-md border border-destructive/40 bg-destructive/5 p-2"
      role="status"
    >
      <p className="font-medium text-sm">Recusado</p>
      <p className="mt-1 text-muted-foreground text-sm">{refused.reason}</p>
      {refused.cause === "private_network" ? (
        <p className="mt-1 text-muted-foreground text-sm">
          Este endereço é interno a este deployment. Ligue &ldquo;navegar na
          rede interna&rdquo; no cadastro deste Bot, ou defina{" "}
          <code>COMPUTER_ALLOW_PRIVATE_NAVIGATION=true</code> para todos.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Os passos na ordem em que aconteceram.
 *
 * O que interessa aqui é a cadeia ferramenta proposta → decisão de política → resultado: é ela que
 * diz se o navegador fez o que o modelo pediu e se a política deixou. A imagem do passo, quando há
 * uma, carrega com os cookies da sessão como qualquer `<img>` da mesma origem.
 */
export function TaskSteps({
  runId,
  steps,
}: {
  runId: string;
  steps: StepView[];
}) {
  if (steps.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nenhum passo ainda. Eles aparecem aqui assim que a tarefa começar a
        andar.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((step) => (
        <li key={step.id} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-muted-foreground text-xs">
              #{step.seq}
            </span>
            <span className="font-medium text-sm">
              {ROTULOS_TIPO[step.kind]}
            </span>
            <span className="text-muted-foreground text-xs">{step.status}</span>
          </div>
          <BlocoJson titulo="Ferramenta proposta" valor={step.proposedAction} />
          <BlocoJson titulo="Decisão do modelo" valor={step.modelDecision} />
          <BlocoJson titulo="Decisão da política" valor={step.policyDecision} />
          <Recusa resultado={step.executionResult} />
          <BlocoJson titulo="Resultado" valor={step.executionResult} />
          <BlocoJson titulo="Observação" valor={step.observation} />
          {step.artifactId ? (
            <img
              alt={`Captura do passo ${step.seq}`}
              className="max-w-full rounded-md border"
              loading="lazy"
              src={taskArtifactUrl(runId, step.artifactId)}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
