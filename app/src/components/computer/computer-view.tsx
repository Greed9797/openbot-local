import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ControlState,
  readControl,
  releaseControl,
  supplySecret,
  takeControl,
} from "@/lib/computers/control";
import { readScreenshot, type Screenshot } from "@/lib/computers/screen";
import { LiveScreen } from "./live-screen";
import { ComputerPlaceholder } from "./placeholder";

/** Explicit blank-browser URLs use placeholder artwork; missing URL fields are treated as real pages. */
function isBlankBrowser(shot: Screenshot): boolean {
  if (shot.url === undefined) return false;
  const url = shot.url.trim();
  return url === "" || url === "about:blank";
}

/** Default browser viewport ratio, reserved before the first screenshot arrives. */
const DEFAULT_ASPECT_RATIO = 1280 / 800;

/** Minimum readable inline screen size. */
const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 200;

/** Preload without failing the poll loop when a frame cannot be decoded early. */
async function preloadFrame(base64: string): Promise<void> {
  try {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
  } catch {
    // Let the visible image element handle decode failures.
  }
}

/** Identical frames in a row that mean the page has stopped changing. */
const SETTLED_FRAMES = 3;

/** Hard cap for post-action polling on pages that never settle. */
const SETTLE_TIMEOUT_MS = 30_000;

/** Short confirmation window after a secret is sent to the page. */
const SECRET_CONFIRM_MS = 6_000;

type Props = {
  /** Which computer to watch. One shared computer unless each Bot has been given its own. */
  computerId: string;
  /** Off by default so idle Bot screens do not poll indefinitely. */
  active?: boolean;
  /**
   * Assiste pelo socket de screencast, sem polling de screenshot.
   *
   * É o painel lateral: a tela chega quando muda, em vez de uma foto por segundo, e assistir não é
   * assumir o controle — o input fica no overlay depois que a pessoa toma o volante. O card do
   * transcript continua no polling barato, que para uma prévia basta.
   */
  live?: boolean;
  intervalMs?: number;
  /** Width divided by height. Overridable for a Bot whose computer is not the default shape. */
  aspectRatio?: number;
  minWidth?: number;
  minHeight?: number;
};

