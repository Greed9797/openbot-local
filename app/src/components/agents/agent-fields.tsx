import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type AgentFormValues, agentFormSchema } from "@/lib/agents/form";
import {
  type ConnectionVerdict,
  testAgentConnection,
} from "@/lib/agents/queries";
import {
  modelCatalogQueryOptions,
  refreshModelCatalogMutationOptions,
} from "@/lib/models/queries";

export function AgentFields({
  defaultValues,
  hasAuth = false,
  submitLabel,
  onSubmit,
  error,
  onCancel,
}: {
  defaultValues: AgentFormValues;
  /** Whether this coworker already has a key, so the field can say so without showing it. */
  hasAuth?: boolean;
  submitLabel: string;
  onSubmit: (values: AgentFormValues) => Promise<unknown>;
  error?: Error | null;
  onCancel?: () => void;
}) {
  const form = useForm({
    defaultValues,
    validators: { onSubmit: agentFormSchema },
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
  });

  const [connection, setConnection] = useState<ConnectionVerdict | null>(null);
  const [testing, setTesting] = useState(false);

  const queryClient = useQueryClient();
  const catalogo = useQuery(modelCatalogQueryOptions());
  const atualizar = useMutation(
    refreshModelCatalogMutationOptions(queryClient),
  );
  // Um provedor por id, na ordem em que o servidor listou: o catálogo traz uma linha por modelo, e o
  // seletor de provedor não pode repetir a mesma linha cinco vezes.
  const provedores = [
    ...new Set((catalogo.data ?? []).map((entrada) => entrada.id)),
  ];

  /** Test endpoint reachability from the server, which is what runs will use. */
  const testConnection = async (endpoint: string, key: string) => {
    setTesting(true);
    setConnection(null);
    try {
      setConnection(await testAgentConnection(endpoint, key));
    } finally {
      setTesting(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="name">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Nome</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Gestor de despesas"
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="title">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Título</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Operações financeiras"
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="roleDescription">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Role</FieldLabel>
                <Textarea
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Revisa recibos, classifica despesas e prepara relatórios de reembolso."
                  rows={4}
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="visibility">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>Visibility</FieldLabel>
              <Select
                onValueChange={(value) =>
                  field.handleChange(value as AgentFormValues["visibility"])
                }
                value={field.state.value}
              >
                <SelectTrigger id={field.name}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="private">
                      Private, only you can see it
                    </SelectItem>
                    <SelectItem value="public">
                      Público, todo mundo vê
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
        <form.Field name="endpoint">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>
                  Agent endpoint (optional)
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    aria-invalid={isInvalid}
                    id={field.name}
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      setConnection(null);
                      field.handleChange(event.target.value);
                    }}
                    placeholder="https://your-agent.example.com/ag-ui"
                    value={field.state.value}
                  />
                  <Button
                    disabled={!field.state.value || testing}
                    onClick={() =>
                      void testConnection(
                        field.state.value,
                        form.getFieldValue("authValue") ?? "",
                      )
                    }
                    type="button"
                    variant="outline"
                  >
                    {testing ? "Testing…" : "Test"}
                  </Button>
                </div>
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
                {connection ? (
                  <p
                    className={`text-sm ${connection.ok ? "text-muted-foreground" : "text-destructive"}`}
                    role="status"
                  >
                    {connection.ok
                      ? `It answered: ${connection.events.join(", ")}`
                      : connection.reason}
                  </p>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Deixe vazio para usar o Bot embutido. Qualquer coisa que
                    fale AG-UI serve. É este servidor que disca para o seu
                    agente, então um agente na sua máquina precisa ser
                    alcançável a partir daqui.
                  </p>
                )}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="provider">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="agent-provider">
                Modelo de IA — provedor
              </FieldLabel>
              <div className="flex gap-2">
                <Select
                  onValueChange={(value) => {
                    field.handleChange(value ?? "");
                    // O modelo do provedor anterior não existe neste: manter o par antigo mandaria
                    // ao servidor uma escolha que ele recusa por não existir.
                    form.setFieldValue("model", "");
                  }}
                  value={field.state.value}
                >
                  <SelectTrigger className="w-full" id="agent-provider">
                    <SelectValue placeholder="Padrão do deployment" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="">Padrão do deployment</SelectItem>
                      {provedores.map((id) => (
                        <SelectItem key={id} value={id}>
                          {id}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  disabled={atualizar.isPending}
                  onClick={() => atualizar.mutate()}
                  type="button"
                  variant="outline"
                >
                  {atualizar.isPending ? "Atualizando…" : "Atualizar modelos"}
                </Button>
              </div>
              {catalogo.isPending ? (
                <p className="text-muted-foreground text-sm">
                  Lendo os modelos deste deployment…
                </p>
              ) : provedores.length > 0 ? (
                <p className="text-muted-foreground text-sm">
                  Sem escolha aqui, este Bot usa o padrão do deployment. A
                  escolha vale para toda tarefa dele, e uma tarefa pode
                  sobrepor.
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Nenhum modelo listado. O serviço do CLI pode estar fora do ar,
                  ou esta conta não tem modelo nenhum — suba o serviço e use
                  &ldquo;Atualizar modelos&rdquo;.
                </p>
              )}
              {atualizar.error ? (
                <p className="text-destructive text-sm" role="alert">
                  {atualizar.error.message}
                </p>
              ) : null}
            </Field>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.provider}>
          {(provider) => {
            // Dentro do provedor escolhido, e não no catálogo inteiro: `opencode-go/…` num provedor
            // que não é o dele seria aceito pela tela e recusado na criação da tarefa. O modelo
            // marcado como padrão não entra na lista — escolhê-lo é não escolher nada.
            const doProvedor = (catalogo.data ?? []).filter(
              (entrada) => entrada.id === provider.trim() && !entrada.default,
            );
            const semProvedor = provider.trim() === "";
            return (
              <form.Field name="model">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor="agent-model">Modelo</FieldLabel>
                    <Select
                      disabled={semProvedor || doProvedor.length === 0}
                      onValueChange={(value) => field.handleChange(value ?? "")}
                      value={field.state.value}
                    >
                      <SelectTrigger className="w-full" id="agent-model">
                        <SelectValue
                          placeholder={
                            semProvedor
                              ? "Escolha o provedor"
                              : "Padrão do provedor"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="">Padrão do provedor</SelectItem>
                          {doProvedor.map((entrada) => (
                            <SelectItem
                              key={entrada.model}
                              value={entrada.model}
                            >
                              {entrada.model}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-sm">
                      {semProvedor
                        ? "O modelo pertence a um provedor: escolha o provedor acima para ver o que ele oferece."
                        : "Vazio usa o modelo que aquele provedor tem configurado."}
                    </p>
                  </Field>
                )}
              </form.Field>
            );
          }}
        </form.Subscribe>
        <form.Field name="allowPrivateNavigation">
          {(field) => (
            <Field>
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <FieldLabel htmlFor="agent-private-navigation">
                    Navegar na rede interna
                  </FieldLabel>
                  <p className="text-muted-foreground text-sm">
                    Este Bot pode abrir endereços internos deste deployment —
                    inclusive os serviços que o governam. Ligue só para uma
                    página que você opera, e saiba que toda abertura e toda
                    recusa ficam na auditoria.
                  </p>
                </div>
                <Switch
                  aria-label="Navegar na rede interna"
                  checked={field.state.value}
                  id="agent-private-navigation"
                  onCheckedChange={(checked) =>
                    field.handleChange(checked === true)
                  }
                />
              </div>
            </Field>
          )}
        </form.Field>
        <form.Field name="authValue">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>
                Chave desse agente (opcional)
              </FieldLabel>
              <Input
                autoComplete="off"
                id={field.name}
                name={field.name}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={
                  hasAuth
                    ? "Há uma chave definida. Digite outra para substituir."
                    : "Bearer …"
                }
                // Never repopulated; `hasAuth` communicates that a key exists without exposing it.
                type="password"
                value={field.state.value}
              />
              <p className="text-muted-foreground text-sm">
                Sent as an <code>Authorization</code> em toda execução, e
                guardada no cofre de credenciais. Deixe vazio para manter a
                chave atual.
              </p>
            </Field>
          )}
        </form.Field>
      </FieldGroup>

      {error ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error.message}
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <form.Subscribe
          selector={(state) => [state.canSubmit, state.isSubmitting]}
        >
          {([canSubmit, isSubmitting]) => (
            <Button disabled={!canSubmit || isSubmitting} type="submit">
              {isSubmitting ? "Saving…" : submitLabel}
            </Button>
          )}
        </form.Subscribe>
        {onCancel ? (
          <Button onClick={onCancel} type="button" variant="outline">
            Cancelar
          </Button>
        ) : null}
      </div>
    </form>
  );
}
