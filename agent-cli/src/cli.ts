/**
 * Um CLI de agente por trás do mesmo contrato.
 *
 * O runtime não sabe dirigir um CLI, e não precisa saber: ele fala AG-UI com este serviço, que
 * escolhe o binário, escreve o config que dá o navegador do Bot ao CLI e lê de volta o que ele disse
 * e fez. É o mesmo desenho do serviço do Codex — o que muda é que aqui o CLI é dado de configuração,
 * não código.
 *
 * Os dois que existem hoje são parentes: o MiMo Code é um fork do OpenCode e herdou o mesmo formato
 * de config, os mesmos eventos de `--format json` e a mesma ideia de servidor MCP local. O que não é
 * igual está explicitado por adaptador — o nome do binário, o nome do arquivo de config e a flag de
 * auto-aprovação (o OpenCode diz `--auto`, o MiMo diz `--yolo`), que é exatamente o tipo de detalhe
 * que faz um turno travado esperar por uma aprovação que ninguém vai dar.
 *
 * Este arquivo é puro de propósito: sem processo, sem rede, sem relógio. É o que permite testar o
 * que cada CLI recebe no fio sem ter o CLI instalado.
 */

/** O que uma linha de stdout do CLI significa para este serviço. */
export type CliEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "failure"; message: string };

export type CliAdapter = {
  id: string;
  /** O binário, como está no PATH da imagem. */
  binary: string;
  /** O arquivo de config do projeto, relativo ao diretório de trabalho. */
  configPath: string;
  /** O argv do turno. O prompt vai como argumento: nenhum CLI aqui lê a tarefa de stdin. */
  args: (options: {
    prompt: string;
    workspace: string;
    model: string;
    /**
     * O esforço de raciocínio, no vocabulário do fornecedor (`high`, `max`, `minimal`).
     *
     * Vazio deixa o CLI no padrão dele, que é o certo para quem não pediu nada. Existe porque a
     * escolha é por modelo e não por CLI: o mesmo binário roda um modelo que pensa em degraus e
     * outro que não, e o degrau muda custo e latência de cada passo — numa tarefa de navegador, que
     * é uma chamada por passo, isso é a diferença entre dez segundos e um minuto.
     */
    variant: string;
  }) => string[];
  /** A linha crua do `--format json` traduzida, ou nada quando ela não interessa. */
  read: (line: string) => CliEvent | undefined;
  /**
   * Como este CLI lista os modelos da própria conta.
   *
   * Ausente é uma resposta, não uma lacuna: um CLI cujo comando de listagem não foi medido diz que
   * não sabe listar, e o serviço diz isso a quem perguntou, em vez de oferecer uma lista inventada.
   * O que sai daqui alimenta o seletor de modelo do painel e o catálogo do runtime.
   */
  models?: { args: string[]; parse: (stdout: string) => string[] };
};

/**
 * O que o CLI lê como config do projeto.
 *
 * Duas decisões que não são estilo:
 *
 * `webfetch` e `websearch` são NEGADOS. O navegador do Bot chega por MCP, e cada uso passa pelo
 * gateway — política, guarda de destino, linha de auditoria. A busca embutida do CLI não passa por
 * nada disso: usá-la seria ler a web por fora do registro, que é o defeito que este fork inteiro
 * existe para não ter. Quem nega é a config do CLI, e não a instrução, porque instrução o modelo
 * pode ignorar.
 *
 * O resto fica permitido: ler, editar e rodar comandos no workspace é o que faz um relatório virar
 * arquivo, e negar isso deixaria o CLI com metade das mãos.
 */
export function cliConfig(options: {
  mcpPath: string;
  environment: Record<string, string>;
  schema: string;
}): Record<string, unknown> {
  return {
    $schema: options.schema,
    mcp: {
      openbot: {
        type: "local",
        command: ["bun", options.mcpPath],
        // A declaração assinada vale para UM turno, então as credenciais vão no config escrito a
        // cada turno, e não no ambiente do serviço — que sobrevive a todos eles.
        environment: options.environment,
        enabled: true,
      },
    },
    permission: {
      webfetch: "deny",
      websearch: "deny",
    },
  };
}

