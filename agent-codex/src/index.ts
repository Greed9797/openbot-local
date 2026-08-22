import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { serve } from "bun";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";

/**
 * A Bot whose model is the Codex CLI running on this machine.
 *
 * Every other Bot in this repository reaches a model over HTTP with an API key. This one does not:
 * it runs `codex exec` as a child process, which authenticates with the ChatGPT subscription already
 * signed in on this host. That is the only way a subscription can drive a deployment at all — there
 * is no base URL that accepts it — and it is why this file speaks a subprocess rather than an SDK.
 *
 * O navegador do Bot chega ao Codex como um servidor MCP — ver mcp-computer.ts. Abrir uma página,
 * mapear, clicar e digitar passam pelas rotas do deployment, então cada uma é julgada pela política
 * de `/admin/boundaries` e vira linha em `/admin/audit`, e a pessoa vê a tela enquanto acontece.
 *
 * O que continua fora disso é o que o Codex faz no próprio sandbox: os comandos de shell e as
 * escritas em `/workspace` são governados pelas flags de sandbox abaixo e registrados pelo Codex,
 * não pelo gateway. Duas fronteiras, não uma, e vale saber qual é qual.
 */

const PORT = Number.parseInt(process.env.PORT ?? "4202", 10);

const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) {
  console.error(
    "MANAGED_AGENT_TOKEN is not set. This process drives a signed-in Codex session and will not start without a token for OpenBot's server.",
  );
  process.exit(1);
}

const CODEX_BIN = process.env.CODEX_BIN?.trim() || "codex";

/**
 * Where Codex reads its credential and its configuration.
 *
 * Isolated on purpose. Pointed at a person's own `~/.codex` this Bot inherits their `AGENTS.md`,
 * their profiles and every skill they have installed — which is how a "say ok" turn came back as a
 * routing table and an "exceeded skills context budget" error during development. A deployment Bot
 * gets a directory holding its own `auth.json` and nothing else.
 */
const CODEX_HOME = process.env.CODEX_HOME?.trim() || "/state/codex-home";

/** The directory Codex treats as its working root, and the only place it may write. */
const WORKSPACE = process.env.CODEX_WORKSPACE?.trim() || "/workspace";

/** Where the AG-UI thread to Codex session mapping is kept, so a turn can continue the last one. */
const STATE_DIR = process.env.CODEX_STATE_DIR?.trim() || "/state/threads";

/**
 * Onde o deployment atende, visto de dentro deste container.
 *
 * Nome de serviço, não localhost: aqui dentro localhost é este container.
 */
const OPENBOT_API_URL =
  process.env.OPENBOT_API_URL?.trim() || "http://openbot:3001";

/** O caminho do servidor MCP que empresta o computador ao Codex. */
/** A preparação das ferramentas, para o primeiro turno poder esperar por ela. */
let preparação: Promise<void> | null = null;

const MCP_SERVER_PATH =
  process.env.OPENBOT_MCP_PATH?.trim() ||
  "/app/agent-codex/src/mcp-computer.ts";

/**
 * Se o Codex pode dirigir o navegador do Bot.
 *
 * Ligado quando existe um token de agente para apresentar. Sem ele toda chamada seria recusada, e um
 * Bot que anuncia sete ferramentas e falha em todas é pior do que um que não as anuncia.
 */
const COMPUTER_TOOLS = Boolean(process.env.OPENBOT_AGENT_TOKEN?.trim());

/**
 * Quantas trocas anteriores vão no prompt quando não há sessão para retomar.
 *
 * ponytail: uma janela fixa, não um resumo. Resumir exigiria outra chamada de modelo por turno para
 * economizar tokens numa conversa que quase nunca é longa. Se as conversas aqui virarem longas, é
 * aqui que entra um resumo.
 */
const HISTORY_TURNS = 6;

const MODEL = process.env.CODEX_MODEL?.trim() || "";
const EFFORT = process.env.CODEX_EFFORT?.trim() || "";

/**
 * How much Codex may do without being asked.
 *
 * `workspace-write` is the working default and the one this is set to. `read-only` is the honest
 * choice for a Bot that should only answer questions. `danger-full-access` is never set here: a
 * process reachable from a chat box must not be able to write outside its workspace.
 */
const SANDBOX = process.env.CODEX_SANDBOX?.trim() || "workspace-write";

if (SANDBOX === "danger-full-access") {
  console.error(
    "CODEX_SANDBOX=danger-full-access is refused. This Bot takes instructions from a chat box; it does not get the whole machine.",
  );
  process.exit(1);
}

/**
 * How long one turn may take before it is abandoned, in milliseconds.
 *
 * Codex working through a real task is slow in a way a chat completion is not, so this is generous.
 * It exists because the alternative to a timeout is a child process that never exits holding a
 * connection nobody is reading any more.
 */
