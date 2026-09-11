/**
 * O que chega do Telegram, reduzido ao que este deployment usa.
 *
 * A API manda muito mais do que isto, e o que ela manda muda sem aviso. Em vez de tipar cada campo,
 * o que entra é validado pelo formato: o que não é uma mensagem de texto ou um clique de botão é
 * ignorado em silêncio, porque responder a um update que não entendemos é pior do que não responder —
 * a plataforma reenviaria o mesmo update e a conversa viraria um eco.
 *
 * Os ids são texto. São inteiros grandes o bastante para perder dígitos num `number` do JavaScript, e
 * o id é a única identidade que existe: um chat id truncado é outro chat.
 */

export type TelegramUser = {
  id: string;
  username?: string;
  firstName?: string;
};

export type TelegramMessage = {
  messageId: number;
  chatId: string;
  /** Ausente em canais e em mensagens de serviço. */
  from?: TelegramUser;
  text: string;
  /** Comando é `/coisa` no começo; o resto é o argumento, já sem o comando. */
  command?: { name: string; argument: string };
};

export type TelegramCallback = {
  id: string;
  messageId: number;
  chatId: string;
  from: TelegramUser;
  data: string;
};

export type TelegramUpdate = {
  updateId: number;
  message?: TelegramMessage;
  callback?: TelegramCallback;
};

/** Um botão abaixo de uma mensagem. `data` é o que volta no clique. */
export type TelegramButton = { text: string; data: string };

/**
 * O que a plataforma recebe de volta.
 *
 * O manipulador devolve isto em vez de enviar: é o que torna a conversa testável sem uma rede, e o
 * que deixa claro que a decisão (quem pode, sobre qual tarefa) é de quem montou a resposta.
 */
export type TelegramOutgoing =
  | {
      kind: "text";
      chatId: string;
      text: string;
      buttons?: TelegramButton[][];
      /** Responde a um clique, tirando o "carregando" do botão. */
      answerCallbackId?: string;
    }
  | {
      kind: "photo";
      chatId: string;
      bytes: Uint8Array;
      mime: string;
      caption?: string;
      answerCallbackId?: string;
    };

const INTEGER = /^-?\d+$/;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseUser(value: unknown): TelegramUser | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = asNumber(record.id);
  if (id === undefined) return undefined;
  return {
    id: String(id),
    ...(asText(record.username) ? { username: asText(record.username) } : {}),
    ...(asText(record.first_name) ? { firstName: asText(record.first_name) } : {}),
  };
}

/** `/pausar 42` vira `{name:"pausar", argument:"42"}`. */
function parseCommand(text: string): TelegramMessage["command"] {
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (!match?.[1]) return undefined;
  return { name: match[1].toLowerCase(), argument: (match[2] ?? "").trim() };
}

/**
 * Traduz um update cru. Devolve nada quando não é algo que se responda.
 *
 * Um update sem mensagem e sem clique (uma reação, uma edição, alguém entrando no grupo) não é um
 * erro: é a plataforma contando o que aconteceu. O chamador registra e segue.
 */
export function parseUpdate(raw: unknown): TelegramUpdate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const update = raw as Record<string, unknown>;
  const updateId = asNumber(update.update_id);
  if (updateId === undefined) return undefined;

  const message = update.message ?? update.edited_message;
  if (message && typeof message === "object") {
    const record = message as Record<string, unknown>;
    const chat = record.chat as Record<string, unknown> | undefined;
    const chatId = asNumber(chat?.id);
    const messageId = asNumber(record.message_id);
    const text = record.text ?? record.caption;
    if (chatId === undefined || messageId === undefined || !asText(text)) {
      return { updateId };
    }
    const clean = String(text).trim();
    return {
      updateId,
      message: {
        messageId,
        chatId: String(chatId),
        ...(parseUser(record.from) ? { from: parseUser(record.from) } : {}),
        text: clean,
        ...(parseCommand(clean) ? { command: parseCommand(clean) } : {}),
      },
    };
  }

  const callback = update.callback_query;
  if (callback && typeof callback === "object") {
    const record = callback as Record<string, unknown>;
    const inner = record.message as Record<string, unknown> | undefined;
    const chat = inner?.chat as Record<string, unknown> | undefined;
    const id = asText(record.id);
    const data = asText(record.data);
    const messageId = asNumber(inner?.message_id);
    const chatId = asNumber(chat?.id);
    const from = parseUser(record.from);
    if (
      !id ||
      !data ||
      messageId === undefined ||
      chatId === undefined ||
      !from
    ) {
      return { updateId };
    }
    return {
      updateId,
      callback: {
        id,
        messageId,
        chatId: String(chatId),
        from,
        data,
      },
    };
  }

  return { updateId };
}

/** Um id numérico da plataforma veio como texto: continua sendo um id, não um número. */
export function isNumericId(value: string): boolean {
  return INTEGER.test(value);
}
