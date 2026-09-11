import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  createPairingCodeMutationOptions,
  removeBindingMutationOptions,
} from "@/lib/telegram/mutations";
import {
  telegramBindingsQueryOptions,
  type PairingCode,
} from "@/lib/telegram/queries";

/**
 * Onde um chat do Telegram ganha acesso a um Bot.
 *
 * O pareamento começa aqui, nunca no Telegram: um bot tem nome público, e sem este passo qualquer
 * pessoa que o encontrasse criaria tarefas na conta de outra. A tela diz o código, as instruções e
 * quando ele expira, e lista os chats já ligados para poder desligá-los.
 *
 * Um deployment sem bot configurado não tem estas rotas — a seção some inteira em vez de oferecer um
 * botão que só devolveria erro.
 */
export function TelegramPairing() {
  const queryClient = useQueryClient();
  const vinculos = useQuery(telegramBindingsQueryOptions());
  const colegas = useQuery(agentListQueryOptions());
  const [botId, setBotId] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [codigo, setCodigo] = useState<PairingCode | null>(null);
  const [erroVinculo, setErroVinculo] = useState<string | null>(null);

  const botEscolhido = botId || colegas.data?.[0]?.id || "";
  const gerar = useMutation(
    createPairingCodeMutationOptions(queryClient, {
      onError: (thrown) => {
        setErro(thrown.message);
        setCodigo(null);
      },
      onSuccess: (criado) => {
        setErro(null);
        setCodigo(criado);
      },
    }),
  );
  const desligar = useMutation(
    removeBindingMutationOptions(queryClient, {
      onError: (thrown) => setErroVinculo(thrown.message),
      onSuccess: () => setErroVinculo(null),
    }),
  );

  if (vinculos.isPending) {
    return <p className="mt-4 text-muted-foreground text-sm">Carregando…</p>;
  }
  if (vinculos.isError) {
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {vinculos.error instanceof Error
          ? vinculos.error.message
          : "Não foi possível carregar os chats ligados."}
      </p>
    );
  }
  if (!vinculos.data.available) {
    return (
      <p className="mt-4 text-muted-foreground text-sm">
        Este deployment não tem bot do Telegram configurado. Defina{" "}
        <code className="font-mono">TELEGRAM_BOT_TOKEN</code> e quem pode falar com ele em{" "}
        <code className="font-mono">TELEGRAM_ALLOWED_USER_IDS</code> para ligar um chat.
      </p>
    );
  }

  const ligados = vinculos.data.bindings;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <span className="font-medium text-sm">Bot que o chat vai operar</span>
          <Select
            disabled={gerar.isPending || !colegas.data?.length}
            onValueChange={(value) => setBotId(value ?? "")}
            value={botEscolhido}
          >
            <SelectTrigger aria-label="Bot que o chat vai operar">
              <SelectValue placeholder="Escolha o Bot" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {(colegas.data ?? []).map((colega) => (
                  <SelectItem key={colega.id} value={colega.id}>
                    {colega.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <Button
          disabled={!botEscolhido || gerar.isPending}
          onClick={() => gerar.mutate(botEscolhido)}
          type="button"
          variant="outline"
        >
          {gerar.isPending ? "Gerando…" : "Gerar código"}
        </Button>
      </div>

      {erro ? (
        <p className="text-destructive text-sm" role="alert">
          {erro}
        </p>
      ) : null}

      {codigo ? (
        <div className="rounded-lg border border-dashed p-3">
          <p className="font-mono font-semibold text-lg tracking-widest">
            {codigo.code}
          </p>
          <p className="mt-1 text-muted-foreground text-sm">
            {codigo.instructions} Vale até{" "}
            {new Date(codigo.expiresAt).toLocaleTimeString()} (
            {new Date(codigo.expiresAt).toLocaleDateString()}) e vale uma vez só.
          </p>
        </div>
      ) : null}

      {ligados.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nenhum chat ligado ainda. Gere um código e mande{" "}
          <code className="font-mono">/start CÓDIGO</code> no privado do bot.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {ligados.map((vinculo) => (
            <li
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
              key={vinculo.id}
            >
              <span className="flex flex-col">
                <span className="font-medium text-sm">{vinculo.botId}</span>
                <span className="text-muted-foreground text-xs">
                  chat {vinculo.chatId} · usuário {vinculo.telegramUserId} · desde{" "}
                  {new Date(vinculo.createdAt).toLocaleString()}
                </span>
              </span>
              <Button
                disabled={desligar.isPending}
                onClick={() => desligar.mutate(vinculo.id)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Desligar
              </Button>
            </li>
          ))}
        </ul>
      )}

      {erroVinculo ? (
        <p className="text-destructive text-sm" role="alert">
          {erroVinculo}
        </p>
      ) : null}
    </div>
  );
}
