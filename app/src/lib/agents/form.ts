import { z } from "zod";

/**
 * Browser-side coworker form contract. Limits match the server parser so validation errors can be
 * shown next to fields before submit.
 */
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(80, "Name must be 80 characters or fewer."),
  title: z
    .string()
    .trim()
    .min(1, "Title is required.")
    .max(120, "Title must be 120 characters or fewer."),
  roleDescription: z
    .string()
    .trim()
    .min(1, "Role description is required.")
    .max(1000, "Role description must be 1000 characters or fewer."),
  visibility: z.enum(["public", "private"]),
  /**
   * The AG-UI endpoint this coworker runs on. Empty means the Bot in the box.
   *
   * Only URL shape is checked here; deployment allow/deny rules are server-side.
   */
  endpoint: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      "Enter a web address starting with http:// or https://.",
    ),
  /**
   * A key the agent sits behind. WRITE-ONLY: it is never sent back from the server, so this field is
   * always empty when editing, and leaving it empty keeps whatever key is already set.
   */
  authValue: z.string(),
  /**
   * O provedor e o modelo que este Bot usa, quando escolheu um.
   *
   * Vazio é uma decisão — "o padrão do deployment" —, e é por isso que este formulário manda as duas
   * chaves sempre: é a string vazia que devolve o Bot ao padrão, e uma chave ausente preservaria a
   * escolha antiga. O teto de 120 é o mesmo do parser do servidor.
   */
  provider: z
    .string()
    .trim()
    .max(120, "Provider must be 120 characters or fewer."),
  model: z.string().trim().max(120, "Model must be 120 characters or fewer."),
  /**
   * Se este Bot pode abrir endereços da rede interna deste deployment.
   *
   * Booleano, e o padrão é falso: a caixa só fica marcada quando alguém a marcou, e é o que o
   * cadastro guarda. Marcada, o navegador deste Bot alcança os serviços que governam o deployment.
   */
  allowPrivateNavigation: z.boolean(),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

export const emptyAgentForm: AgentFormValues = {
  name: "",
  title: "",
  roleDescription: "",
  visibility: "private",
  endpoint: "",
  authValue: "",
  provider: "",
  model: "",
  allowPrivateNavigation: false,
};

/** Convert form values to API input; omit an empty key so editing preserves the current credential. */
export function agentInputFrom(values: AgentFormValues) {
  return {
    name: values.name,
    title: values.title,
    roleDescription: values.roleDescription,
    visibility: values.visibility,
    endpoint: values.endpoint,
    /*
     * As duas sempre, inclusive vazias: é a string vazia que devolve o Bot ao padrão do deployment,
     * e o servidor distingue "vazio" de "ausente" exatamente por isso. Diferente da chave, que é
     * write-only e some quando não foi tocada.
     */
    provider: values.provider.trim(),
    model: values.model.trim(),
    // Booleano de verdade, e não "presente ou ausente": desmarcar a caixa é uma decisão — tirar a
    // permissão —, e o servidor só a distingue de "não mexeu" porque este campo vai sempre.
    allowPrivateNavigation: values.allowPrivateNavigation,
    ...(values.authValue.trim()
      ? { auth: { header: "Authorization", value: values.authValue.trim() } }
      : {}),
  };
}
