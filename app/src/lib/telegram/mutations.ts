import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { telegramKeys, type PairingCode } from "./queries";

function invalidateBindings(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: telegramKeys.all });
}

/** O que a tela acrescenta à mutação; a invalidação vem de dentro, como em `lib/tasks`. */
export type Reacoes<TData, TVariables> = {
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
};

/**
 * Gera o código que liga um chat a um Bot.
 *
 * Quem manda `/start CODIGO` no privado do bot passa a operar o Bot escolhido aqui. O código vale uma
 * vez e por poucos minutos: é um segredo que viaja por um chat.
 */
export function createPairingCodeMutationOptions(
  queryClient: QueryClient,
  reacoes?: Reacoes<PairingCode, string>,
) {
  return mutationOptions({
    // Sem chave de envelope: a resposta já é o código, com as instruções. `client` sem chave devolve
    // o `Response`, e quem lê o corpo é quem conhece o formato.
    mutationFn: async (botId: string): Promise<PairingCode> => {
      const response = await client("/api/telegram/pairing-codes", {
        method: "POST",
        body: { botId },
        fallback: "Não foi possível gerar o código.",
      });
      return (await response.json()) as PairingCode;
    },
    onSuccess: (code, botId) => {
      void invalidateBindings(queryClient);
      reacoes?.onSuccess?.(code, botId);
    },
    onError: (error, botId) => reacoes?.onError?.(error, botId),
  });
}

/** Desliga um chat. O vínculo some para quem o criou, e o bot para de aceitar ordens dele. */
export function removeBindingMutationOptions(
  queryClient: QueryClient,
  reacoes?: Reacoes<{ removed: boolean }, string>,
) {
  return mutationOptions({
    mutationFn: async (bindingId: string): Promise<{ removed: boolean }> => {
      const response = await client(
        `/api/telegram/bindings/${encodeURIComponent(bindingId)}`,
        { method: "DELETE", fallback: "Não foi possível desligar o chat." },
      );
      return (await response.json()) as { removed: boolean };
    },
    onSuccess: (result, bindingId) => {
      void invalidateBindings(queryClient);
      reacoes?.onSuccess?.(result, bindingId);
    },
    onError: (error, bindingId) => reacoes?.onError?.(error, bindingId),
  });
}
