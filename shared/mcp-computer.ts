#!/usr/bin/env bun
/**
 * O computador do Bot, oferecido ao Codex como um servidor MCP.
 *
 * O laço de ferramentas do OpenBot roda no cliente: o Bot pede uma ferramenta, a execução termina, a
 * página executa e começa outra execução com o resultado. Um Bot cujo modelo roda o próprio laço num
 * processo próprio — o Codex — não tem página nem sessão, e sem isto seria o único Bot incapaz de
 * abrir uma URL.
 *
 * Aqui ele chama as mesmas rotas que a página chama: `/api/computers/:botId/*`. Elas passam pelo
 * gateway, então cada navegação, clique e digitada resolve o alvo, é julgada pela política de
 * `/admin/boundaries` e vira uma linha em `/admin/audit` antes de tocar o navegador. É por isso que
 * este arquivo existe em vez de o Bot dirigir um Chromium próprio: dirigir por fora seria contornar
 * as três coisas.
 *
 * Escrito à mão em vez de usar o SDK do MCP porque o protocolo em stdio é JSON-RPC com quatro
 * métodos, e o SDK arrasta `eventsource` — o pacote que já impediu a imagem inteira de subir.
 */

const API = process.env.OPENBOT_API_URL?.trim() || "http://openbot:3001";
const TOKEN = process.env.OPENBOT_AGENT_TOKEN?.trim() ?? "";
/** A declaração assinada de quem é esta execução. Opaca aqui: só o servidor sabe abrir. */
const RUN = process.env.OPENBOT_RUN?.trim() ?? "";
const BOT = process.env.OPENBOT_BOT_ID?.trim() ?? "";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<unknown>;
};

const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required });

const text = (description: string) => ({ type: "string", description });
const number = (description: string) => ({ type: "number", description });

