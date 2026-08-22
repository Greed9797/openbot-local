import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type ConnectorStatus, connectorKeys } from "./queries";

/** O que o Google Drive precisa antes de poder ler qualquer coisa em nome deste deployment. */
export type GoogleDriveSetupInput = {
  serviceAccountJson: string;
  impersonationSubject: string;
};

/**
 * Configurar o Google Drive por conta de serviço.
 *
 * O JSON da conta de serviço é uma credencial, então segue só de ida: é enviado aqui e nunca lido de
 * volta. O que uma leitura posterior devolve é se o conector está configurado, não com o quê.
 *
 * Este é o caminho de uma organização, e exige um domínio com Admin Console. Numa conta pessoal ele
 * não funciona — ver `startGoogleDriveOAuthMutationOptions`.
 */
export function setUpGoogleDriveMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: GoogleDriveSetupInput) => {
      await client("/api/admin/connectors/google-drive/setup", {
        method: "POST",
        body: input,
        fallback: "Não foi possível configurar o Google Drive",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
  });
}

export type GoogleDriveOAuthInput = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/**
 * Começar o consentimento no Google.
 *
 * Não invalida nada e não mexe na tela: o que ela devolve é um endereço, e quem termina o trabalho é
 * o Google mandando o navegador de volta ao callback. Só ali existe uma conexão para mostrar.
 */
export function startGoogleDriveOAuthMutationOptions() {
  return mutationOptions({
    mutationFn: async (input: GoogleDriveOAuthInput): Promise<string> =>
      client<string>("/api/admin/connectors/google-drive/oauth/start", "url", {
        method: "POST",
        body: input,
        fallback: "Não foi possível começar a conexão com o Google",
      }),
  });
}

/** Quais pastas varrer. Lista vazia significa o Drive inteiro. */
export function setGoogleDriveRootsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (roots: string[]) =>
      client<ConnectorStatus>(
        "/api/admin/connectors/google-drive/roots",
        "connector",
        {
          method: "PATCH",
          body: { roots },
          fallback: "Não foi possível salvar as pastas",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
  });
}

export type SyncResult = { documents: number; deleted: number };

/**
 * Puxar do Drive agora.
 *
 * Existe como botão porque a primeira pergunta de quem acabou de conectar é "funcionou?", e a
 * resposta honesta a essa pergunta é um número de documentos — não uma tela dizendo "conectado".
 */
export function syncGoogleDriveMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (mode: "sync" | "reconcile"): Promise<SyncResult> => {
      const response = await client("/api/admin/connectors/google-drive/sync", {
        method: "POST",
        body: { mode },
        fallback: "A sincronização falhou",
      });
      return (await response.json()) as SyncResult;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
  });
}
