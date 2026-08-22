import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  setGoogleDriveRootsMutationOptions,
  setUpGoogleDriveMutationOptions,
  startGoogleDriveOAuthMutationOptions,
  syncGoogleDriveMutationOptions,
} from "@/lib/connectors/mutations";
import { connectorListQueryOptions } from "@/lib/connectors/queries";
import { queryClient } from "@/query-client";

/**
 * A volta do Google chega pela barra de endereço.
 *
 * O callback é um redirecionamento e não uma resposta JSON, porque quem chega nele é o navegador de
 * quem acabou de clicar em "permitir" — uma tela de JSON no meio do caminho seria um beco sem saída.
 * O resultado viaja na query e é lido aqui.
 */
type Outcome = { connected?: string; failure?: string };

export const Route = createFileRoute("/_authed/admin/connectors/google-drive")({
  validateSearch: (search: Record<string, unknown>): Outcome => ({
    connected:
      typeof search.conectado === "string" ? search.conectado : undefined,
    failure: typeof search.erro === "string" ? search.erro : undefined,
  }),
  component: GoogleDriveConnectorPage,
});

/** O endereço pelo qual ESTE navegador alcança o deployment, que é o que o Google tem de aceitar. */
const CALLBACK_PATH = "/api/admin/connectors/google-drive/oauth/callback";

function callbackUrl(): string {
  return `${window.location.origin}${CALLBACK_PATH}`;
}

function GoogleDriveConnectorPage() {
  const outcome = Route.useSearch();
  const connectors = useQuery(connectorListQueryOptions());
  const drive = connectors.data?.find(
    (connector) => connector.type === "google_drive",
  );

  return (
    <PageShell
      description="Conecte o Drive de onde os documentos devem vir."
      title="Google Drive"
    >
      {outcome.connected ? (
        <p
          className="mt-6 rounded-md border border-emerald-600/30 bg-emerald-600/10 px-3 py-2 text-sm"
          role="status"
        >
          Conectado como <strong>{outcome.connected}</strong>. Sincronize para
          trazer os documentos.
        </p>
      ) : null}
      {outcome.failure ? (
        <p
          className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm"
          role="alert"
        >
          {outcome.failure}
        </p>
      ) : null}

      {drive?.account ? (
        <ConnectedDrive account={drive.account} roots={drive.roots} />
      ) : null}

      <ConnectWithGoogle connected={Boolean(drive?.account)} />
      <ServiceAccountSetUp />
    </PageShell>
  );
}

/**
 * O que existe depois de conectar: de quem é a conta, o que vai ser lido, e a prova de que funciona.
 *
 * A contagem de documentos é o ponto desta seção. "Configurado" foi exatamente o que escondeu, por
 * todo o tempo em que este conector foi um esqueleto, que nenhuma linha do produto chamava o Drive.
 */
