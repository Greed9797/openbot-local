#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
/**
 * Um CLI de agente como Bot, atrás do mesmo contrato do serviço do Codex.
 *
 * O runtime entrega a tarefa inteira por AG-UI e este processo a repassa ao CLI escolhido em
 * `AGENT_CLI` — OpenCode, MiMo Code, ou outro que venha a ter o mesmo tronco. O navegador do Bot
 * chega ao CLI como servidor MCP (`shared/mcp-computer.ts`), então cada página aberta continua
 * passando pelo gateway: política, guarda de destino e linha de auditoria, exatamente como quando
 * quem dirige é o laço do runtime.
 *
 * Duas coisas NÃO moram aqui, de propósito:
 *
 * - o modelo. Quem escolhe é o CLI, com a conta dele (`opencode auth`, `mimo providers`), e o
 *   deployment não guarda chave de fornecedor nenhum para este caminho. É o que permite usar um
 *   plano já pago — ou um modelo gratuito — sem passar pelo caixa do fornecedor da vez.
 * - a política. O CLI não decide o que pode: quem decide é o gateway, do outro lado de cada
 *   chamada de ferramenta, e é por isso que as ferramentas dele vêm por MCP em vez de um navegador
 *   próprio.
 */
import { serve } from "bun";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { SYSTEM_PROMPT } from "../../shared/bot-prompt";
import { adapterFor, type CliEvent, cliConfig, knownAdapters } from "./cli";

const PORT = Number(process.env.PORT ?? 4210);
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim() ?? "";

/** Qual CLI este processo dirige. Um por serviço: quem quiser dois sobe dois. */
const CLI = (process.env.AGENT_CLI?.trim() || "opencode").toLowerCase();
const MODEL = process.env.AGENT_CLI_MODEL?.trim() ?? "";

/**
 * O degrau de raciocínio, repassado ao CLI sem interpretação.
 *
 * O serviço não sabe quais degraus existem — isso é do fornecedor do modelo, e muda com ele. Só
 * repassa o que o deployment escreveu; vazio deixa o CLI no padrão dele.
 */
const VARIANT = process.env.AGENT_CLI_VARIANT?.trim() ?? "";

/**
 * O diretório de trabalho do CLI, e o único lugar onde ele escreve.
 *
 * É volume no compose: o que o Bot baixar ou gerar num turno está lá no próximo, e é de onde a
 * pessoa recolhe o arquivo.
 */
const WORKSPACE = process.env.AGENT_CLI_WORKSPACE?.trim() || "/workspace";

/** Onde vive o servidor MCP que empresta o navegador ao CLI. */
const MCP_SERVER_PATH =
  process.env.OPENBOT_MCP_PATH?.trim() || "/app/shared/mcp-computer.ts";

const TURN_TIMEOUT_MS = Number(
  process.env.AGENT_CLI_TURN_TIMEOUT_MS ?? 900_000,
);

/**
 * Se o CLI pode dirigir o navegador do Bot.
 *
 * Ligado quando existe um token de agente para apresentar. Sem ele toda chamada seria recusada, e um
 * Bot que anuncia ferramentas e falha em todas é pior do que um que não as anuncia.
 */
const COMPUTER_TOOLS = Boolean(process.env.OPENBOT_AGENT_TOKEN?.trim());

const API = process.env.OPENBOT_API_URL?.trim() || "http://openbot:3001";

/**
 * A conta do CLI, entregue por segredo e nunca assada na imagem.
 *
 * Vem em base64 e vira o arquivo de credencial do CLI no `HOME` do volume. É o caminho para um
 * deployment que usa o plano já pago da pessoa (o "OpenCode Go", por exemplo) sem guardar chave de
 * fornecedor no runtime: quem guarda é o CLI, no formato dele, e o que este serviço faz é escrever o
 * arquivo que ele mesmo escreveria.
 *
 * O valor nunca é impresso, nem em erro. Um `console.log` de depuração aqui vazaria a conta inteira
 * para o log, que é para sempre.
 */
const AUTH_JSON = process.env.AGENT_CLI_AUTH_JSON?.trim() ?? "";

const AUTH_PATH =
  process.env.AGENT_CLI_AUTH_PATH?.trim() ||
  (CLI === "mimo" ? "mimocode/auth.json" : "opencode/auth.json");

async function instalarCredencial(): Promise<void> {
  if (!AUTH_JSON) return;
  const target = join(
    process.env.HOME?.trim() || "/state/home",
    ".local",
    "share",
    AUTH_PATH,
  );
  const decoded = Buffer.from(AUTH_JSON, "base64").toString("utf8");
  try {
    JSON.parse(decoded);
  } catch {
    throw new Error(
      "AGENT_CLI_AUTH_JSON não é base64 de um JSON válido: a credencial do CLI não foi escrita.",
    );
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, decoded, { encoding: "utf8", mode: 0o600 });
  console.info(`credencial do ${CLI} instalada em ${target}`);
}

