export type AgentVisibility = "public" | "private";

export type AgentActor = {
  id: string;
  role: "admin" | "user";
};

export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: AgentVisibility;
  ownerUserId: string | null;
  systemOwned: boolean;
  hidden: boolean;
  deletedAt: Date | null;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether a key is set for it. Never the key. */
  hasAuth: boolean;
  /**
   * Whether this agent holds a credential for calling tools back.
   *
   * A boolean, never the token: the token exists in a readable form once, in the response that issued
   * it. A surface only needs to know whether to generate or rotate.
   */
  hasCallbackToken: boolean;
  /**
   * O provedor de modelo que este Bot escolheu, ou null para o padrão do deployment.
   *
   * Mora no Bot e não na tarefa porque é uma propriedade dele: o mesmo Bot respondendo "quem é você"
   * com um modelo diferente a cada tarefa não é configurável, é imprevisível. A tarefa ainda pode
   * sobrepor — ver `CreateRunInput.provider`.
   */
  provider: string | null;
  /** O modelo dentro daquele provedor, ou null para o modelo que o provedor já tem. */
  model: string | null;
  /**
   * Se o navegador deste Bot pode entrar na rede interna deste deployment.
   *
   * Desligado por padrão, e por Bot de propósito: a resposta deployment-wide custou caro — o
   * navegador do Bot alcançava a API que o governa —, então quem precisa disso declara qual Bot
   * precisa, em vez de abrir para todos. Ver `COMPUTER_ALLOW_PRIVATE_NAVIGATION` para a resposta
   * do deployment inteiro.
   */
  allowPrivateNavigation: boolean;
};

export type CreateAgentInput = Pick<
  AgentProfile,
  "name" | "title" | "roleDescription" | "visibility"
> & {
  /**
   * The AG-UI endpoint this Bot runs on, or undefined for the one in the box.
   *
   * This field is the AG-UI endpoint for a customer-provided agent. Without it the Bot runs on the
   * built-in endpoint.
   */
  endpoint?: string;
  /**
   * A key this agent sits behind, if any.
   *
   * Write-only. It goes to the vault and is never read back to a person: the edit form shows that a
   * key is set, not what it is. Absent on an update means "leave whatever is there alone", which is
   * why it is optional rather than defaulting to empty; a blank field must not drop a key.
   */
  auth?: { header: string; value: string };
  /**
   * O provedor de modelo escolhido para este Bot.
   *
   * Ausente numa edição preserva o que está gravado; string vazia limpa e devolve o Bot ao padrão do
   * deployment. A diferença importa: o formulário manda os dois campos sempre, e sem o vazio
   * significando "limpar" não haveria como voltar atrás.
   */
  provider?: string;
  /** O modelo dentro daquele provedor. Mesma regra de ausente/vazio do provedor. */
  model?: string;
  /** Se o navegador deste Bot pode entrar na rede interna. Ausente preserva o que está gravado. */
  allowPrivateNavigation?: boolean;
};