/** Uma chamada ao computador, com as duas credenciais que o servidor confere uma contra a outra. */
async function computer(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<unknown> {
  const response = await fetch(`${API}/api/computers/${BOT}/${path}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": TOKEN,
      "x-openbot-run": RUN,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    /*
     * Uma recusa da política volta como resultado, não como exceção. O Codex precisa ler "esta regra
     * barrou" e decidir outra coisa; um erro de transporte o faria repetir a mesma chamada.
     */
    const reason =
      (payload as { error?: string } | null)?.error ??
      `O computador respondeu ${response.status}.`;
    const rule = (payload as { rule?: string } | null)?.rule;
    return { recusado: true, motivo: reason, ...(rule ? { regra: rule } : {}) };
  }
  return payload ?? {};
}

const tools: Tool[] = [
  {
    name: "abrir_pagina",
    description:
      "Abre um endereço no navegador do Bot, que a pessoa vê na tela. Use quando pedirem para olhar, consultar ou preencher algo na web.",
    inputSchema: object({ url: text("O endereço a abrir") }, ["url"]),
    call: (args) =>
      computer("navigate", { method: "POST", body: { url: args.url } }),
  },
  {
    name: "ler_url_rapido",
    description:
      "Lê uma página só pelo texto, sem abrir no navegador que a pessoa vê. Devolve o texto e os links. Use quando a resposta for o conteúdo e mais nada — é muito mais rápido. Para algo que exija estar logado, ou que a pessoa precise ver acontecer, use abrir_pagina.",
    inputSchema: object({ url: text("O endereço a ler") }, ["url"]),
    call: (args) =>
      computer("fetch", { method: "POST", body: { url: args.url } }),
  },
  {
    name: "ler_pagina",
    description:
      "Lê o texto da página aberta agora, sem abrir nada. Use depois de abrir ou de clicar, para saber o que está na tela.",
    inputSchema: object({}),
    call: () => computer("read", { method: "GET" }),
  },
  {
    name: "mapear_pagina",
    description:
      "Lista o que dá para acionar na página: campos, botões, links e caixas. Devolve um ref para cada um e o snapshotId a que pertencem. Chame antes de clicar ou digitar.",
    inputSchema: object({}),
    call: () => computer("snapshot", { method: "POST" }),
  },
  {
    name: "clicar",
    description:
      "Clica em algo da página. O ref e o snapshotId vêm do mapear_pagina mais recente.",
    inputSchema: object(
      {
        ref: text("O ref do elemento, vindo do último mapear_pagina"),
        snapshotId: number("O snapshotId de onde o ref veio"),
      },
      ["ref", "snapshotId"],
    ),
    call: (args) =>
      computer("click", {
        method: "POST",
        body: { ref: args.ref, snapshotId: args.snapshotId },
      }),
  },
  {
    name: "digitar",
    description:
      "Escreve num campo da página. Passe submit true para apertar Enter depois, em formulário de um campo só.",
    inputSchema: object(
      {
        ref: text("O ref do campo, vindo do último mapear_pagina"),
        snapshotId: number("O snapshotId de onde o ref veio"),
        text: text("O texto a escrever"),
        submit: {
          type: "boolean",
          description: "Apertar Enter depois de escrever",
        },
      },
      ["ref", "snapshotId", "text"],
    ),
    call: (args) =>
      computer("type", {
        method: "POST",
        body: {
          ref: args.ref,
          snapshotId: args.snapshotId,
          text: args.text,
          submit: args.submit === true,
        },
      }),
  },
  {
    name: "tecla",
    description:
      "Aperta uma tecla, como Enter, Tab ou Escape. Dê um ref para apertar com um campo em foco.",
    inputSchema: object(
      {
        key: text("Nome da tecla, como Enter, Tab ou Escape"),
        ref: text("Opcional: o campo onde apertar"),
        snapshotId: number("O snapshotId de onde o ref veio, se houver ref"),
      },
      ["key"],
    ),
    call: (args) => computer("key", { method: "POST", body: args }),
  },
  {
    name: "rolar",
    description: "Rola a página para cima ou para baixo.",
    inputSchema: object({
      direction: text("up ou down"),
    }),
    call: (args) => computer("scroll", { method: "POST", body: args }),
  },
  {
    name: "ver_a_tela",
    description:
      "Tira uma foto do navegador e devolve a imagem. Use quando o texto não bastar: conteúdo desenhado em canvas, um gráfico, um estado visual, ou quando precisar conferir o que a pessoa está vendo. Campos de senha saem mascarados, e durante a digitação de um segredo a captura é recusada de propósito.",
    inputSchema: object({}),
    call: async () => {
      const shot = (await computer("screenshot", { method: "GET" })) as {
        base64?: string;
        width?: number;
        height?: number;
        url?: string;
        masked?: number;
        capturedAt?: string;
        recusado?: boolean;
      };
      if (shot.recusado || !shot.base64) return shot;
      /*
       * A imagem vai como conteúdo `image`, não como texto.
       *
       * Era este o buraco apontado pela auditoria: o bridge serializava tudo em `JSON.stringify`, e
       * um modelo que recebe uma parede de base64 não vê imagem nenhuma. O protocolo já previa
       * resultados de imagem; o que faltava era devolvê-los assim. O texto que acompanha são só os
       * metadados — nunca o base64 em duas formas.
       */
      return {
        content: [
          { type: "image", data: shot.base64, mimeType: "image/png" },
          {
            type: "text",
            text: JSON.stringify({
              url: shot.url,
              width: shot.width,
              height: shot.height,
              capturadaEm: shot.capturedAt,
              mascarados: shot.masked ?? 0,
            }),
          },
        ],
      };
    },
  },
  {
    name: "pedir_ajuda",
    description:
      "Para e chama uma pessoa: login, CAPTCHA, 2FA, ou qualquer decisão que só o operador pode tomar. Use também quando a política recusar uma ação e você não tiver outro caminho.",
    inputSchema: object(
      { motivo: text("Em uma frase, o que está impedindo e o que a pessoa precisa fazer") },
      ["motivo"],
    ),
    call: (args) =>
      computer("control/request", {
        method: "POST",
        body: { reason: args.motivo },
      }),
  },
  {
    name: "escolher_opcao",
    description:
      "Escolhe uma opção de um campo de seleção (dropdown). O valor é o `value` da opção, não o texto que aparece na tela.",
    inputSchema: object(
      {
        ref: text("O ref do campo de seleção, vindo do último mapear_pagina"),
        snapshotId: number("O snapshotId de onde o ref veio"),
        value: text("O value da opção a escolher"),
      },
      ["ref", "snapshotId", "value"],
    ),
    call: (args) => computer("select", { method: "POST", body: args }),
  },
];

/**
 * Procurar nos documentos que os conectores trouxeram.
 *
 * Não é uma ação de computador, então não passa por `/api/computers`: procurar num índice que este
 * deployment já indexou não navega para lugar nenhum e não tem alvo para uma regra de destino julgar.
 * Autentica com as mesmas duas credenciais.
 */
tools.push({
  name: "buscar_conhecimento",
  description:
    "Procura nos documentos que este deployment sincronizou (Google Drive, entre outros) e devolve os trechos que respondem, com título e link para citar. Use antes de dizer que não sabe algo sobre a empresa.",
  inputSchema: object(
    {
      pergunta: text("O que procurar, em palavras"),
      limite: number("Quantos trechos trazer. Padrão 6"),
    },
    ["pergunta"],
  ),
  call: async (args) => {
    const response = await fetch(`${API}/api/knowledge/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": TOKEN,
        "x-openbot-run": RUN,
      },
      body: JSON.stringify({ question: args.pergunta, limit: args.limite }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        erro:
          (payload as { error?: string } | null)?.error ??
          `A busca respondeu ${response.status}.`,
      };
    }
    return payload ?? {};
  },
});

