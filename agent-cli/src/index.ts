#!/usr/bin/env bun
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
/**
 * O OpenCode como Bot, atrás do mesmo contrato do serviço do Codex.
 *
 * O runtime entrega a tarefa inteira por AG-UI e este processo a repassa ao OpenCode — o mesmo que
 * você já usa no terminal, com a conta que você já paga. O navegador do Bot chega ao CLI como
 * servidor MCP (`shared/mcp-computer.ts`), então cada página aberta continua passando pelo
 * gateway: política, guarda de destino e linha de auditoria, exatamente como quando quem dirige é
 * o laço do runtime.
 *
 * Duas coisas NÃO moram aqui, de propósito:
 *
 * - o modelo. Quem escolhe é o CLI, com a conta dele (`opencode auth`), e o deployment não guarda
 *   chave de fornecedor nenhum para este caminho. É o que permite usar um plano já pago — ou um
 *   modelo gratuito — sem passar pelo caixa do fornecedor da vez.
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

/** O CLI que este processo dirige. Só o OpenCode; outro valor recusa no boot. */
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

/**
 * Onde as skills concedidas a este Bot ficam, dentro do workspace.
 *
 * Um diretório só, refeito a cada turno: é o que faz revogar uma concessão valer no turno seguinte,
 * e é por isso que ele não é `AGENT_CLI_SKILLS_DIR` — um caminho configurável fora do workspace
 * seria um lugar que a limpeza não alcança.
 */
const SKILLS_DIR = join(WORKSPACE, ".openbot-skills");

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
  process.env.AGENT_CLI_AUTH_PATH?.trim() || "opencode/auth.json";

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

/**
 * O teto do envelope textual de um turno, em caracteres.
 *
 * Determinístico de propósito: conta caracteres, e não tokens do fornecedor — o que cabe é o que
 * coube, igual em qualquer CLI. Histórico e mensagem atual somados nunca passam daqui.
 */
export const LIMITE_CONTEXTO_TURNO = 48_000;

/** O papel como o CLI lê: quem disse o quê, sem sigla. */
function rotuloDoPapel(papel: string): string {
  switch (papel) {
    case "user":
      return "Pessoa";
    case "assistant":
      return "Assistente";
    case "system":
    case "developer":
      return "Sistema";
    case "tool":
      return "Ferramenta";
    case "reasoning":
      return "Raciocínio";
    case "activity":
      return "Atividade";
    default:
      return papel;
  }
}

/**
 * O texto de uma mensagem AG-UI, sem transformar objeto em "[object Object]".
 *
 * Texto vai como está. Parte multimodal textual vai pelo texto dela; parte de outro tipo
 * (imagem, áudio, vídeo, documento) vira um marcador explícito — o CLI deste turno só recebe
 * texto, e o que ficou de fora está escrito, não sumido. Conteúdo fora do contrato (nem texto
 * nem lista de partes, parte sem tipo) é recusado com erro, nunca adivinhado.
 */
function textoDaMensagem(mensagem: Message): string {
  const conteudo: unknown =
    "content" in mensagem ? mensagem.content : undefined;
  if (conteudo === undefined || conteudo === null) return "";
  if (typeof conteudo === "string") return conteudo;
  if (Array.isArray(conteudo)) {
    return conteudo
      .map((parte: unknown) => {
        if (typeof parte === "string") return parte;
        if (!parte || typeof parte !== "object" || !("type" in parte)) {
          throw new Error(
            "O turno chegou com parte de mensagem fora do contrato AG-UI e foi recusado.",
          );
        }
        const tipo: unknown = parte.type;
        if (tipo === "text") {
          const texto: unknown = "text" in parte ? parte.text : undefined;
          if (typeof texto !== "string") {
            throw new Error(
              "O turno chegou com parte textual sem texto e foi recusado.",
            );
          }
          return texto;
        }
        if (typeof tipo !== "string") {
          throw new Error(
            "O turno chegou com parte de mensagem fora do contrato AG-UI e foi recusado.",
          );
        }
        return `[conteúdo de ${tipo} não incluído no texto do turno]`;
      })
      .join("\n");
  }
  throw new Error(
    "O turno chegou com conteúdo fora do contrato AG-UI (nem texto nem partes) e foi recusado.",
  );
}