/** O leitor de eventos compartilhado pelos dois CLIs: mesmo formato, é o mesmo tronco. */
export function readOpencodeEvent(line: string): CliEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Nem toda linha é JSON: o CLI também escreve avisos soltos. Ignorar é o certo — derrubar o
    // turno por causa de uma linha de log seria perder a tarefa por ruído.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const event = parsed as Record<string, unknown>;

  if (event.type === "error") {
    return {
      kind: "failure",
      message: failureMessage(event.error) ?? "erro sem mensagem",
    };
  }

  const part = event.part;
  if (!part || typeof part !== "object") return undefined;
  const body = part as Record<string, unknown>;

  if (event.type === "text" && typeof body.text === "string" && body.text) {
    return { kind: "text", text: body.text };
  }

  if (event.type === "tool_use" && typeof body.tool === "string") {
    return { kind: "tool", name: body.tool };
  }

  return undefined;
}

/** O erro do CLI vem embrulhado; a mensagem útil está dentro, e às vezes só o nome está. */
function failureMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const entry = error as Record<string, unknown>;
  const data = entry.data;
  if (data && typeof data === "object") {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  return typeof entry.name === "string" && entry.name ? entry.name : undefined;
}

export const OPENCODE: CliAdapter = {
  id: "opencode",
  binary: "opencode",
  configPath: "opencode.json",
  args: ({ prompt, workspace, model, variant }) => [
    "run",
    "--format",
    "json",
    // Sem isto, toda permissão que não seja explicitamente negada vira uma pergunta — e num turno
    // sem ninguém na frente a pergunta é uma parede.
    "--auto",
    "--dir",
    workspace,
    ...(model ? ["-m", model] : []),
    // O degrau de raciocínio, quando o deployment escolheu um. Antes do prompt: depois dele o CLI
    // lê como parte da mensagem.
    ...(variant ? ["--variant", variant] : []),
    prompt,
  ],
  read: readOpencodeEvent,
  /*
   * `opencode models` imprime uma linha por modelo da conta, no formato `provedor/modelo` — medido
   * contra a assinatura, não deduzido. O MiMo não tem o campo: o comando dele não foi medido, e
   * inventar um seria pior que dizer que não sei listar.
   */
  models: {
    args: ["models"],
    parse: (stdout) =>
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
  },
};

export const MIMO: CliAdapter = {
  id: "mimo",
  binary: "mimo",
  // O fork guardou o formato e trocou os nomes: `.mimocode/mimocode.jsonc` é onde ele lê a config
  // do projeto, e a auto-aprovação se chama `--yolo`.
  configPath: ".mimocode/mimocode.jsonc",
  args: ({ prompt, workspace, model, variant }) => [
    "run",
    "--format",
    "json",
    "--yolo",
    "--dir",
    workspace,
    ...(model ? ["-m", model] : []),
    ...(variant ? ["--variant", variant] : []),
    prompt,
  ],
  read: readOpencodeEvent,
};

const ADAPTERS: CliAdapter[] = [OPENCODE, MIMO];

/**
 * O adaptador pedido, ou uma recusa que diz o que existe.
 *
 * Falhar aqui é melhor que falhar no primeiro turno: um `AGENT_CLI` errado é descoberto no deploy,
 * não quando alguém pede uma tarefa e recebe um erro de binário não encontrado.
 */
export function adapterFor(id: string): CliAdapter {
  const name = id.trim().toLowerCase();
  const adapter = ADAPTERS.find((entry) => entry.id === name);
  if (!adapter) {
    throw new Error(
      `CLI desconhecido: "${id}". Os que este serviço sabe dirigir: ${ADAPTERS.map(
        (entry) => entry.id,
      ).join(", ")}.`,
    );
  }
  return adapter;
}

export function knownAdapters(): string[] {
  return ADAPTERS.map((entry) => entry.id);
}