const TURN_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_TURN_TIMEOUT_MS ?? "900000",
  10,
);

/*
 * The thread map.
 *
 * AG-UI names a conversation; Codex names a session; `codex exec resume <session>` is what makes a
 * second turn continue the first instead of starting over with no memory of the files it just
 * touched. One small file per thread, rather than a database, because this process owns exactly one
 * fact per conversation and a directory on the same volume as the workspace is enough to hold it.
 */
function sessionPath(threadId: string): string {
  // Thread ids arrive from the server, but they still address the filesystem here, so anything that
  // is not plainly a name is replaced rather than trusted.
  return join(STATE_DIR, `${threadId.replace(/[^a-zA-Z0-9_-]/g, "_")}.session`);
}

async function readSession(threadId: string): Promise<string | null> {
  try {
    const value = (await readFile(sessionPath(threadId), "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function writeSession(threadId: string, session: string): Promise<void> {
  const target = sessionPath(threadId);
  const temporary = `${target}.${process.pid}.tmp`;
  // Written aside and renamed so a process killed mid-write leaves the previous session id intact
  // rather than a truncated one, which would silently start the next turn from nothing.
  await writeFile(temporary, session, "utf8");
  await rename(temporary, target);
}

/**
 * A regra que separa ler uma página de lembrar dela.
 *
 * Medido, e não suposto: o mesmo pedido — "abra este endereço e me diga o título" — feito três
 * vezes, chamou a ferramenta uma vez. Nas outras duas o modelo respondeu de cabeça e apresentou a
 * resposta do mesmo jeito, com "Fonte:" e um link, como se tivesse aberto. Para um Bot cujo trabalho
 * é dirigir um navegador, isso é pior do que não responder: quem lê não tem como distinguir a
 * resposta lida da lembrada, e a página pode ter mudado ou nunca ter dito aquilo.
 *
 * Vale só quando existem ferramentas. Sem elas a regra mandaria o Bot recusar tudo o que sabe.
 */
const REGRA_DE_LEITURA = [
  "Sobre conteúdo de páginas da web:",
  "- Se a pergunta é sobre o que uma página, um endereço ou um site diz, use as ferramentas para abri-la nesta execução. Não responda de memória.",
  "- Nunca escreva 'Fonte:', nem cite um endereço como se o tivesse consultado, sem ter aberto ele agora com uma ferramenta.",
  "- Se as ferramentas não estiverem disponíveis ou recusarem, diga isso na resposta em vez de responder assim mesmo.",
].join("\n");

/** Um endereço de página no que a pessoa escreveu. */
const ENDEREÇO =
  /\bhttps?:\/\/\S+|\b[\w-]+\.(com|com\.br|org|net|io|dev|gov|edu)\b/i;

/**
 * O aviso que separa uma resposta lida de uma lembrada.
 *
 * Medido: pedir três vezes o valor de https://httpbin.org/uuid — que muda a cada leitura — devolveu
 * o MESMO valor nas três, e nenhuma chamada de ferramenta foi registrada. O Bot não abriu nada e
 * inventou. Antes disso, o mesmo pedido sobre uma página conhecida devolveu o título certo com
 * "Fonte:" e um link, também sem abrir: a resposta lembrada sai idêntica à lida, e é justamente por
 * isso que quem lê não tem como se defender dela.
 *
 * A regra no prompt ajudou e não resolveu — o modelo é quem decide chamar a ferramenta. Isto não
 * tenta decidir por ele: apenas conta o que aconteceu no turno e diz. Um aviso honesto vale mais que
 * uma tentativa de convencimento que funciona em dois turnos de três.
 */
/** Os endereços que aparecem num texto, reduzidos ao host e sem `www.`. */
export function hostsEm(texto: string): string[] {
  const achados = texto.match(
    /\bhttps?:\/\/[^\s)"'<>]+|\b[\w-]+\.(?:com\.br|com|org|net|io|dev|gov|edu)\b/gi,
  );
  if (!achados) return [];
  return [
    ...new Set(
      achados.map((bruto) => {
        const comEsquema = bruto.startsWith("http")
          ? bruto
          : `https://${bruto}`;
        try {
          return new URL(comEsquema).hostname
            .replace(/^www\./, "")
            .toLowerCase();
        } catch {
          return bruto.toLowerCase();
        }
      }),
    ),
  ];
}

/**
 * O aviso de quando o Bot abriu página, mas não a que foi pedida.
 *
 * O aviso de "nenhuma página foi aberta" não alcança este caso — uma página FOI aberta, o contador
 * de ações sobe, e a resposta sai com a confiança de quem leu. Foi exatamente assim que, perguntado
 * pelo site da W3bsite, o Bot abriu um domínio parecido, caiu numa página de venda e respondeu o
 * título dela.
 *
 * Conservador de propósito: só fala quando o pedido trazia endereço, o Bot abriu alguma coisa, e
 * NENHUM dos endereços abertos bate com nenhum dos pedidos. Ter aberto ao menos um dos pedidos basta
 * para calar — um Bot que abre a página certa e mais duas não errou nada.
 */
export function avisoDeOutraPagina(
  pergunta: string,
  abertos: string[],
): string {
  const pedidos = hostsEm(pergunta);
  if (pedidos.length === 0 || abertos.length === 0) return "";
  if (abertos.some((aberto) => pedidos.includes(aberto))) return "";
  return `\n\n---\n_Atenção: o pedido falava de ${pedidos.join(", ")}, e o que foi aberto neste turno foi ${abertos.join(", ")}._`;
}

export function perguntaDoTurno(input: RunAgentInput): string {
  const ultima = [...(input.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  return String(ultima?.content ?? "");
}

export function avisoDeNaoLeitura(
  pergunta: string,
  usouFerramenta: boolean,
): string {
  if (usouFerramenta || !ENDEREÇO.test(pergunta)) return "";
  return "\n\n---\n_Nenhuma página foi aberta neste turno: a resposta acima vem do que o modelo já sabia, não do endereço citado._";
}

/**
 * What to say to Codex this turn.
 *
 * On a resumed session, only the newest user message: Codex is holding the rest itself, and
 * replaying the transcript would both cost the subscription twice and confuse a model that already
 * remembers saying it. On a fresh session the standing role arrives first, because that is the only
 * statement of what this coworker is for.
 */
export function turnPrompt(
  input: RunAgentInput,
  resuming: boolean,
  /** Parâmetro em vez de ler o ambiente direto, para o teste poder exercitar os dois lados. */
  comFerramentas: boolean = COMPUTER_TOOLS,
): string {
  const messages = input.messages ?? [];

  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const userText = String(latestUser?.content ?? "").trim();

  if (resuming) {
    return userText;
  }

  const standing = messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) => String(message.content ?? "").trim())
    .filter((text) => text.length > 0);

  /*
   * Sem sessão para retomar, a conversa vai no prompt.
   *
   * Só as últimas trocas, e não a thread inteira: uma conversa longa recontada por completo a cada
   * turno cresce sem limite e o custo é da assinatura de alguém.
   */
  const history = messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .slice(-HISTORY_TURNS * 2, -1)
    .map((message) => {
      const who = message.role === "user" ? "Pessoa" : "Você";
      return `${who}: ${String(message.content ?? "").trim()}`;
    })
    .filter((line) => line.length > 8);

  const recap =
    history.length > 0
      ? `Conversa até aqui:\n${history.join("\n")}\n\nAgora responda à última mensagem.`
      : "";

  return [
    ...standing,
    ...(comFerramentas ? [REGRA_DE_LEITURA] : []),
    recap,
    userText,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A declaração assinada de que execução é esta.
 *
 * Opaca aqui de propósito: este processo não consegue abrir e não tem por que. Ele a repassa ao
 * servidor MCP, que a devolve ao deployment em cada chamada de ferramenta, e só quem assinou lê o
 * Bot e a pessoa lá dentro. Já foi diferente — o Bot afirmava quem era pelo corpo do pedido —, e
 * então qualquer um com o token podia gastar as concessões de outro Bot e escrever outro nome na
 * auditoria.
 */
function runAssertionOf(input: RunAgentInput): string {
  const props = input.forwardedProps as { openbotRun?: unknown } | undefined;
  return typeof props?.openbotRun === "string" ? props.openbotRun : "";
}

export function codexArguments(
  session: string | null,
  /**
   * As credenciais desta execução, entregues ao servidor MCP.
   *
   * Vão como override por invocação e não no config.toml porque a declaração vale para um turno só,
   * e porque dois turnos ao mesmo tempo reescrevendo o mesmo arquivo se atropelariam. O Codex NÃO
   * repassa o próprio ambiente ao servidor MCP — descoberto com RUST_LOG, onde a única pista era o
   * servidor saindo com "exige OPENBOT_AGENT_TOKEN"; sem `env` aqui ele não sobe e o modelo responde
   * que a ferramenta não está instalada.
   */
  credentials?: Record<string, string>,
): string[] {
  const options = [
    "--json",
    "--skip-git-repo-check",
    /*
     * O SHELL DO BOT NÃO ALCANÇA A INTERNET, e isto é a trava, não a instrução.
     *
     * `AGENTS.md` pede que ele não busque página com `curl`, e medido, ele obedece — mas obedecer é
     * escolha, e a web alcançada por fora do gateway não passa pela política nem aparece no audit.
     * Um Bot que PODE contornar o registro contorna no dia em que o modelo achar que deve.
     *
     * Custa nada em capacidade: o servidor MCP roda FORA do sandbox, então as ferramentas continuam
     * abrindo páginas — verificado listando e chamando com a rede desligada. O que some é só o
     * caminho não governado.
     *
     * Efeito colateral medido: sem rede o modelo às vezes AFIRMA ter rodado o comando e inventa a
     * saída ("Código HTTP: 200"). A trava impede o acesso, não a mentira sobre ele — por isso a
     * resposta também conta o que foi executado de verdade.
     */
    "-c",
    "sandbox_workspace_write.network_access=false",
  ];

  if (MODEL) options.push("--model", MODEL);
  if (EFFORT) options.push("-c", `model_reasoning_effort="${EFFORT}"`);

  for (const [key, value] of Object.entries(credentials ?? {})) {
    /* TOML: as aspas do valor são parte da sintaxe, e um valor sem elas é lido como literal cru. */
    options.push("-c", `mcp_servers.openbot.env.${key}="${value}"`);
  }

  /*
   * Sem isto, toda chamada de ferramenta MCP volta como "MCP tool call requires approval, but
   * approval policy is never" e o Codex termina o turno explicando que não conseguiu — o que na tela
   * parece a ferramenta não existir.
   *
   * Aprovar automaticamente aqui não afrouxa nada: quem decide se a ação vale é o gateway do
   * deployment, do outro lado da chamada, com a política de /admin/boundaries e a linha de auditoria.
   * A aprovação do Codex pergunta se o operador local consente, e neste desenho o operador local é
   * um processo sem ninguém na frente.
   */
  const approving = Object.keys(credentials ?? {}).length > 0;

  /*
   * `resume` takes a smaller set of flags than `exec` does: it accepts neither `--sandbox` nor `-C`,
   * because a resumed session already carries the sandbox policy and working root it was started
   * with. Passing them anyway is not ignored, it is a usage error that exits 2 — which is exactly how
   * every second turn failed until this was split. The first turn is therefore the only place those
   * two are set, and every later turn inherits them from the session.
   */
  /*
   * `--approve-for-me` recusa conviver com `--sandbox`: ele já implica workspace-write, e passar os
   * dois é erro de uso, não um flag ignorado. Também não existe em `resume`, que herda o sandbox da
   * sessão — a mesma assimetria que já derrubava todo segundo turno.
   *
   * Quando o Bot dirige o computador, portanto, quem escolhe o sandbox é a flag de aprovação. Um
   * deployment que peça `read-only` fica sem as ferramentas em vez de ganhar um sandbox mais frouxo
   * do que pediu.
   */
  /*
   * Com ferramentas, nunca retoma.
   *
   * `--approve-for-me` é a única forma de o Codex aprovar uma chamada MCP num `exec` não
   * interativo, e ela existe só no `exec` — nem `resume` nem `fork` a aceitam, e passar mesmo assim
   * é erro de uso com exit 2. Sem ela, toda chamada volta "requires approval". Medido também que
   * não há equivalente em config: `auto_review.enabled`, `always_allow_tools`, `trusted` e
   * `approval_policy="on-failure"` continuam pedindo aprovação.
   *
   * Então continuidade e ferramentas não cabem juntas no CLI de hoje, e as ferramentas ganham: um
   * Bot que abre páginas e esquece a conversa anterior é útil, um que lembra e não consegue abrir
   * nada não é. O que a sessão guardava volta pelo prompt, e o que ele fez em /workspace continua lá,
   * porque aquilo é um volume.
   */
  if (session && !approving) {
    return ["exec", "resume", ...options, session, "-"];
  }
  if (approving && SANDBOX === "workspace-write") {
    return ["exec", ...options, "--approve-for-me", "-C", WORKSPACE, "-"];
  }
  return ["exec", ...options, "--sandbox", SANDBOX, "-C", WORKSPACE, "-"];
}

type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  /** Presente em `mcp_tool_call`. É daqui que sai a página que o Bot realmente pediu para abrir. */
  arguments?: { url?: string };
};

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
};

async function runAgent(input: RunAgentInput): Promise<Response> {
  const encoder = new EventEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      let closed = false;
      const send = (event: BaseEvent) => {
        if (closed) return;
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
      };

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);

      /*
       * Um sinal de vida a cada vinte segundos, enquanto o turno corre.
       *
       * Um evento AG-UI, e não um comentário SSE. Comentário é engolido pelo runtime — que consome
       * este fluxo e reemite o próprio para o navegador —, então os bytes paravam aqui e a conexão
       * que morria era a de fora. `CUSTOM` atravessa e não escreve nada no transcript.
       *
       * O `idleTimeout` do Bun tem teto de 255 segundos, e um turno do Codex que precise pensar, rodar
       * comandos e passar pela revisão automática de aprovação passa disso com folga: a conexão
       * morria com ECONNRESET no meio do trabalho, e o que a pessoa via era a conversa parar sem erro
       * nenhum.
       */
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          send({
            type: "CUSTOM",
            name: "codex.working",
            value: { since: input.runId },
          } as BaseEvent);
        } catch {
          /* O consumidor foi embora. O `finally` abaixo é quem encerra. */
        }
      }, 20_000);

      const messageId = `msg_${input.runId}`;
      let textOpen = false;
      /** True once Codex has actually said something, which decides what a silent turn reports. */
      let answered = false;
      let usouFerramenta = false;
      /** Os hosts que o Bot mandou abrir, para comparar com os que a pessoa pediu. */
      const abertos: string[] = [];
      /** Recoverable problems Codex reported mid-turn. Shown only if nothing else was. */
      const notices: string[] = [];
      const openText = () => {
        if (textOpen) return;
        send({
          type: "TEXT_MESSAGE_START",
          messageId,
          role: "assistant",
        } as BaseEvent);
        textOpen = true;
      };
      const say = (text: string) => {
        openText();
        send({
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: text,
        } as BaseEvent);
      };

      let child: ReturnType<typeof Bun.spawn> | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      let failure: string | null = null;

      try {
        // The image creates all three so the volume inherits them; this is the belt to that pair of
        // braces, for a deployment that mounts a host directory over one of them instead.
        await mkdir(CODEX_HOME, { recursive: true });
        await mkdir(STATE_DIR, { recursive: true });
        await mkdir(WORKSPACE, { recursive: true });

        // Só o primeiro turno chega a esperar; depois disto a promessa já resolveu.
        if (preparação) await preparação;

        const stored = await readSession(input.threadId);
        /*
         * Retomar e usar ferramentas são exclusivos — ver codexArguments. As duas decisões têm de
         * ser a mesma: um prompt que assume sessão retomada manda só a última mensagem, e num `exec`
         * novo isso é o Bot respondendo sem saber do que se falava.
         */
        const session = COMPUTER_TOOLS ? null : stored;
        const prompt = turnPrompt(input, session !== null);

        if (prompt.length === 0) {
          throw new Error(
            "This turn carried no message for the Bot to answer.",
          );
        }

        /*
         * O tamanho, e nunca o valor.
         *
         * A declaração assinada é o que faz o servidor MCP subir: sem ela ele sai no boot e o Codex
         * simplesmente não oferece ferramenta nenhuma, sem erro em lugar nenhum — o Bot responde de
         * memória e a resposta sai igualzinha a uma que foi lida. Uma linha por turno dizendo se ela
         * chegou é a diferença entre ver isso acontecer e ficar adivinhando; o valor fica de fora
         * porque é uma credencial de curta duração, e log é para sempre.
         */
        console.log(
          `turno ${input.runId}: declaração de execução ${
            runAssertionOf(input).length > 0
              ? `presente (${runAssertionOf(input).length} caracteres)`
              : "AUSENTE — o Bot vai ficar sem ferramentas"
          }`,
        );

        child = Bun.spawn(
          [
            CODEX_BIN,
            ...codexArguments(
              session,
              COMPUTER_TOOLS
                ? {
                    OPENBOT_AGENT_TOKEN:
                      process.env.OPENBOT_AGENT_TOKEN?.trim() ?? "",
                    OPENBOT_API_URL,
                    OPENBOT_RUN: runAssertionOf(input),
                    OPENBOT_BOT_ID: "self",
                  }
                : undefined,
            ),
          ],
          {
            stdin: new TextEncoder().encode(prompt),
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              CODEX_HOME,
              /*
               * Lidas pelo servidor MCP, não por este processo. Ficam no ambiente do filho e não em
               * disco, porque valem para esta execução e mais nenhuma.
               */
              OPENBOT_API_URL,
              OPENBOT_RUN: runAssertionOf(input),
              /*
               * `self`, e não um id.
               *
               * Este processo não sabe qual Bot está executando, e não precisa saber: a declaração diz,
               * e foi este deployment que a assinou. Mandar um id daqui só criaria a chance de mandar o
               * errado, que seria um Bot pedindo o computador de outro.
               */
              OPENBOT_BOT_ID: "self",
            },
          },
        );

        timer = setTimeout(() => {
          timedOut = true;
          child?.kill();
        }, TURN_TIMEOUT_MS);

        /*
         * stderr is drained in parallel, not after the process exits.
         *
         * Codex is loud on stderr — MCP transport warnings, OAuth refresh failures, tracing — and a
         * pipe nobody is reading fills up and blocks the writer. Waiting for `exited` before reading
         * it would therefore hang the exact turns that run long enough to produce output, which is
         * every real one. Only the tail is kept, because all this is ever used for is explaining a
         * non-zero exit.
         */
        let stderrTail = "";
        const errors = child.stderr as ReadableStream<Uint8Array>;
        const stderrDrained = (async () => {
          const decoder = new TextDecoder();
          for await (const chunk of errors) {
            stderrTail = (stderrTail + decoder.decode(chunk)).slice(-4000);
          }
        })().catch(() => {
          // A stderr that cannot be read costs the error message and nothing else.
        });

        /*
         * Codex writes one JSON object per line, and also writes lines that are not JSON at all
         * ("Reading additional input from stdin...", and any tracing that lands on stdout). Anything
         * that does not parse is skipped rather than treated as a failure: this reads a tool's
         * output, and a tool is allowed to be chatty.
         */
        let buffer = "";
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          buffer += new TextDecoder().decode(chunk);
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;

            let event: CodexEvent;
            try {
              event = JSON.parse(trimmed) as CodexEvent;
            } catch {
              continue;
            }

            if (event.type === "thread.started" && event.thread_id) {
              // Written as soon as it is known, not at the end: a turn that dies half way has still
              // created a Codex session, and the next turn should continue it rather than orphan the
              // work it did.
              await writeSession(input.threadId, event.thread_id);
              continue;
            }

            if (event.type !== "item.completed" || !event.item) continue;
            const item = event.item;

            /*
             * O Codex reporta uma chamada MCP como um item próprio. Contá-las é a única forma que
             * este processo tem de saber se a resposta que vem a seguir foi lida de uma página ou
             * lembrada — as duas chegam como o mesmo `agent_message`.
             */
            if (item.type === "mcp_tool_call") {
              usouFerramenta = true;
              const alvo = item.arguments?.url;
              if (alvo) abertos.push(...hostsEm(alvo));
            }

            if (item.type === "agent_message" && item.text) {
              answered = true;
              say(item.text);
              continue;
            }

            if (item.type === "error" && item.message) {
              /*
               * Held, not raised, and not written straight into the transcript.
               *
               * Codex emits recoverable problems as items and carries on — the routine one being a
               * notice that its own bundled skill descriptions were truncated, which arrives on
               * every first turn and is not addressed to the person in the chat. Ending the run here
               * would hide the answer that follows; printing it would put vendor housekeeping in
               * front of somebody asking a question. So it goes to the process log always, and into
               * the transcript only if the turn ends with nothing else to show — which is the case
               * where it is the only explanation the person has.
               */
              console.warn(`codex notice (${input.threadId}): ${item.message}`);
              notices.push(item.message);
              continue;
            }

            if (item.type === "command_execution" && item.command) {
              /*
               * Shown because the alternative is a chat window that says nothing for minutes while a
               * Bot works. This is a progress line in the transcript, not an audit record: the
               * record of what Codex ran lives with Codex.
               */
              say(`\n\n\`$ ${item.command}\`\n\n`);
            }
          }
        }

        const exitCode = await child.exited;

        if (timedOut) {
          throw new Error(
            `The Bot was still working after ${Math.round(TURN_TIMEOUT_MS / 1000)}s and the turn was ended.`,
          );
        }

        if (exitCode !== 0) {
          await stderrDrained;
          /*
           * `codex exec` exits 0 even when its sandbox refused every write, so a non-zero code is a
           * genuine failure to launch or authenticate and is worth the last lines of stderr. The
           * silent-success case is the dangerous one, and it is handled by the sandbox flags being
           * correct rather than by anything readable here.
           */
          const tail = stderrTail.trim().split("\n").slice(-3).join(" ");
          throw new Error(`Codex exited with code ${exitCode}. ${tail}`.trim());
        }

        if (!answered) {
          say(
            notices.length > 0
              ? `Codex finished the turn without answering. It reported: ${notices.join(" ")}`
              : "Codex finished the turn without saying anything.",
          );
        } else {
          // Depois da resposta, e só quando a pergunta citava um endereço. Ver `avisoDeNaoLeitura`.
          const aviso = avisoDeNaoLeitura(
            perguntaDoTurno(input),
            usouFerramenta,
          );
          if (aviso) say(aviso);
        }
      } catch (error) {
        failure =
          error instanceof Error ? error.message : "The Bot could not answer.";
      } finally {
        clearInterval(heartbeat);
        if (timer) clearTimeout(timer);
        if (child && child.exitCode === null) child.kill();

        if (textOpen) {
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        }

        if (failure) {
          send({ type: "RUN_ERROR", message: failure } as BaseEvent);
        } else {
          send({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
        }

        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/*
 * Guarded so importing this file does not bind a port. The pure helpers above are unit-tested, and a
 * test run that started a real server would fight for the port with anything else running.
 */
/**
 * Registra o computador como servidor MCP no CODEX_HOME deste Bot.
 *
 * Uma vez, no boot, e não por execução. Tentei primeiro passar `-c mcp_servers.openbot.command=...`
 * em cada turno; o Codex aceitava a flag sem reclamar e não oferecia ferramenta nenhuma ao modelo,
 * que respondia "a ferramenta não está instalada nesta sessão" e seguia sem ela. `codex mcp add` é o
 * caminho que grava no config.toml, que é de onde ele realmente lê.
 *
 * Só o comando vai para o disco. As credenciais continuam no ambiente do processo filho, que o
 * servidor MCP herda, porque valem para uma execução e não para o arquivo.
 */
/**
 * As instruções que o Codex lê como sendo do projeto, e não como uma mensagem de alguém.
 *
 * A mesma regra escrita no prompt do turno não bastou: medido, três pedidos em português natural
 * ("abra este endereço e me diga o título") deram zero chamadas de ferramenta, enquanto um pedido que
 * NOMEAVA a ferramenta funcionou na primeira. O modelo trata o texto do prompt como pedido de uma
 * pessoa, e um pedido não muda como ele decide; `AGENTS.md` no diretório de trabalho é lido como
 * instrução permanente do projeto e pesa muito mais.
 *
 * Escrito no boot, e reescrito toda vez: é conteúdo derivado deste arquivo, não algo que alguém edita
 * no volume. Se ficasse só no volume, um deployment novo subiria sem ele e ninguém notaria — a falha
 * é o Bot responder bem, só que de memória.
 */
export const INSTRUÇÕES_DO_WORKSPACE = `# Como este Bot trabalha

Você é um Bot com navegador próprio. As ferramentas \`mcp__openbot__*\` são o seu navegador:
\`abrir_pagina\`, \`ler_url_rapido\`, \`ler_pagina\`, \`mapear_pagina\`, \`clicar\`, \`digitar\`,
\`tecla\`, \`rolar\`.

## Ler uma página

Quando o pedido mencionar um endereço, um site ou o conteúdo de uma página, **use as ferramentas**.
Não importa se você acha que já sabe a resposta: a página pode ter mudado, e você não tem como saber
se mudou.

- \`ler_url_rapido\` para só ler o texto de um endereço. É o caminho normal.
- \`abrir_pagina\` quando a pessoa precisa ver a página, ou quando você vai clicar e digitar nela.
- Nunca use o shell (\`curl\`, \`wget\`, scripts) para buscar uma página. O shell não passa pela
  política deste deployment e o que ele faz não fica registrado. Se as ferramentas recusarem, diga
  isso; não contorne.
- **O shell deste ambiente não tem internet.** Qualquer \`curl\` ou \`wget\` falha, sempre. Não
  invente a saída de um comando que você não rodou nem afirme um código HTTP que não recebeu — se
  precisar da web, a única porta são as ferramentas acima.

## Quando o pedido não diz o alvo

Se a pessoa não disser QUAL página, arquivo ou assunto ("dá uma olhada lá e me fala o que achou"),
**pergunte qual**. Uma frase curta perguntando o endereço resolve a conversa; prometer uma análise
que você não tem como começar faz a pessoa esperar por algo que não vem.

Nome de marca não é endereço. Se pedirem "o site da Fulana" sem dar a URL, **não adivinhe o
domínio** — pergunte. Medido: perguntado pelo site da W3bsite, o Bot abriu \`w3bsite.com\`, caiu numa
página de venda de domínios e respondeu com o título dela, com confiança. O endereço certo era
\`w3bsite.com.br\`, e a resposta errada foi indistinguível de uma certa.

## O que não fazer

- Não responda sobre o conteúdo de uma página sem ter aberto ela nesta execução.
- Não escreva "Fonte:" nem cite um endereço como consultado se você não o abriu agora.
- Não invente a mensagem de erro de uma ferramenta. Se quiser saber se ela falha, chame-a.
- Não diga que um endereço "não abriu" sem ter tentado abrir com as ferramentas.
`;

/**
 * Tira do caminho o que a conta trouxe junto com a credencial.
 *
 * Entrar com uma assinatura do ChatGPT sincroniza para o `CODEX_HOME` as skills de sistema do CLI e
 * o catálogo de plugins da conta — Canva, Clay, GitHub, Drive, HeyGen e mais uma dúzia, 47 MB. Nada
 * disso serve a um Bot que dirige um navegador, e o custo não é só espaço: medido em bateria, o Bot
 * gastou turno abrindo `/bin/sh` para ler o SKILL.md de um plugin antes de responder a uma pergunta
 * sobre uma página, e a pessoa do outro lado viu isso no lugar da resposta.
 *
 * Apagado a cada boot em vez de uma vez: o CLI ressincroniza quando quer, e um deployment que
 * dependesse de alguém ter limpado o volume à mão voltaria ao ruído sem ninguém entender por quê.
 * Se um dia isto apagar algo necessário, o sintoma é ruidoso — uma ferramenta some — e não silencioso.
 */
async function limparBagagemDaConta(): Promise<void> {
  for (const caminho of [
    `${CODEX_HOME}/plugins/cache`,
    `${CODEX_HOME}/skills/.system`,
  ]) {
    await rm(caminho, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * As ferramentas existem MESMO, ou só foram registradas?
 *
 * `codex mcp add` sair com zero prova que uma linha foi escrita num arquivo de configuração, e nada
 * além disso. O servidor pode não subir — falta de variável, dependência quebrada, caminho errado —
 * e o sintoma é o pior possível: o Codex simplesmente não oferece ferramenta nenhuma, sem erro em
 * lugar nenhum, e o Bot responde de memória com a mesma cara de quem leu a página.
 *
 * Perdi meia hora atrás dessa diferença. O probe fala com o servidor pelo protocolo, do jeito que o
 * Codex falaria, e diz no log quantas ferramentas ele de fato oferece.
 */
async function verificarFerramentas(): Promise<void> {
  const servidor = Bun.spawn(["bun", MCP_SERVER_PATH], {
    env: {
      ...process.env,
      // Valores de fachada: o servidor só precisa deles para não sair no boot. Nenhuma chamada é
      // feita ao gateway aqui, então nada disto é usado para autorizar coisa nenhuma.
      OPENBOT_AGENT_TOKEN: process.env.OPENBOT_AGENT_TOKEN?.trim() || "probe",
      OPENBOT_RUN: "probe-de-boot",
      OPENBOT_BOT_ID: "self",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const pedir = (id: number, method: string) =>
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "boot", version: "1" } } : {} })}\n`;

  servidor.stdin.write(pedir(1, "initialize"));
  servidor.stdin.write(pedir(2, "tools/list"));
  servidor.stdin.flush();

  const prazo = setTimeout(() => servidor.kill(), 10_000);
  const saida = await new Response(servidor.stdout).text();
  clearTimeout(prazo);
  servidor.kill();

  const quantas = (saida.match(/"name":"[a-z_]+"/g) ?? []).length;
  if (quantas === 0) {
    console.warn(
      `O servidor de ferramentas subiu sem oferecer nada. O Bot vai responder sem navegador. stderr: ${(
        await new Response(servidor.stderr).text()
      ).trim()}`,
    );
    return;
  }
  console.info(`Ferramentas de computador conferidas: ${quantas} disponíveis.`);
}

async function registerComputerTools(): Promise<void> {
  await limparBagagemDaConta();

  const add = Bun.spawn(
    [CODEX_BIN, "mcp", "add", "openbot", "--", "bun", MCP_SERVER_PATH],
    { env: { ...process.env, CODEX_HOME }, stdout: "pipe", stderr: "pipe" },
  );

  if ((await add.exited) !== 0) {
    /*
     * Reportado e seguido em frente. Sem as ferramentas o Bot ainda conversa, e derrubar o processo
     * trocaria "este Bot não abre páginas" por "este Bot não existe".
     */
    console.warn(
      `Não foi possível registrar as ferramentas de computador: ${(
        await new Response(add.stderr).text()
      ).trim()}`,
    );
    return;
  }
  await writeFile(`${WORKSPACE}/AGENTS.md`, INSTRUÇÕES_DO_WORKSPACE, "utf8");
  console.info("Ferramentas de computador registradas para o Codex.");
  await verificarFerramentas().catch((erro: unknown) => {
    // Reportado e seguido em frente: o probe é diagnóstico, e derrubar o Bot porque o diagnóstico
    // falhou trocaria "talvez sem ferramentas" por "sem Bot nenhum".
    console.warn(`Não foi possível conferir as ferramentas: ${String(erro)}`);
  });
}

if (import.meta.main) {
  serve({
    port: PORT,
    // Codex turns are long. The default would close the connection while the Bot is still working.
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", model: MODEL || "codex default" });
      }

      if (url.pathname === "/ag-ui" && request.method === "POST") {
        if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }
        const input = (await request.json()) as RunAgentInput;
        return runAgent(input);
      }

      return Response.json({ error: "Not found." }, { status: 404 });
    },
  });

  console.info(`agent-codex listening on http://localhost:${PORT}/ag-ui`);

  /*
   * Começa depois de já estar atendendo, mas o primeiro turno ESPERA por ele.
   *
   * Registrar escreve o `config.toml` e o `AGENTS.md`, e um turno que chegue antes disso roda sem
   * ferramenta nenhuma e sem as instruções — o Bot responde de memória, com a mesma cara de quem
   * leu. Segurar o `serve` atrasaria o healthcheck por um passo que não muda se o Bot responde;
   * guardar a promessa e aguardá-la no turno custa nada depois do primeiro.
   */
  if (COMPUTER_TOOLS) {
    preparação = registerComputerTools().catch((erro: unknown) => {
      // Capturado aqui porque uma promessa solta que rejeita derruba o processo inteiro, e trocar
      // "Bot sem ferramentas" por "Bot que não existe" é o pior dos dois.
      console.warn(`Preparação das ferramentas falhou: ${String(erro)}`);
    });
  }
}