const byName = new Map(tools.map((tool) => [tool.name, tool]));

/* ---- JSON-RPC em stdio ---- */

function reply(id: unknown, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id: unknown, code: number, message: string) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}

async function handle(message: {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}) {
  const { id, method, params } = message;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openbot-computer", version: "1.0.0" },
    });
  }

  /* Notificações não têm id e não recebem resposta. */
  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    return reply(id, {
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const tool = byName.get(name);
    if (!tool) return fail(id, -32602, `Ferramenta desconhecida: ${name}`);

    try {
      const result = await tool.call(
        (params?.arguments as Record<string, unknown>) ?? {},
      );
      /*
       * Uma ferramenta pode devolver conteúdo MCP pronto — a imagem de `ver_a_tela`. É o único
       * caminho em que o resultado não é texto, e é por isso que ele é reconhecido aqui em vez de
       * cada ferramenta embrulhar o próprio envelope.
       */
      if (
        result &&
        typeof result === "object" &&
        "content" in result &&
        Array.isArray(result.content)
      ) {
        return reply(id, { content: result.content });
      }
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    } catch (error) {
      /*
       * Devolvido como conteúdo com isError, não como erro de JSON-RPC: o Codex lê o texto e tenta
       * outro caminho, enquanto um erro de protocolo derrubaria a chamada sem lhe dizer o motivo.
       */
      return reply(id, {
        content: [
          {
            type: "text",
            text:
              error instanceof Error
                ? error.message
                : "O computador não respondeu.",
          },
        ],
        isError: true,
      });
    }
  }

  if (id !== undefined) fail(id, -32601, `Método desconhecido: ${method}`);
}

if (import.meta.main) {
  if (!TOKEN || !RUN || !BOT) {
    /*
     * Vai para stderr e sai: sem as três, toda chamada seria recusada pelo servidor, e um servidor
     * MCP que anuncia sete ferramentas e falha em todas é pior do que um que não sobe.
     */
    process.stderr.write(
      "mcp-computer exige OPENBOT_AGENT_TOKEN, OPENBOT_RUN e OPENBOT_BOT_ID.\n",
    );
    process.exit(1);
  }

  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        await handle(JSON.parse(trimmed));
      } catch {
        /* Linha ilegível é ignorada: não há id para responder e derrubar o servidor é pior. */
      }
    }
  }
}

export { handle, tools };
