/**
 * Roteamento opt-in de modelos (RQ-10): dois candidatos, no máximo uma escalada.
 *
 * Sem política, nada muda: a tarefa roda no provedor que nomeia, e o padrão do deployment
 * continua sendo o primeiro da lista. Com `AGENT_ROUTING_POLICY`, o id sintético `routed`
 * passa a existir — e só ele roteia. Escolher `routed` na tarefa (ou no padrão do Bot) é o
 * opt-in; nenhum Bot é movido para ele sem ter escolhido.
 *
 * Uma escalada, não um laço: o wrapper tenta o primário e, só em falha retentável
 * (`retryable === true`, o que o `http.ts` usa para rede/429/5xx), tenta o fallback uma vez.
 * Recusa do provedor, aborto, cancelamento e interrupção humana nunca escalam. O estado da
 * escalada não mora num mapa em memória: ele é lido de `input.usage.attempts` — depois que o
 * fallback aparece ali, as próximas decisões (e retomadas) vão direto a ele.
 *
 * Cada tentativa subjacente, com sucesso ou falha, é relatada uma vez em
 * `context.onAttempt`, com a identidade real do provedor/modelo e null no que não foi
 * reportado. O `onAttempt` nunca é repassado aos provedores internos: quem conta é este
 * wrapper, uma vez por tentativa.
 */
import type { AgentModelConfig } from "../config";
import type {
  AgentModelProvider,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  ModelAttemptUsage,
} from "./contracts";
import { ProviderRejectedError } from "./providers/http";

/** O id sintético que só existe quando a política está configurada. */
export const ROUTED_PROVIDER_ID = "routed";

/** A política opt-in: primário e um fallback opcional, ambos ids de provedores registrados. */
export type RoutingPolicy = {
  primary: string;
  fallback?: string;
};

/** Uma linha do catálogo para o `routed`: o id sintético com o modelo real do candidato. */
export type RoutedCatalogEntry = {
  id: string;
  model: string;
  transport: AgentModelConfig["transport"];
  capabilities: AgentModelProvider["capabilities"];
  default: false;
};

type Candidate = {
  provider: AgentModelProvider;
  /** O modelo padrão real do candidato, como o ambiente o escreveu. */
  model: string;
};

type CandidateIndex = {
  primary: Candidate;
  fallback?: Candidate;
};

function indexCandidates(
  providers: AgentModelProvider[],
  configs: AgentModelConfig[],
  policy: RoutingPolicy,
): CandidateIndex | undefined {
  const providersById: Record<string, AgentModelProvider> = Object.fromEntries(
    providers.map((provider) => [provider.id, provider]),
  );
  const primaryProvider = providersById[policy.primary];
  const primaryModel = configs.find(
    (config) => config.id === policy.primary,
  )?.model;
  if (!primaryProvider || !primaryModel) return undefined;
  const primary: Candidate = { provider: primaryProvider, model: primaryModel };
  if (!policy.fallback) return { primary };
  const fallbackProvider = providersById[policy.fallback];
  const fallbackModel = configs.find(
    (config) => config.id === policy.fallback,
  )?.model;
  if (!fallbackProvider || !fallbackModel) return undefined;
  if (
    fallbackProvider.capabilities.mode !== primaryProvider.capabilities.mode
  ) {
    throw new Error(
      "Routed primary and fallback must use the same execution mode.",
    );
  }
  return {
    primary,
    fallback: { provider: fallbackProvider, model: fallbackModel },
  };
}

/** Capabilities supported by at least one configured candidate; selection enforces each step. */
function availableCapabilities(
  primary: AgentModelProvider,
  fallback: AgentModelProvider | undefined,
): AgentModelProvider["capabilities"] {
  if (!fallback) return { ...primary.capabilities };
  return {
    vision: primary.capabilities.vision || fallback.capabilities.vision,
    tools: primary.capabilities.tools || fallback.capabilities.tools,
    streaming:
      primary.capabilities.streaming || fallback.capabilities.streaming,
    mode: primary.capabilities.mode,
  };
}

function compatible(
  provider: AgentModelProvider,
  input: AgentRunInput,
): boolean {
  if (input.tools.length > 0 && !provider.capabilities.tools) return false;
  if (
    (input.observation?.images?.length ?? 0) > 0 &&
    !provider.capabilities.vision
  ) {
    return false;
  }
  return true;
}

function alreadyEscalated(input: AgentRunInput, fallbackId: string): boolean {
  return (input.usage.attempts ?? []).some(
    (attempt) => attempt.provider === fallbackId,
  );
}

/** Só falha retentável escala: recusa, aborto e erro desconhecido não. */
function escalatable(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (error instanceof ProviderRejectedError) return false;
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === true
  );
}

function report(
  candidate: Candidate,
  reported?: ModelAttemptUsage,
): ModelAttemptUsage {
  return {
    provider: candidate.provider.id,
    model: reported?.model ?? candidate.model,
    inputTokens: reported?.inputTokens ?? null,
    outputTokens: reported?.outputTokens ?? null,
    cachedTokens: reported?.cachedTokens ?? null,
    cost: reported?.cost ?? null,
  };
}