/**
 * Uma mensagem como bloco rotulado do prompt. Devolve "" quando não há nada textual a levar
 * (texto vazio e sem chamada de ferramenta, por exemplo): um rótulo órfão não ajuda o CLI.
 */
function blocoDaMensagem(mensagem: Message): string {
  if (mensagem.role === "activity") {
    return `Atividade: [atividade ${mensagem.activityType} sem texto; não incluída no turno]`;
  }
  const linhas = [textoDaMensagem(mensagem)];
  if (mensagem.role === "assistant") {
    for (const chamada of mensagem.toolCalls ?? []) {
      linhas.push(`[ferramenta chamada: ${chamada.function.name}]`);
    }
  }
  if (
    mensagem.role === "tool" &&
    !linhas[0]?.trim() &&
    typeof mensagem.error === "string" &&
    mensagem.error
  ) {
    linhas[0] = `[erro: ${mensagem.error}]`;
  }
  const texto = linhas.filter((linha) => linha.trim()).join("\n");
  if (!texto) return "";
  return `${rotuloDoPapel(mensagem.role)}: ${texto}`;
}

function marcadorDeOmissao(omitidas: number): string {
  return omitidas === 1
    ? "[1 mensagem anterior omitida pelo limite de contexto do turno]"
    : `[${omitidas} mensagens anteriores omitidas pelo limite de contexto do turno]`;
}

/**
 * A pergunta deste turno: o contexto textual do pedido, numa única mensagem simples.
 *
 * Leva o histórico daquele pedido com papéis marcados e a mensagem atual por último, sem guardar
 * nada em variável global — cada chamada constrói só do `input` que recebeu, então outra thread
 * nunca herda dado desta. A atual vai inteira sempre: o que cai fora quando estoura o limite são
 * as mensagens antigas, inteiras, do começo para o fim, com marcador explícito de quantas caíram.
 * Se a atual sozinha passar do limite, recusa com erro antes de qualquer spawn, sem truncar.
 */
export function perguntaDoTurno(input: RunAgentInput): string {
  const mensagens = input.messages ?? [];
  let indiceAtual = -1;
  for (let i = mensagens.length - 1; i >= 0; i--) {
    if (mensagens[i]?.role === "user") {
      indiceAtual = i;
      break;
    }
  }
  if (indiceAtual < 0) return "";
  const mensagemAtual = mensagens[indiceAtual];
  if (!mensagemAtual) return "";
  const atual = blocoDaMensagem(mensagemAtual);
  if (atual.length > LIMITE_CONTEXTO_TURNO) {
    throw new Error(
      `A mensagem atual tem ${atual.length} caracteres e passa do limite de ${LIMITE_CONTEXTO_TURNO} do turno; o turno foi recusado antes do CLI, sem truncar.`,
    );
  }
  const historico = mensagens
    .filter((_, i) => i !== indiceAtual)
    .map(blocoDaMensagem)
    .filter((bloco) => bloco);
  const medir = (cabidos: string[], omitidas: number): number =>
    (omitidas > 0 ? marcadorDeOmissao(omitidas).length + 2 : 0) +
    [...cabidos, atual].join("\n\n").length;
  // O sufixo mais recente que cabe: percorre do novo ao antigo e para na primeira que estourar,
  // então o que cai é sempre o começo — contíguo, sem furar a ordem.
  const cabidos: string[] = [];
  for (let i = historico.length - 1; i >= 0; i--) {
    const bloco = historico[i];
    if (bloco === undefined) continue;
    if (
      medir([bloco, ...cabidos], historico.length - (cabidos.length + 1)) <=
      LIMITE_CONTEXTO_TURNO
    ) {
      cabidos.unshift(bloco);
    } else {
      break;
    }
  }
  // O marcador também conta: se ele estourar o teto, derruba mais uma antiga até caber.
  let omitidas = historico.length - cabidos.length;
  while (
    cabidos.length > 0 &&
    medir(cabidos, omitidas) > LIMITE_CONTEXTO_TURNO
  ) {
    cabidos.shift();
    omitidas += 1;
  }
  if (medir(cabidos, omitidas) > LIMITE_CONTEXTO_TURNO) {
    throw new Error(
      "A mensagem atual e o aviso de histórico omitido excedem o limite do turno.",
    );
  }
  return [
    ...(omitidas > 0 ? [marcadorDeOmissao(omitidas)] : []),
    ...cabidos,
    atual,
  ].join("\n\n");
}