export function ComputerView({
  computerId,
  active = true,
  live = false,
  intervalMs = 1000,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
}: Props) {
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [control, setControl] = useState<ControlState | null>(null);
  /** Held only until it is sent. Never lifted into a URL, a log, or anything that outlives this form. */
  const [secret, setSecret] = useState("");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [sendingSecret, setSendingSecret] = useState(false);
  const driving = control?.holder === "human";
  /** Read by the polling loop without restarting it on control changes. */
  const drivingRef = useRef(false);
  drivingRef.current = driving;

  /**
   * Assistir pelo socket, e o estado de quem assiste.
   *
   * `liveViewer` é do viewer inteiro — desliga o polling mesmo quando o painel está em Activity, para
   * não existirem duas fontes de pixel competindo. `liveFrame` é "a conexão já desenhou", e é o que
   * separa "ao vivo" de "última imagem": sem ele, um socket aberto que nunca manda frame passava por
   * tela funcionando.
   */
  const liveViewer = live;
  const [liveFrame, setLiveFrame] = useState(false);
  const [liveProblem, setLiveProblem] = useState<string | null>(null);
  /** Remonta o stream. Reconectar é isto, explícito — não há laço automático de retentativa. */
  const [liveKey, setLiveKey] = useState(0);

  const onLiveFrame = useCallback(() => {
    setLiveFrame(true);
    setLiveProblem(null);
  }, []);

  const onLiveProblem = useCallback((next: string | null) => {
    setLiveProblem(next);
    // Um problema quer dizer que o que está no canvas é o passado, não a tela de agora.
    setLiveFrame(false);
  }, []);

  const reconnect = useCallback(() => {
    setLiveProblem(null);
    setLiveFrame(false);
    setLiveKey((key) => key + 1);
  }, []);

  /** Release control; the Bot's waiting tool call resumes from this state change. */
  const handBack = async () => {
    const state = await releaseControl(computerId);
    if (state) setControl(state);
  };
  /** Secret prompts keep the screen live even though the human does not hold the wheel. */
  const secretPending = Boolean(control?.secretWanted);
  const secretPendingRef = useRef(false);
  secretPendingRef.current = secretPending;
  // Held in a ref so a slow response cannot overwrite a newer frame after the component moved on.
  const generation = useRef(0);
  /** Force a short watch window after non-Bot actions such as secret entry. */
  const watchUntil = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `secretPending` intentionally restarts settled polling.
  useEffect(() => {
    /*
     * No viewer ao vivo quem entrega pixel é o socket. Um poll de screenshot aqui seria uma segunda
     * fonte para o mesmo quadro — e a foto velha venceria a discussão, porque chega depois.
     */
    if (liveViewer) return;

    const mine = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    // Consecutive identical frames observed during post-action settling.
    let unchanged = 0;
    let lastFrame = "";
    const graceStartedAt = Date.now();

    /** Continue while active, human-driven, secret-pending, or not yet visually settled. */
    const shouldContinue = () => {
      if (active) return true;
      if (drivingRef.current) return true;
      if (secretPendingRef.current) return true;
      if (Date.now() < watchUntil.current) return true;
      if (Date.now() - graceStartedAt > SETTLE_TIMEOUT_MS) return false;
      return unchanged < SETTLED_FRAMES;
    };

    // Always fetch at least one frame; only repeated refreshes are conditional.
    const tick = async () => {
      try {
        const { frame, error } = await readScreenshot(computerId);
        if (generation.current !== mine) return;

        if (!frame) {
          setProblem(error ?? "A tela não está disponível agora.");
        } else {
          // Exact byte comparison is the settling signal.
          unchanged = frame.base64 === lastFrame ? unchanged + 1 : 0;
          lastFrame = frame.base64;
          // Decode before swapping to avoid blanking the visible image during data URL changes.
          await preloadFrame(frame.base64);
          if (generation.current !== mine) return;
          setShot(frame);
          setProblem(null);
        }
      } finally {
        if (generation.current === mine && shouldContinue()) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    void tick();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [computerId, active, intervalMs, secretPending, liveViewer]);

  /** Poll control state independently from screenshot polling so help/secret prompts surface. */
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const state = await readControl(computerId);
      if (!live) return;
      if (state) setControl(state);
      timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [computerId]);

  // Input forwarding lives in LiveScreen on the socket.
  // Escape is bound to the window so it works regardless of overlay focus.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Sized from the ratio, never from the payload, so the frame is identical in all three states.
  const frameStyle = { aspectRatio, minWidth, minHeight };

  /**
   * Cada superfície é uma conexão: o inline e o overlay não dividem socket.
   *
   * Expandir, fechar, trocar de aba e trocar de Bot desmontam uma e montam a outra. Zerar no instante
   * em que a superfície muda evita que a tela nova apareça como "ao vivo" carregando o frame que a
   * anterior desenhou — inclusive o frame do Bot anterior, que é justamente o que um viewer que só
   * olha o socket aberto mostraria.
   */
  const liveSurface = `${computerId}:${expanded}:${active}`;
  const liveSurfaceRef = useRef(liveSurface);
  useEffect(() => {
    if (!liveViewer) return;
    if (liveSurfaceRef.current === liveSurface) return;
    liveSurfaceRef.current = liveSurface;
    setLiveFrame(false);
    setLiveProblem(null);
  }, [liveViewer, liveSurface]);

  // Always render the card frame; help/secret controls live below the conditional picture.
  const blankBrowser = shot ? isBlankBrowser(shot) : false;
  /** Blank browser placeholders should not be opened as readable screens. */
  const showScreen = shot !== null && !blankBrowser;

  const polledScreen = showScreen ? (
    <img
      src={`data:image/png;base64,${shot.base64}`}
      alt="O que o assistente está olhando"
      // Keep unexpected screenshot dimensions inside the reserved frame.
      className="absolute inset-0 h-full w-full object-contain opacity-100 transition-opacity duration-300 starting:opacity-0"
    />
  ) : null;

  /**
   * A tela do painel: socket, e um botão próprio para expandir.
   *
   * Fora do `<button>` de propósito. O canvas recebe evento de ponteiro, e um controle dentro de outro
   * é uma armadilha de teclado — o botão de expandir fica ao lado, focável e com rótulo.
   */
  const liveScreen =
    liveViewer && active && !expanded ? (
      <div className="relative block w-full bg-muted" style={frameStyle}>
        <LiveScreen
          key={liveKey}
          computerId={computerId}
          // Assistir não é dirigir: input é do overlay, e só com o controle tomado.
          driving={false}
          onFrame={onLiveFrame}
          onProblem={onLiveProblem}
        />
        {liveFrame ? null : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted p-4 text-center text-sm text-muted-foreground">
            <span>{liveProblem ?? "Conectando à tela…"}</span>
            {liveProblem ? (
              <button
                type="button"
                onClick={reconnect}
                className="rounded-md border bg-background px-2 py-1 text-xs font-medium"
              >
                Reconectar
              </button>
            ) : null}
          </span>
        )}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          // Expandir só depois do primeiro frame: sem ele não há tela maior para abrir.
          disabled={!liveFrame}
          aria-label="Abrir a tela do assistente em tamanho cheio"
          className="absolute right-2 bottom-2 rounded-md border bg-background/90 px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          Expandir
        </button>
      </div>
    ) : null;

  return (
    <>
      <figure className="overflow-hidden rounded-2xl border">
        {liveScreen ?? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            // Disabled while blank/waiting but still reserves the frame.
            disabled={!showScreen}
            className="relative block w-full bg-muted enabled:cursor-zoom-in"
            style={frameStyle}
            aria-label="Abrir a tela do assistente em tamanho cheio"
          >
            {polledScreen}

            {blankBrowser ? (
              <ComputerPlaceholder className="absolute inset-0 h-full w-full" />
            ) : null}

            {showScreen ? null : (
              <span
                className={`absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-sm ${
                  blankBrowser
                    ? "bg-black/25 text-white"
                    : "text-muted-foreground"
                }`}
              >
                {problem ? (
                  <>
                    <span className="font-medium">
                      Você não consegue ver a tela agora
                    </span>
                    <span>{problem}</span>
                    <span
                      className={blankBrowser ? "text-white/80" : undefined}
                    >
                      O assistente pode ainda estar trabalhando. Um
                      administrador consegue checar se o computador dele está de
                      pé.
                    </span>
                  </>
                ) : blankBrowser ? (
                  <span>O assistente ainda não abriu nenhuma página.</span>
                ) : (
                  <span>Esperando a tela do assistente…</span>
                )}
              </span>
            )}
          </button>
        )}

        {/*
          Secret values go directly to the page path and are never included in the conversation.
          Audit records that a secret was supplied, not the value.
        */}
        {control?.secretWanted ? (
          <form
            className="border-t bg-muted/40 px-3 py-2 text-sm"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!secret || sendingSecret) return;
              setSendingSecret(true);
              watchUntil.current = Date.now() + SECRET_CONFIRM_MS;
              const result = await supplySecret(computerId, secret);
              setSendingSecret(false);
              // Clear even on failure so plaintext is not left in the DOM.
              setSecret("");
              setSecretProblem(result.ok ? null : (result.error ?? null));
              const state = await readControl(computerId);
              if (state) setControl(state);
            }}
          >
            <label className="block" htmlFor="openbot-secret">
              <span className="font-medium">O assistente precisa de </span>
              <span>{control.secretWanted}</span>
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="openbot-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Digitado aqui, nunca mostrado ao assistente"
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
              />
              <button
                type="submit"
                disabled={!secret || sendingSecret}
                className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {sendingSecret ? "Sending…" : "Enviar para a página"}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Isto vai direto para a página. Não aparece na conversa e o
              assistente nunca recebe.
            </p>
            {secretProblem ? (
              <p className="mt-1 text-xs text-destructive">{secretProblem}</p>
            ) : null}
          </form>
        ) : null}

        {driving ? (
          <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-3 py-2 text-sm">
            <span>Você está no controle deste navegador.</span>
            <span className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="rounded-md border px-3 py-1 text-xs font-medium"
              >
                Open full size
              </button>
              <button
                type="button"
                onClick={() => void handBack()}
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              >
                Hand back
              </button>
            </span>
          </div>
        ) : null}

        {control?.requested && !driving ? (
          <div className="flex items-start justify-between gap-3 border-t bg-amber-500/10 px-3 py-2 text-sm">
            <span>
              <strong className="font-medium">
                O assistente precisa de você.
              </strong>{" "}
              {control.reason}
            </span>
            <button
              type="button"
              onClick={async () => {
                const state = await takeControl(computerId);
                if (state) setControl(state);
                setExpanded(true);
              }}
              className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
            >
              Take control
            </button>
          </div>
        ) : null}
      </figure>

      {/*
        Portal to body so fixed positioning is measured against the viewport, not containing panes.
      */}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="A tela do assistente"
              className="fixed inset-0 z-50 flex flex-col p-4 sm:p-8"
            >
              {/* Backdrop closes only while read-only; during driving, Escape remains the exit. */}
              <button
                type="button"
                onClick={() => !driving && setExpanded(false)}
                aria-label="Fechar a tela do assistente"
                aria-hidden={driving}
                tabIndex={driving ? -1 : 0}
                className={`absolute inset-0 bg-black/80 ${driving ? "cursor-default" : "cursor-zoom-out"}`}
              />
              <div className="relative mb-3 flex items-center justify-between gap-4 text-sm text-white">
                <span className="pointer-events-none">
                  {driving ? (
                    <>
                      <strong className="font-medium">
                        Você está no controle.
                      </strong>{" "}
                      Clique e digite na página como você faria normalmente.
                      {control?.reason ? ` ${control.reason}` : null}
                    </>
                  ) : (
                    <>The assistant's screen{active ? ", updating live" : ""}</>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {driving ? (
                    <button
                      type="button"
                      onClick={() => {
                        setExpanded(false);
                        void handBack();
                      }}
                      className="rounded-md bg-white px-3 py-1 text-xs font-medium text-black"
                    >
                      Devolver ao assistente
                    </button>
                  ) : control?.requested ? (
                    <button
                      type="button"
                      onClick={async () => {
                        const state = await takeControl(computerId);
                        if (state) setControl(state);
                      }}
                      className="rounded-md bg-white px-3 py-1 text-xs font-medium text-black"
                    >
                      Take control
                    </button>
                  ) : null}
                  <span className="pointer-events-none text-white/70">
                    {driving
                      ? "Aperte Escape para fechar"
                      : "Clique em qualquer lugar ou aperte Escape para fechar"}
                  </span>
                </span>
              </div>
              {/*
                Overlay uses the live socket; the inline card keeps low-cost polling. No modo ao vivo
                o inline já foi desmontado antes deste montar, então existe um socket só.
              */}
              <div className="relative min-h-0 flex-1 overflow-auto rounded-lg bg-black">
                {liveViewer ? (
                  <>
                    <LiveScreen
                      key={`overlay-${liveKey}`}
                      computerId={computerId}
                      driving={driving}
                      onFrame={onLiveFrame}
                      onProblem={onLiveProblem}
                    />
                    {liveFrame ? null : (
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/80">
                        <span>{liveProblem ?? "Conectando à tela…"}</span>
                        {liveProblem ? (
                          <button
                            type="button"
                            onClick={reconnect}
                            className="rounded-md bg-white px-3 py-1 text-xs font-medium text-black"
                          >
                            Reconectar
                          </button>
                        ) : null}
                      </span>
                    )}
                  </>
                ) : (
                  <LiveScreen
                    computerId={computerId}
                    driving={driving}
                    onProblem={setProblem}
                  />
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
