/**
 * Os modelos que este deployment sabe usar, do jeito que a operação pergunta.
 *
 * A pergunta é sempre a mesma, e é feita no deploy: "o serviço que eu acabei de subir chegou ao
 * runtime?". Um `AGENT_OPENCODE_URL` com o nome de serviço errado, uma variável com typo, um
 * container que não subiu — nada disso produz erro. O runtime continua atendendo com o modelo
 * anterior, e o sintoma aparece depois como "a tarefa foi feita pelo modelo errado", que não se
 * parece com um erro de configuração. O log de boot diz quantos provedores existem; aqui estão quais.
 *
 * Lê do registro, que é quem decide o roteamento — e não da tabela `model_configurations`, que é a
 * cópia para a interface: uma linha lá para um provedor que não chegou a ser construído (sem
 * credencial, transporte desconhecido) diria "está lá" sobre um modelo que nenhuma tarefa alcança.
 * Por isso também o filtro: o catálogo é a interseção, não a lista do que foi escrito no `.env`.
 *
 * A projeção é campo a campo, e sem endereço, porque `AgentModelConfig` carrega a credencial e o
 * `baseUrl` pode conter usuário e senha embutidos (`https://user:senha@host/v1`) — nenhum dos dois
 * tem o que fazer numa resposta de leitura.
 */
import type { AgentModelConfig } from "../config";
import type { ModelCapabilities, ProviderRegistry } from "./contracts";

export type CatalogModel = {
  /** O id que a tarefa escolhe em `provider` — o mesmo que o runtime procura no registro. */
  id: string;
  /** O modelo, como o ambiente o escreveu (no transporte delegado, o "provider/model" do CLI). */
  model: string;
  transport: AgentModelConfig["transport"];
  capabilities: ModelCapabilities;
  /** Verdadeiro só para quem conduz a tarefa que não escolhe um modelo. */
  default: boolean;
};

export type ModelCatalog = {
  /** O id que a tarefa sem escolha usa, e que o painel mostra como "padrão do Bot". */
  default: string;
  models: CatalogModel[];
};

export function buildModelCatalog(options: {
  providers: ProviderRegistry;
  /** O que o ambiente declarou, na ordem de preferência. */
  configurations: AgentModelConfig[];
  defaultProvider: string;
  /**
   * Os modelos que cada serviço delegado diz ter, por id de provedor.
   *
   * Vem de fora porque só o serviço sabe: a conta do CLI tem modelos que o ambiente não escreveu, e
   * uma lista escrita à mão no `.env` envelhece no dia seguinte. Serviço que não respondeu fica
   * fora — o catálogo mostra o que existe de fato, nunca o que deveria existir.
   */
  serviceModels?: Record<string, string[]>;
}): ModelCatalog {
  const { providers, configurations, defaultProvider, serviceModels } = options;

  const models: CatalogModel[] = [];
  for (const config of configurations) {
    const provider = providers.get(config.id);
    // Um provedor que não foi construído não tem rota: anunciá-lo seria prometer o que a primeira
    // tarefa desmente. O motivo do descarte está no log do boot, onde a credencial ausente aparece.
    if (!provider) continue;
    models.push({
      id: config.id,
      model: config.model,
      transport: config.transport,
      capabilities: provider.capabilities,
      default: config.id === defaultProvider,
    });

    /*
     * E os outros modelos do mesmo serviço, que o ambiente não conhece.
     *
     * São escolhas de tarefa: `default` é falso em todas, porque quem conduz a tarefa sem escolha
     * continua sendo o modelo que o serviço tem configurado — este catálogo não muda isso.
     */
    for (const model of serviceModels?.[config.id] ?? []) {
      if (model === config.model) continue;
      models.push({
        id: config.id,
        model,
        transport: config.transport,
        capabilities: provider.capabilities,
        default: false,
      });
    }
  }

  return { default: defaultProvider, models };
}