/** Uma skill como o painel a concedeu: os quatro campos que a rota guarda por slug. */
export type SkillConcedida = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
};

/**
 * As skills que este turno recebeu do runtime.
 *
 * Lidas do `forwardedProps`, onde o runtime as põe por Bot. Uma lista ausente e uma lista vazia
 * querem dizer a mesma coisa aqui — este turno não tem skill nenhuma —, e é o que o serviço escreve
 * no workspace: nada.
 *
 * O slug é validado aqui, antes de virar nome de diretório, e não na hora de escrever: o slug entra
 * num caminho, então um slug com `..` ou `/` escreveria fora do workspace. O formato é o que a rota
 * do painel aceita (`^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`), e o que não casar é descartado — o modelo
 * não pode receber no índice uma skill cujo arquivo não existe.
 */
export function skillsDoTurno(input: RunAgentInput): SkillConcedida[] {
  const props = input.forwardedProps as { skills?: unknown } | undefined;
  if (!Array.isArray(props?.skills)) return [];
  return props.skills.flatMap((bruta) => {
    const skill = bruta as Partial<SkillConcedida> | null;
    if (
      !skill ||
      typeof skill.slug !== "string" ||
      typeof skill.instructions !== "string"
    ) {
      return [];
    }
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(skill.slug)) {
      console.warn(`skill ignorada: slug fora do formato — ${skill.slug}`);
      return [];
    }
    return [
      {
        slug: skill.slug,
        title: typeof skill.title === "string" ? skill.title : skill.slug,
        summary: typeof skill.summary === "string" ? skill.summary : "",
        instructions: skill.instructions,
      },
    ];
  });
}

/**
 * O que o CLI lê como instruções do projeto.
 *
 * As mesmas regras que o Codex recebe, porque o problema é o mesmo: um modelo com ferramentas de
 * navegador precisa saber que elas existem, que a ordem é snapshot-antes-de-agir, e que senha e
 * captcha são pedidos a uma pessoa — nunca adivinhados nem pedidos por chat.
 */
export function instructions(skills: SkillConcedida[] = []): string {
  const linhas = [
    SYSTEM_PROMPT,
    "",
    "## Ferramentas deste ambiente",
    "",
    "O navegador do Bot chega pelas ferramentas MCP do servidor `openbot` (os nomes começam com",
    "`openbot_`). Use-as para abrir, ler, clicar, digitar e capturar tela. Buscar página por fora",
    "delas é recusado pela configuração deste projeto, de propósito: só o caminho pelo MCP passa",
    "pela política e pela auditoria do deployment.",
    "",
    "Pedido explícito de browser/navegador, tela em tempo real ou sessão autenticada usa abrir_pagina",
    "e as ferramentas da página aberta; não substitua por ler_url_rapido.",
    "",
    "Erro operacional não é autorização para contornar o gateway: se o navegador falhar, relate a",
    "falha real e não descreva uma consulta que não aconteceu. Login, CAPTCHA e 2FA são pedidos a uma",
    "pessoa pela tela — senha nunca no chat, nunca adivinhada.",
    "",
    "Para baixar ou gerar arquivos, escreva no diretório de trabalho — é o que a pessoa recebe.",
  ];

  /*
   * O índice, e não o corpo: com cem skills concedidas, o texto inteiro seria o turno. O arquivo de
   * cada uma está no disco (`SKILLS_DIR`), e a instrução é abri-lo quando a tarefa casar com a
   * descrição — o modelo lê o que precisa, quando precisa.
   */
  if (skills.length) {
    linhas.push(
      "",
      "## Skills concedidas",
      "",
      ...skills.map(
        (skill) =>
          `- ${skill.slug} — ${skill.summary || skill.title} (${join(SKILLS_DIR, skill.slug, "SKILL.md")})`,
      ),
      "",
      "Abra o arquivo da skill quando a tarefa casar com a descrição; sem isso, responda sem ela.",
    );
  }

  return linhas.join("\n");
}

