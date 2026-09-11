import { taskArtifactUrl, type StepView } from "@/lib/tasks/queries";

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
        <li
          key={step.id}
          className="flex flex-col gap-2 rounded-lg border p-3"
        >
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
