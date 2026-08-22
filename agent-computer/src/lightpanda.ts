/**
 * Lightpanda: um segundo motor, para as páginas que ninguém precisa ver.
 *
 * O navegador que o Bot dirige é o Chromium, e continua sendo. Este arquivo não o substitui, e não
 * pode: o Lightpanda não tem motor gráfico. Medido, não suposto — `Page.captureScreenshot` responde
 * com sucesso e devolve um PNG de aviso escrito "Lightpanda has no graphical rendering engine", e
 * `Page.startScreencast` não existe. Qualquer coisa que a pessoa assiste na tela é Chromium.
 *
 * O que ele faz bem é o resto: navegar, rodar o JavaScript da página e devolver o texto, gastando uma
 * fração da memória e do tempo. Para "leia esta página e me diga o que tem", subir um Chromium
 * inteiro é caro sem motivo.
 *
 * Falado por CDP cru, e não por Playwright, porque `connectOverCDP` não completa o aperto de mão com
 * ele — o socket abre e o Playwright fica esperando. Os métodos usados aqui foram verificados um a
 * um contra o binário.
 */

const ENDPOINT =
  process.env.LIGHTPANDA_CDP_URL?.trim() || "ws://lightpanda:9222";

/** Quanto uma página pode demorar antes de desistirmos, em milissegundos. */
const TIMEOUT_MS = Number.parseInt(
  process.env.LIGHTPANDA_TIMEOUT_MS ?? "30000",
  10,
);

export type FetchedPage = {
  url: string;
  title: string;
  text: string;
  links: { text: string; href: string }[];
};

/** Um pedido CDP em voo, esperando a resposta com o mesmo id. */
type Pending = (message: {
  result?: unknown;
  error?: { message: string };
}) => void;

/**
 * Abre uma conexão, faz o trabalho e fecha.
 *
 * Uma conexão por página em vez de uma piscina: o Lightpanda liga instantaneamente e a alternativa
 * seria guardar estado de sessão entre páginas que nada tem a ver uma com a outra, que é justamente
 * o que o computador persistente do Chromium existe para fazer.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const socket = new WebSocket(ENDPOINT);
  const pending = new Map<number, Pending>();
  let nextId = 0;

  const send = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) =>
    new Promise<{ result?: unknown; error?: { message: string } }>(
      (resolve, reject) => {
        const id = ++nextId;
        pending.set(id, resolve);
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
        setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`O Lightpanda não respondeu a ${method}.`));
          }
        }, TIMEOUT_MS);
      },
    );

  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("O Lightpanda não aceitou a conexão.")),
        TIMEOUT_MS,
      );
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("O Lightpanda não pôde ser alcançado."));
      };
    });

    const target = await send("Target.createTarget", { url: "about:blank" });
    const targetId = (target.result as { targetId?: string } | undefined)
      ?.targetId;
    if (!targetId) throw new Error("O Lightpanda não abriu uma aba.");

    const attached = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const session = (attached.result as { sessionId?: string } | undefined)
      ?.sessionId;
    if (!session) throw new Error("O Lightpanda não anexou a aba.");

    await send("Page.enable", {}, session);
    const navigated = await send("Page.navigate", { url }, session);
    if (navigated.error) throw new Error(navigated.error.message);

    /*
     * Uma única avaliação em vez de várias idas e voltas: título, texto e links saem do mesmo
     * instante da página, então não descrevem três momentos diferentes de um documento que ainda
     * está carregando.
     */
    const evaluated = await send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const links = [...document.querySelectorAll("a[href]")]
            .map((a) => ({ text: (a.textContent || "").trim().slice(0, 120), href: a.href }))
            .filter((l) => l.text)
            .slice(0, 100);
          return JSON.stringify({
            url: location.href,
            title: document.title || "",
            text: (document.body ? document.body.innerText : "").slice(0, 40000),
            links,
          });
        })()`,
        returnByValue: true,
      },
      session,
    );

    const value = (
      evaluated.result as { result?: { value?: string } } | undefined
    )?.result?.value;
    if (!value) throw new Error("O Lightpanda não devolveu a página.");

    return JSON.parse(value) as FetchedPage;
  } finally {
    socket.close();
  }
}