/** A declaração assinada de quem é esta execução. Opaca aqui: só o servidor sabe abrir. */
function runAssertionOf(input: RunAgentInput): string {
  const props = input.forwardedProps as { openbotRun?: unknown } | undefined;
  return typeof props?.openbotRun === "string" ? props.openbotRun : "";
}

/**
 * O modelo que este turno pediu, quando pediu um.
 *
 * O padrão continua sendo o do serviço (`AGENT_CLI_MODEL`): uma tarefa que não escolheu modelo
 * roda com o que o deployment configurou. Isto existe porque a escolha é do Bot, e o Bot é dado do
 * runtime — que a manda por aqui, no mesmo canal da declaração de execução.
 */
function modeloDoTurno(input: RunAgentInput): string {
  const props = input.forwardedProps as { model?: unknown } | undefined;
  return typeof props?.model === "string" && props.model.trim()
    ? props.model.trim()
    : "";
}

/** A pergunta deste turno: a última mensagem da pessoa, que é como o runtime entrega a tarefa. */
export function perguntaDoTurno(input: RunAgentInput): string {
  const ultima = [...(input.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  return String(ultima?.content ?? "");
}

/**
 * O que o CLI lê como instruções do projeto.
 *
 * As mesmas regras que o Codex recebe, porque o problema é o mesmo: um modelo com ferramentas de
 * navegador precisa saber que elas existem, que a ordem é snapshot-antes-de-agir, e que senha e
 * captcha são pedidos a uma pessoa — nunca adivinhados nem pedidos por chat.
 */
function instructions(): string {
  return [
    SYSTEM_PROMPT,
    "",
    "## Ferramentas deste ambiente",
    "",
    "O navegador do Bot chega pelas ferramentas MCP do servidor `openbot` (os nomes começam com",
    "`openbot_`). Use-as para abrir, ler, clicar, digitar e capturar tela. Buscar página por fora",
    "delas é recusado pela configuração deste projeto, de propósito: só o caminho pelo MCP passa",
    "pela política e pela auditoria do deployment.",
    "",
    "Para baixar ou gerar arquivos, escreva no diretório de trabalho — é o que a pessoa recebe.",
  ].join("\n");
}

/**
 * Escreve o que o CLI precisa para este turno: o config do projeto e as instruções.
 *
 * O config carrega a declaração assinada, que vale para UM turno. Por isso ele é reescrito a cada
 * vez, em vez de ficar no ambiente do serviço, que sobrevive a todos eles.
 */
async function prepararTurno(
  adapterId: string,
  assertion: string,
): Promise<{ configPath: string; instructionsPath: string }> {
  const adapter = adapterFor(adapterId);
  const configPath = join(WORKSPACE, adapter.configPath);
  const instructionsPath = join(WORKSPACE, "AGENTS.md");

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      cliConfig({
        mcpPath: MCP_SERVER_PATH,
        schema:
          adapter.id === "mimo"
            ? "https://mimo.xiaomi.com/config.json"
            : "https://opencode.ai/config.json",
        environment: {
          OPENBOT_AGENT_TOKEN: process.env.OPENBOT_AGENT_TOKEN?.trim() ?? "",
          OPENBOT_API_URL: API,
          OPENBOT_RUN: assertion,
          /*
           * `self`, e não um id: este processo não sabe qual Bot está executando e não precisa
           * saber — a declaração diz, e foi o deployment que a assinou.
           */
          OPENBOT_BOT_ID: "self",
        },
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(instructionsPath, `${instructions()}\n`, "utf8");
  return { configPath, instructionsPath };
}

type TurnResult = {
  exitCode: number;
  toolCalls: number;
  failure: string;
  answered: boolean;
};

/** Uma passagem do CLI: nasce, transmite e é recolhida aqui. */
async function executarPassagem(
  adapterId: string,
  prompt: string,
  say: (text: string) => void,
  abort: AbortSignal,
  model = "",
): Promise<TurnResult> {
  const adapter = adapterFor(adapterId);
  const child = Bun.spawn(
    [
      adapter.binary,
      ...adapter.args({
        prompt,
        workspace: WORKSPACE,
        // O modelo da tarefa quando ela escolheu um; o do serviço quando não.
        model: model || MODEL,
        variant: VARIANT,
      }),
    ],
    {
      cwd: WORKSPACE,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    },
  );

  let toolCalls = 0;
  let answered = false;
  let failure = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, TURN_TIMEOUT_MS);
  const onAbort = () => child.kill();
  abort.addEventListener("abort", onAbort, { once: true });

  /** As últimas linhas do stderr: é onde o CLI diz por que não conseguiu começar. */
  let stderrTail = "";
  const drain = (async () => {
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      stderrTail += new TextDecoder().decode(chunk);
      if (stderrTail.length > 4_000) stderrTail = stderrTail.slice(-4_000);
    }
  })().catch(() => {});

  try {
    let buffer = "";
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const event: CliEvent | undefined = adapter.read(trimmed);
        if (!event) continue;
        if (event.kind === "text") {
          answered = true;
          say(event.text);
        } else if (event.kind === "tool") {
          toolCalls += 1;
        } else {
          failure = event.message;
        }
      }
    }

    const exitCode = await child.exited;
    await drain;

    if (timedOut) {
      failure = `O CLI não terminou em ${Math.round(TURN_TIMEOUT_MS / 1000)}s e o turno foi encerrado.`;
    } else if (exitCode !== 0 && !failure) {
      const tail = stderrTail.trim().split("\n").slice(-3).join(" ").trim();
      failure = `O ${adapter.binary} terminou com código ${exitCode}.${tail ? ` ${tail}` : ""}`;
    }

    return { exitCode, toolCalls, failure, answered };
  } finally {
    clearTimeout(timer);
    abort.removeEventListener("abort", onAbort);
    if (child.exitCode === null) child.kill();
  }
}

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
       * `CUSTOM` e não comentário SSE: comentário é engolido pelo runtime, que consome este fluxo e
       * reemite o próprio para o navegador — os bytes paravam aqui e quem morria era a conexão de
       * fora. O `idleTimeout` do Bun tem teto de 255 segundos e um turno de CLI passa disso com
       * folga.
       */
      const heartbeat = setInterval(() => {
        send({ type: "CUSTOM", name: "heartbeat", value: {} } as BaseEvent);
      }, 20_000);

      const abort = new AbortController();
      const messageId = `msg_${input.runId}`;
      let textOpen = false;
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

      let failure: string | null = null;
      // Quantas ferramentas o turno usou, somando as passagens de autocorreção. O runtime não vê o
      // CLI por dentro: sem isto, um turno que dirigiu o navegador chega lá com zero ferramentas, e
      // "o Bot usou mesmo as ferramentas?" — a pergunta que este fork inteiro existe para responder —
      // volta a ser opinião.
      let toolCalls = 0;

      try {
        const assertion = runAssertionOf(input);
        console.info(
          `turno ${input.runId}: CLI ${CLI}, declaração de execução ${
            assertion
              ? `presente (${assertion.length} caracteres)`
              : "AUSENTE — sem ferramentas"
          }`,
        );
        await prepararTurno(CLI, assertion);

        const pergunta = perguntaDoTurno(input);
        if (!pergunta.trim()) {
          throw new Error("O turno chegou sem pergunta.");
        }

        const modelo = modeloDoTurno(input);
        if (modelo) {
          console.info(
            `turno ${input.runId}: modelo escolhido pela tarefa — ${modelo}`,
          );
        }

        const resultado = await executarPassagem(
          CLI,
          pergunta,
          say,
          abort.signal,
          modelo,
        );
        toolCalls += resultado.toolCalls;

        if (resultado.failure) {
          failure = resultado.failure;
        } else if (!resultado.answered) {
          // O CLI terminou em paz e sem dizer nada: isso é um fato sobre o turno, e quem lê merece
          // a frase em vez do silêncio.
          say(
            resultado.toolCalls > 0
              ? "O CLI usou as ferramentas e terminou sem resposta em texto."
              : "O CLI terminou o turno sem dizer nada.",
          );
        }
      } catch (error) {
        failure =
          error instanceof Error ? error.message : "The Bot could not answer.";
      } finally {
        clearInterval(heartbeat);

        if (textOpen) {
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        }

        if (failure) {
          send({ type: "RUN_ERROR", message: failure } as BaseEvent);
        } else {
          send({
            type: "CUSTOM",
            name: "openbot.tools",
            value: { count: toolCalls },
          } as BaseEvent);
          send({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
        }

        closed = true;
        try {
          controller.close();
        } catch {
          /* O consumidor foi embora. */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * O probe de boot: o CLI vai ter um navegador?
 *
 * Sobe o servidor MCP com credenciais de mentira e conta as ferramentas que ele anuncia. Responder
 * "ok" sem isto faria o healthcheck passar num serviço que só sabe conversar — a assinatura de todo
 * defeito sério deste fork.
 */
async function conferirFerramentas(): Promise<number> {
  const child = Bun.spawn(["bun", MCP_SERVER_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: {
      ...process.env,
      OPENBOT_AGENT_TOKEN: "probe",
      OPENBOT_RUN: "probe",
      OPENBOT_BOT_ID: "self",
    },
  });

  const handshake = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]
    .map((message) => `${JSON.stringify(message)}\n`)
    .join("");
  child.stdin.write(handshake);
  child.stdin.end();

  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const output = await new Response(child.stdout).text();
    return output.split('"name"').length - 1;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

/**
 * Os modelos que a conta do CLI tem, para o painel poder escolher um.
 *
 * Cacheado porque isso muda na escala da conta, não na escala do turno, e porque o runtime pergunta
 * no boot enquanto a tela pergunta a cada abertura. O que falhou é dito como falha — lista vazia
 * com motivo —, nunca uma lista inventada.
 */
let cacheDeModelos: { at: number; models: string[]; error: string } | null =
  null;
const MODELOS_TTL_MS = 60_000;

async function listarModelos(): Promise<{
  supported: boolean;
  models: string[];
  error: string;
}> {
  const adapter = adapterFor(CLI);
  if (!adapter.models) return { supported: false, models: [], error: "" };
  const parsed = adapter.models.parse;

  if (cacheDeModelos && Date.now() - cacheDeModelos.at < MODELOS_TTL_MS) {
    return {
      supported: true,
      models: cacheDeModelos.models,
      error: cacheDeModelos.error,
    };
  }

  const child = Bun.spawn([adapter.binary, ...adapter.models.args], {
    cwd: WORKSPACE,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    /*
     * `child.exited` e não `child.exitCode`: o fim do fluxo de saída chega antes de o runtime anotar
     * o código, então ler a propriedade logo depois de drenar os fluxos devolve `null` — e um
     * `null` tratado como "saiu diferente de zero" faz uma listagem que deu certo parecer falha.
     * Medido: o `/models` respondia `o CLI saiu com null` com a lista cheia do lado de fora.
     */
    const [stdout, stderr, codigo] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const ok = codigo === 0;
    const models = ok ? parsed(stdout) : [];
    const error = ok ? "" : stderr.trim() || `o CLI saiu com ${codigo}`;
    cacheDeModelos = { at: Date.now(), models, error };
    return { supported: true, models, error };
  } catch (error) {
    return { supported: true, models: [], error: String(error) };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

if (import.meta.main) {
  /*
   * Antes de servir: o primeiro turno pode chegar a qualquer instante, e um turno que chega antes da
   * credencial existe falha com "not logged in" — que parece problema de conta e é problema de
   * ordem.
   */
  await instalarCredencial();

  let toolsReady: boolean | null = COMPUTER_TOOLS ? null : false;

  serve({
    port: PORT,
    // Turnos de CLI são longos. O padrão fecharia a conexão com o Bot ainda trabalhando.
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        const ready = COMPUTER_TOOLS ? toolsReady : null;
        const sick = COMPUTER_TOOLS && ready !== true;
        return Response.json(
          {
            status: sick
              ? ready === null
                ? "conferindo as ferramentas"
                : "sem ferramentas"
              : "ok",
            cli: CLI,
            model: MODEL || `${CLI} default`,
            variant: VARIANT || "padrão do CLI",
            ferramentas: ready,
          },
          { status: sick ? 503 : 200 },
        );
      }

      if (url.pathname === "/models") {
        /*
         * Mesmo token do turno, e não aberto como o `/health`: a lista diz qual assinatura está
         * ligada e quais modelos ela tem, que é informação de quem opera o deployment, não de quem
         * alcança a porta.
         */
        if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }
        const lista = await listarModelos();
        return Response.json({
          cli: CLI,
          current: MODEL || null,
          supported: lista.supported,
          models: lista.models,
          ...(lista.error ? { error: lista.error } : {}),
        });
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

  console.info(
    `agent-cli (${CLI}) listening on http://localhost:${PORT}/ag-ui — CLIs: ${knownAdapters().join(", ")}`,
  );

  if (COMPUTER_TOOLS) {
    void conferirFerramentas()
      .then((count) => {
        toolsReady = count > 0;
        console.info(
          toolsReady
            ? `o servidor MCP anunciou ${count} ferramentas`
            : "o servidor MCP não anunciou ferramenta nenhuma",
        );
      })
      .catch((error: unknown) => {
        toolsReady = false;
        console.warn(
          `Não foi possível conferir as ferramentas: ${String(error)}`,
        );
      });
  }
}
