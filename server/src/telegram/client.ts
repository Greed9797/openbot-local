/**
 * A única coisa que fala HTTP com a plataforma.
 *
 * O token aparece na URL de cada chamada, que é como a API do Telegram funciona, e é por isso que
 * ele não aparece em lugar nenhum além daqui: nem em log, nem em erro, nem em mensagem de auditoria.
 * Um erro que vaza o token no texto é um token publicado no primeiro lugar que lê os logs.
 *
 * `fetch` é injetável para os testes não dependerem de rede — e para a suíte não precisar de
 * credencial nenhuma para exercitar o caminho inteiro do polling.
 */
import type { TelegramButton } from "./types";

export type TelegramClientOptions = {
  token: string;
  /** Sobrescrito nos testes; a produção usa o `fetch` do processo. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
};

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly description: string,
    readonly status: number,
  ) {
    super(`Telegram ${method}: ${description}`);
    this.name = "TelegramApiError";
  }
}

export type TelegramClient = {
  getUpdates(options: {
    offset: number;
    timeoutSeconds: number;
    signal?: AbortSignal;
  }): Promise<unknown[]>;
  sendMessage(options: {
    chatId: string;
    text: string;
    buttons?: TelegramButton[][];
    signal?: AbortSignal;
  }): Promise<{ messageId: number }>;
  sendPhoto(options: {
    chatId: string;
    bytes: Uint8Array;
    mime: string;
    caption?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: number }>;
  answerCallback(options: {
    callbackId: string;
    text?: string;
    signal?: AbortSignal;
  }): Promise<void>;
};

/** O token nunca sai daqui: a URL é montada e o erro é reconstruído sem ela. */
function describeFailure(status: number, body: unknown): string {
  const detail = body as { description?: unknown } | null;
  if (detail && typeof detail.description === "string") {
    return detail.description;
  }
  return `HTTP ${status}`;
}

export function createTelegramClient(
  options: TelegramClientOptions,
): TelegramClient {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? "https://api.telegram.org";

  async function call<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    form?: FormData,
  ): Promise<T> {
    const url = `${base}/bot${options.token}/${method}`;
    const response = await doFetch(url, {
      method: "POST",
      ...(form
        ? { body: form }
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
      ...(signal ? { signal } : {}),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new TelegramApiError(
        method,
        describeFailure(response.status, body),
        response.status,
      );
    }
    const envelope = body as { ok?: boolean; result?: T };
    if (envelope?.ok !== true) {
      throw new TelegramApiError(
        method,
        describeFailure(response.status, body),
        response.status,
      );
    }
    return envelope.result as T;
  }

  return {
    async getUpdates({ offset, timeoutSeconds, signal }) {
      const result = await call<unknown[]>(
        "getUpdates",
        {
          offset,
          timeout: timeoutSeconds,
          allowed_updates: ["message", "callback_query"],
        },
        signal,
      );
      return Array.isArray(result) ? result : [];
    },

    async sendMessage({ chatId, text, buttons, signal }) {
      const result = await call<{ message_id: number }>(
        "sendMessage",
        {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...(buttons?.length
            ? {
                reply_markup: {
                  inline_keyboard: buttons.map((row) =>
                    row.map((button) => ({
                      text: button.text,
                      callback_data: button.data,
                    })),
                  ),
                },
              }
            : {}),
        },
        signal,
      );
      return { messageId: result.message_id };
    },

    async sendPhoto({ chatId, bytes, mime, caption, signal }) {
      const form = new FormData();
      form.append("chat_id", chatId);
      if (caption) form.append("caption", caption);
      // Uma cópia de buffer próprio: o Blob guarda o que recebe, e o buffer de um Buffer do Node pode
      // ser compartilhado com o pool — a foto que sai não pode mudar depois de enviada.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      form.append("photo", new Blob([copy], { type: mime }), "tela.png");
      const result = await call<{ message_id: number }>(
        "sendPhoto",
        {},
        signal,
        form,
      );
      return { messageId: result.message_id };
    },

    async answerCallback({ callbackId, text, signal }) {
      await call(
        "answerCallbackQuery",
        {
          callback_query_id: callbackId,
          ...(text ? { text } : {}),
        },
        signal,
      );
    },
  };
}
