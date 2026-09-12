import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * Uma escolha possível: o provedor, e um modelo dentro dele.
 *
 * `capabilities` vem do servidor porque é ele que decide o que aquele transporte sabe fazer — um
 * provedor sem visão não recebe captura. A tela não recalcula regra de runtime; ela mostra o que
 * existe e manda de volta o par que a pessoa escolheu.
 */
export type CatalogModel = {
  id: string;
  model: string;
  transport: string;
  capabilities: string[];
  /** O modelo que o deployment usa quando ninguém escolheu nenhum. */
  default: boolean;
};

export const modelCatalogKeys = {
  all: ["models"] as const,
};

/**
 * O que este deployment tem de modelo.
 *
 * A lista cresce depois do boot — o serviço do CLI responde quais modelos a conta dele tem —, então
 * quem consome isto precisa aguentar uma resposta que muda sem deploy: a mutation de atualização
 * invalida esta chave, e o seletor se repinta.
 */
export function modelCatalogQueryOptions() {
  return queryOptions({
    queryKey: modelCatalogKeys.all,
    queryFn: (): Promise<CatalogModel[]> =>
      client("/api/models", "models", {
        fallback: "Não foi possível carregar os modelos deste deployment",
      }),
  });
}

/**
 * Perguntar de novo aos serviços e atualizar o catálogo.
 *
 * Existe para quem acabou de ganhar um modelo na conta do CLI — o seletor mostrava uma lista velha e
 * não havia o que fazer além de reiniciar o deployment. O servidor devolve o catálogo novo; a
 * invalidação é o que faz a tela ler a resposta.
 */
export function refreshModelCatalogMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<CatalogModel[]> =>
      client("/api/models/refresh", "models", {
        method: "POST",
        fallback: "Não foi possível atualizar a lista de modelos",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: modelCatalogKeys.all }),
  });
}
