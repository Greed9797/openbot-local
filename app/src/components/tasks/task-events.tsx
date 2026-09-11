import type { EventView } from "@/lib/tasks/queries";

/**
 * A linha do tempo bruta da tarefa.
 *
 * Os eventos são o diário de bordo para depurar ("o que aconteceu, em que ordem"); a leitura
 * narrativa vive nos passos e na conversa. A carga de cada evento fica dobrada num `<details>`
 * porque o tipo e a hora bastam na varredura, e o JSON inteiro só interessa quando algo quebrou.
 */
export function TaskEvents({ events }: { events: EventView[] }) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nenhum evento ainda.
      </p>
    );
  }
  return (
    <ol className="flex flex-col">
      {events.map((event) => (
        <li key={event.seq} className="flex gap-3 py-1.5 text-sm">
          <span className="w-10 shrink-0 font-mono text-muted-foreground text-xs leading-6">
            {event.seq}
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-words font-mono text-xs">{event.type}</p>
            <p className="text-muted-foreground text-xs">
              {new Date(event.createdAt).toLocaleString()}
            </p>
            {Object.keys(event.payload).length > 0 ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
                  Ver dados
                </summary>
                <pre className="mt-1 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs leading-relaxed">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