function ConnectedDrive({
  account,
  roots,
}: {
  account: string;
  roots: string[];
}) {
  const sync = useMutation(syncGoogleDriveMutationOptions(queryClient));
  const saveRoots = useMutation(
    setGoogleDriveRootsMutationOptions(queryClient),
  );
  const [folders, setFolders] = useState(roots.join(", "));

  return (
    <PageSection title="Conectado">
      <p className="mt-4 text-sm">
        Lendo o Drive de <strong>{account}</strong>.
      </p>

      <Field className="mt-6">
        <FieldLabel htmlFor="pastas">Pastas</FieldLabel>
        <Input
          id="pastas"
          onChange={(event) => setFolders(event.target.value)}
          placeholder="Deixe em branco para o Drive inteiro"
          value={folders}
        />
        <FieldDescription>
          Nomes separados por vírgula. São lidos os arquivos diretamente dentro
          de cada pasta.
        </FieldDescription>
      </Field>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          disabled={saveRoots.isPending}
          onClick={() =>
            saveRoots.mutate(
              folders
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean),
            )
          }
          size="sm"
          variant="outline"
        >
          Salvar pastas
        </Button>
        <Button
          disabled={sync.isPending}
          onClick={() => sync.mutate("sync")}
          size="sm"
        >
          {sync.isPending ? "Sincronizando…" : "Sincronizar agora"}
        </Button>
        <Button
          disabled={sync.isPending}
          onClick={() => sync.mutate("reconcile")}
          size="sm"
          variant="outline"
        >
          Varrer tudo de novo
        </Button>
      </div>

      {sync.isSuccess ? (
        <p className="mt-3 text-sm" role="status">
          {sync.data.documents} documento(s) indexado(s)
          {sync.data.deleted > 0 ? `, ${sync.data.deleted} removido(s)` : ""}.
          {sync.data.documents === 0
            ? " Nenhum documento chegou — confira as pastas acima, ou deixe em branco para ler o Drive inteiro."
            : ""}
        </p>
      ) : null}
      {sync.error ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {sync.error.message}
        </p>
      ) : null}
      {saveRoots.error ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {saveRoots.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}

/**
 * O caminho de uma conta pessoal, e o único que funciona nela.
 *
 * Conta de serviço com delegação em todo o domínio pressupõe um domínio: numa conta @gmail.com não
 * existe Admin Console onde autorizar o client id, e o Google devolve um token perfeitamente válido
 * para a própria conta de serviço — que não enxerga documento nenhum. A falha é silenciosa e cara,
 * por isso esta é a seção de cima.
 */
function ConnectWithGoogle({ connected }: { connected: boolean }) {
  const start = useMutation(startGoogleDriveOAuthMutationOptions());
  const form = useForm({
    defaultValues: { clientId: "", clientSecret: "" },
    validators: {
      onSubmit: z.object({
        clientId: z.string().trim().min(1, "Informe o client id."),
        clientSecret: z.string().trim().min(1, "Informe o client secret."),
      }),
    },
    onSubmit: async ({ value }) => {
      const url = await start.mutateAsync({
        ...value,
        redirectUri: callbackUrl(),
      });
      // Substitui em vez de abrir aba: o Google devolve o navegador a este mesmo lugar, e uma aba
      // órfã atrás dele mostraria para sempre o estado anterior à conexão.
      window.location.assign(url);
    },
  });

  return (
    <PageSection title={connected ? "Reconectar" : "Conectar com o Google"}>
      <p className="mt-4 text-muted-foreground text-sm">
        Para uma conta pessoal (@gmail.com), este é o caminho. Crie um OAuth
        Client do tipo <em>Web application</em> no Google Cloud, com a API do
        Drive ativada, e registre a URL de retorno abaixo.
      </p>

      <Field className="mt-4">
        <FieldLabel htmlFor="retorno">
          URL de retorno autorizada (copie para o Google Cloud)
        </FieldLabel>
        <Input
          id="retorno"
          readOnly
          value={typeof window === "undefined" ? CALLBACK_PATH : callbackUrl()}
        />
        <FieldDescription>
          Precisa bater caractere por caractere, incluindo a porta. É o endereço
          por onde você abriu esta página.
        </FieldDescription>
      </Field>

      <form
        className="mt-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="clientId">
            {(field) => (
              <Field
                data-invalid={
                  field.state.meta.isTouched && !field.state.meta.isValid
                }
              >
                <FieldLabel htmlFor={field.name}>Client ID</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="000000000000-xxxx.apps.googleusercontent.com"
                  value={field.state.value}
                />
                <FieldError errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>

          <form.Field name="clientSecret">
            {(field) => (
              <Field
                data-invalid={
                  field.state.meta.isTouched && !field.state.meta.isValid
                }
              >
                <FieldLabel htmlFor={field.name}>Client secret</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  type="password"
                  value={field.state.value}
                />
                <FieldError errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>
        </FieldGroup>

        {start.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {start.error.message}
          </p>
        ) : null}

        <Button className="mt-6" disabled={start.isPending} type="submit">
          {start.isPending ? "Abrindo o Google…" : "Conectar com o Google"}
        </Button>
      </form>
    </PageSection>
  );
}

/** O caminho de uma organização: concede pastas uma vez, sem depender de ninguém clicar. */
function ServiceAccountSetUp() {
  const setup = useMutation(setUpGoogleDriveMutationOptions(queryClient));
  const form = useForm({
    defaultValues: { serviceAccountJson: "", impersonationSubject: "" },
    validators: {
      onSubmit: z.object({
        serviceAccountJson: z
          .string()
          .trim()
          .refine((value) => {
            try {
              const parsed: unknown = JSON.parse(value);
              return Boolean(
                parsed && typeof parsed === "object" && !Array.isArray(parsed),
              );
            } catch {
              return false;
            }
          }, "Cole um JSON de conta de serviço válido."),
        impersonationSubject: z
          .string()
          .email("Informe a conta do Workspace a personificar."),
      }),
    },
    onSubmit: async ({ value }) => {
      await setup.mutateAsync(value);
      form.reset();
    },
  });

  return (
    <PageSection title="Ou: conta de serviço da organização">
      <p className="mt-4 text-muted-foreground text-sm">
        Só para Google Workspace com domínio próprio, onde a delegação em todo o
        domínio pode ser autorizada no Admin Console. Numa conta pessoal isto
        não funciona.
      </p>
      <form
        className="mt-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="serviceAccountJson">
            {(field) => (
              <Field
                data-invalid={
                  field.state.meta.isTouched && !field.state.meta.isValid
                }
              >
                <FieldLabel htmlFor={field.name}>
                  Chave JSON da conta de serviço
                </FieldLabel>
                <Textarea
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  rows={8}
                  value={field.state.value}
                />
                <FieldError errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>

          <form.Field name="impersonationSubject">
            {(field) => (
              <Field
                data-invalid={
                  field.state.meta.isTouched && !field.state.meta.isValid
                }
              >
                <FieldLabel htmlFor={field.name}>
                  Conta a personificar
                </FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="diretoria@suaempresa.com.br"
                  value={field.state.value}
                />
                <FieldError errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>
        </FieldGroup>

        {setup.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {setup.error.message}
          </p>
        ) : null}

        <Button
          className="mt-6"
          disabled={setup.isPending}
          type="submit"
          variant="outline"
        >
          Salvar conta de serviço
        </Button>
      </form>
    </PageSection>
  );
}
