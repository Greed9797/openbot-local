import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { sendTaskMessageMutationOptions } from "@/lib/tasks/mutations";
import type { MessageView } from "@/lib/tasks/queries";

/**
 * A conversa da tarefa com o campo de resposta.
 *
 * "Você" é a pessoa dona da tarefa, "Sistema" é o que o runtime anotou (entregue ou não ao
 * modelo — a falta de entrega também é dita, porque mensagem enviada não é mensagem lida). O erro
 * de envio aparece em linha: derrubar a conversa por uma mensagem que não saiu seria punir as que
 * já estão aqui.
 */
export function TaskConversation({
  runId,
  messages,
}: {
  runId: string;
  messages: MessageView[];
}) {
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const enviar = useMutation(
    sendTaskMessageMutationOptions(queryClient, {
      onError: (thrown) => setErro(thrown.message),
      onSuccess: () => {
        setTexto("");
        setErro(null);
      },
    }),
  );

  return (
    <div className="flex flex-col gap-3">
      {messages.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nenhuma mensagem. Escreva abaixo para orientar a tarefa no meio do
          caminho.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {messages.map((message) => (
            <li
              key={message.seq}
              className="rounded-lg border p-2.5 text-sm"
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-xs">
                  {message.author === "person" ? "Você" : "Sistema"}
                </span>
                <span className="text-muted-foreground text-xs">
                  {new Date(message.createdAt).toLocaleString()}
                </span>
                {message.author === "system" && !message.deliveredAt ? (
                  <span className="text-muted-foreground text-xs">
                    ainda não entregue ao modelo
                  </span>
                ) : null}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{message.text}</p>
            </li>
          ))}
        </ol>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!texto.trim() || enviar.isPending) return;
          enviar.mutate({ runId, text: texto.trim() });
        }}
      >
        <Textarea
          aria-label="Responder à tarefa"
          disabled={enviar.isPending}
          placeholder="Oriente a tarefa…"
          rows={2}
          value={texto}
          onChange={(event) => setTexto(event.target.value)}
        />
        {erro ? (
          <p className="text-destructive text-sm" role="alert">
            {erro}
          </p>
        ) : null}
        <div>
          <Button
            disabled={!texto.trim() || enviar.isPending}
            type="submit"
          >
            {enviar.isPending ? "Enviando…" : "Enviar"}
          </Button>
        </div>
      </form>
    </div>
  );
}