function unavailable(name: string): ProviderRejectedError {
  return new ProviderRejectedError(
    `No routed candidate can serve this step (${name}). The policy selects only configured, compatible providers; none qualifies.`,
  );
}

/**
 * Resolve qual candidato conduz este passo, sem escolher nada fora da política.
 *
 * Um `input.model` explícito que não seja o modelo configurado de nenhum candidato é
 * rejeitado, nunca trocado em silêncio. Sem escolha, quem já escalou (o fallback consta
 * em `usage.attempts`) continua no fallback; senão, o primário compatível, ou o fallback
 * compatível quando o primário não serve.
 */
export function selectRoutedCandidate(
  candidates: CandidateIndex,
  input: AgentRunInput,
): Candidate {
  const { primary, fallback } = candidates;
  const explicit = input.model?.trim() || undefined;
  if (explicit) {
    const pinned =
      explicit === primary.model
        ? primary
        : fallback && explicit === fallback.model
          ? fallback
          : undefined;
    if (!pinned) {
      throw new ProviderRejectedError(
        `The model "${explicit}" conflicts with the configured routing policy: it is neither "${primary.model}" nor "${fallback?.model ?? "—"}".`,
      );
    }
    if (!compatible(pinned.provider, input)) {
      throw unavailable(`explicit model "${explicit}" is incompatible`);
    }
    return pinned;
  }
  if (fallback && alreadyEscalated(input, fallback.provider.id)) {
    if (!compatible(fallback.provider, input)) {
      throw unavailable("persisted fallback is incompatible");
    }
    return fallback;
  }
  if (compatible(primary.provider, input)) return primary;
  if (fallback && compatible(fallback.provider, input)) return fallback;
  throw unavailable("no compatible candidate");
}

/**
 * O wrapper `routed`, ou `undefined` quando não há o que rotear.
 *
 * Devolve `undefined` sem política, sem primário construído, ou com fallback configurado
 * mas não construído (credencial ausente): rotear para um candidato que não existe seria
 * prometer a escalada que a primeira falha desmente.
 */
export function createRoutedProvider(options: {
  policy: RoutingPolicy | undefined;
  /** Os provedores já construídos do deployment. */
  providers: AgentModelProvider[];
  /** Os modelos configurados, de onde sai o modelo real de cada candidato. */
  configs: AgentModelConfig[];
}): AgentModelProvider | undefined {
  const { policy, providers, configs } = options;
  if (!policy) return undefined;
  const candidates = indexCandidates(providers, configs, policy);
  if (!candidates) return undefined;
  const { primary, fallback } = candidates;
  const capabilities = availableCapabilities(
    primary.provider,
    fallback?.provider,
  );

  return {
    id: ROUTED_PROVIDER_ID,
    capabilities,
    async run(
      input: AgentRunInput,
      context: AgentRunContext,
    ): Promise<AgentRunResult> {
      const first = selectRoutedCandidate(candidates, input);
      const downstream: AgentRunContext = {
        signal: context.signal,
        ...(context.onDelta ? { onDelta: context.onDelta } : {}),
      };
      const attempted = (
        candidate: Candidate,
        usage?: ModelAttemptUsage,
      ): void => {
        context.onAttempt?.(report(candidate, usage));
      };
      try {
        const result = await first.provider.run(
          { ...input, capabilities: first.provider.capabilities },
          downstream,
        );
        attempted(first, result.usage);
        return result;
      } catch (error) {
        attempted(first);
        const next =
          fallback && first.provider.id !== fallback.provider.id
            ? fallback
            : undefined;
        if (
          !next ||
          !escalatable(error, context.signal) ||
          !compatible(next.provider, input) ||
          (input.model?.trim() && input.model.trim() !== next.model)
        ) {
          throw error;
        }
        try {
          const result = await next.provider.run(
            { ...input, capabilities: next.provider.capabilities },
            downstream,
          );
          attempted(next, result.usage);
          return result;
        } catch (fallbackError) {
          attempted(next);
          throw fallbackError;
        }
      }
    },
  };
}

/**
 * Catalog rows name the actual candidate models and their own capabilities.
 * Pinning a candidate model does not authorize a different model.
 */
export function routedCatalogEntries(options: {
  policy: RoutingPolicy;
  providers: AgentModelProvider[];
  configs: AgentModelConfig[];
}): RoutedCatalogEntry[] {
  const { policy, providers, configs } = options;
  const candidates = indexCandidates(providers, configs, policy);
  if (!candidates) return [];
  const { primary, fallback } = candidates;
  const transportOf = (id: string): AgentModelConfig["transport"] =>
    configs.find((config) => config.id === id)?.transport ?? "chat-completions";
  const entries: RoutedCatalogEntry[] = [
    {
      id: ROUTED_PROVIDER_ID,
      model: primary.model,
      transport: transportOf(policy.primary),
      capabilities: primary.provider.capabilities,
      default: false,
    },
  ];
  if (fallback && policy.fallback && fallback.model !== primary.model) {
    entries.push({
      id: ROUTED_PROVIDER_ID,
      model: fallback.model,
      transport: transportOf(policy.fallback),
      capabilities: fallback.provider.capabilities,
      default: false,
    });
  }
  return entries;
}