/**
 * Escreve o que o CLI precisa para este turno: o config do projeto, as skills concedidas e as
 * instruções.
 *
 * O config carrega a declaração assinada, que vale para UM turno. Por isso ele é reescrito a cada
 * vez, em vez de ficar no ambiente do serviço, que sobrevive a todos eles.
 */
async function prepararTurno(
  adapterId: string,
  assertion: string,
  skills: SkillConcedida[] = [],
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
        schema: "https://opencode.ai/config.json",
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

  /*
   * O diretório é refeito a cada turno, e não atualizado: o volume sobrevive a todos eles, e uma
   * skill revogada não pode continuar no disco do CLI — o modelo acharia o arquivo e a usaria.
   * `force` porque na primeira vez ele não existe.
   */
  await rm(SKILLS_DIR, { recursive: true, force: true });
  for (const skill of skills) {
    // O slug já foi validado por quem leu a lista (`skillsDoTurno`); aqui ele só vira caminho.
    const destino = join(SKILLS_DIR, skill.slug, "SKILL.md");
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(
      destino,
      `# ${skill.title}\n\n${skill.instructions}\n`,
      "utf8",
    );
  }

  await writeFile(instructionsPath, `${instructions(skills)}\n`, "utf8");
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
  abort.throwIfAborted();
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
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}

// One process shares one workspace. A cancelled waiter releases only its own gate.
let workspaceTail = Promise.resolve();
async function acquireWorkspace(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const previous = workspaceTail;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  workspaceTail = previous.then(() => held);
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void previous.then(() => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve();
      });
    });
    signal.throwIfAborted();
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export async function runAgent(
  input: RunAgentInput,
  signal: AbortSignal,
): Promise<Response> {
  const encoder = new EventEncoder();
  const abort = new AbortController();
  const turnSignal = AbortSignal.any([signal, abort.signal]);
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      let releaseWorkspace: (() => void) | undefined;
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
        const skills = skillsDoTurno(input);
        console.info(
          `turno ${input.runId}: CLI ${CLI}, declaração de execução ${
            assertion
              ? `presente (${assertion.length} caracteres)`
              : "AUSENTE — sem ferramentas"
          }${skills.length ? `, ${skills.length} skill(s) concedida(s)` : ""}`,
        );
        /*
         * O contexto é montado antes de qualquer escrita ou spawn: se a mensagem atual estourar o
         * limite, o turno é recusado aqui — sem truncar e sem encostar no workspace.
         */
        const pergunta = perguntaDoTurno(input);
        if (!pergunta.trim()) {
          throw new Error("O turno chegou sem pergunta.");
        }
        releaseWorkspace = await acquireWorkspace(turnSignal);
        await prepararTurno(CLI, assertion, skills);
        turnSignal.throwIfAborted();

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
          turnSignal,
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
        releaseWorkspace?.();
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
    cancel(reason) {
      closed = true;
      abort.abort(reason);
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
   * O CLI é validado antes de servir: `adapterFor` recusa um `AGENT_CLI` desconhecido aqui, no
   * boot, e não no primeiro turno — com um `.env` antigo o container nem sobe healthy.
   */
  adapterFor(CLI);
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
        return runAgent(input, request.signal);
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
