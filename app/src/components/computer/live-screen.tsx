import { useCallback, useEffect, useRef, useState } from "react";
import { pageCoordinates } from "./take-the-wheel";

/**
 * Low-latency screencast used while a human is driving the Bot's browser.
 *
 * The inline card keeps using cheap polling for passive watching. This view uses Chrome's
 * screencast socket so input and visual feedback stay synchronized during takeover.
 *
 * Follows Chrome DevTools' own `InputModel.ts` (BSD-3) for the event translation and
 * `steel-dev/steel-browser`'s casting handler (Apache-2.0) for the frame loop, because no maintained
 * library publishes this and every real implementation is one app-internal file.
 */

/**
 * CDP's modifier bitmask. Alt 1, Control 2, Meta 4, Shift 8.
 *
 * Needed or a capital letter typed with Shift arrives lower-case, and Ctrl+A selects nothing.
 */
function modifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

type Props = {
  /**
   * Computer identity is part of the stream URL so input and frames stay scoped to the active Bot.
   */
  computerId: string;
  /** Whether the user currently holds the wheel. Input is only sent when true. */
  driving: boolean;
  /** Called with a human-readable reason when the stream cannot be established. */
  onProblem?: (problem: string | null) => void;
  /**
   * Chamado uma vez por conexão, depois do primeiro frame desenhado.
   *
   * É o que um consumidor usa para dizer "está no ar" sem confiar no upgrade — quem só olha o socket
   * aberto mostra a última imagem parada como se fosse a tela de agora.
   */
  onFrame?: () => void;
};

type AgentPointer = { x: number; y: number; width: number; height: number };
type ClickPulse = AgentPointer & { key: number };

/** Hide the last-known arrow this long after the event; it must not look live forever. */
const POINTER_LINGER_MS = 2000;
/** One click ring lives exactly this long; a new click replaces it. */
const PULSE_MS = 450;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Discard, never clamp: a corrected position would point at something the agent never touched. */
function validPointer(message: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): AgentPointer | null {
  const { x, y, width, height } = message;
  if (!finiteNumber(x) || !finiteNumber(y)) return null;
  if (!finiteNumber(width) || !finiteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  return { x, y, width, height };
}
export function LiveScreen({ computerId, driving, onProblem, onFrame }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** The size of the frames Chrome is sending, which is what input coordinates are relative to. */
  const frameSize = useRef<{ width: number; height: number } | null>(null);
  const drivingRef = useRef(driving);
  const [agentPointer, setAgentPointer] = useState<AgentPointer | null>(null);
  const [pulse, setPulse] = useState<ClickPulse | null>(null);
  const [pointerMissing, setPointerMissing] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const pulseTimer = useRef<number | undefined>(undefined);
  const pulseAnimation = useRef<Animation | null>(null);
  const pulseKey = useRef(0);
  const ringRef = useRef<HTMLSpanElement | null>(null);

  const clearOverlays = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(pulseTimer.current);
    hideTimer.current = undefined;
    pulseTimer.current = undefined;
    pulseAnimation.current?.cancel();
    pulseAnimation.current = null;
    setAgentPointer(null);
    setPulse(null);
    setPointerMissing(false);
  }, []);
  const [connected, setConnected] = useState(false);
  /** `connected` é "a conexão já desenhou um frame", e `data-connected` o publica no DOM. */

  useEffect(() => {
    // Same origin, so the scheme follows the page: wss when the app is served over https.
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/api/computers/${encodeURIComponent(computerId)}/stream`,
    );
    socketRef.current = socket;
    let closed = false;
    /**
     * Um socket aberto não é uma tela.
     *
     * `onopen` diz que o upstream aceitou o upgrade, e nada mais: um computador que aceita a conexão
     * e nunca manda frame — Chromium morto, screencast que não sobe — passava por "ao vivo" com a
     * última imagem parada no canvas. O estado de conectado agora só vira verdade quando um frame foi
     * decodificado e desenhado.
     */
    let drewFrame = false;
    // Fresh state for this Bot: a marker from the previous one must never survive the switch.
    clearOverlays();
    setConnected(false);
    /* Frames decode out of order. Only the newest may paint, or an old decode lands on top of the
     * screen the pointer already left — and every discarded bitmap is released, not leaked. */
    let receivedSeq = 0;
    let drawnSeq = 0;

    const notePointer = (pointer: {
      event?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }) => {
      if (pointer.event === "reset") {
        clearOverlays();
        return;
      }
      if (pointer.event === "unavailable") {
        window.clearTimeout(hideTimer.current);
        window.clearTimeout(pulseTimer.current);
        hideTimer.current = undefined;
        pulseTimer.current = undefined;
        pulseAnimation.current?.cancel();
        pulseAnimation.current = null;
        setAgentPointer(null);
        setPulse(null);
        if (!drivingRef.current) setPointerMissing(true);
        return;
      }
      if (pointer.event !== "move" && pointer.event !== "click") return;
      // While driving, and before the first painted frame, positions are dropped: a pre-frame click
      // must never resurface later as if it just happened.
      if (drivingRef.current || !drewFrame) return;
      const at = validPointer(pointer);
      if (!at) return;
      setPointerMissing(false);
      setAgentPointer(at);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(
        () => setAgentPointer(null),
        POINTER_LINGER_MS,
      );
      if (pointer.event === "click") {
        const key = pulseKey.current + 1;
        pulseKey.current = key;
        setPulse({ ...at, key });
        window.clearTimeout(pulseTimer.current);
        pulseTimer.current = window.setTimeout(() => {
          setPulse((current) => (current?.key === key ? null : current));
        }, PULSE_MS);
      }
    };

    socket.onmessage = async (event) => {
      let message: {
        type: string;
        event?: string;
        data?: string;
        width?: number;
        height?: number;
        x?: number;
        y?: number;
        error?: string;
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "error") {
        onProblem?.(message.error ?? "Não foi possível mostrar a tela.");
        clearOverlays();
        return;
      }
      // The cursor never marks the connection alive and never paints: only frames do either.
      if (message.type === "pointer") {
        notePointer(message);
        return;
      }
      if (message.type !== "frame" || !message.data) return;
      const mySeq = receivedSeq + 1;
      receivedSeq = mySeq;

      const canvas = canvasRef.current;
      if (!canvas || closed) return;

      frameSize.current = {
        width: message.width ?? 1280,
        height: message.height ?? 800,
      };

      /**
       * Decoded off the main thread and drawn as a bitmap.
       *
       * `createImageBitmap` rather than assigning a data URI to an `<img>`: the image path decodes
       * synchronously on the main thread for every frame, which at screencast rates is the difference
       * between a smooth page and one that stutters while you are trying to click something on it.
       */
      try {
        const binary = Uint8Array.from(atob(message.data), (c) =>
          c.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([binary], { type: "image/jpeg" }),
        );
        if (closed || mySeq <= drawnSeq) {
          bitmap.close();
          return;
        }
        drawnSeq = mySeq;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        // Ignore a single corrupt frame; the next frame replaces it.
        return;
      }

      if (!drewFrame) {
        drewFrame = true;
        setConnected(true);
        // Só agora a conexão provou que funciona; até aqui, um socket aberto podia ser uma tela parada.
        onProblem?.(null);
      }
      onFrame?.();
    };

    socket.onerror = () => {
      setConnected(false);
      clearOverlays();
      onProblem?.("Não foi possível alcançar a tela ao vivo.");
    };
    socket.onclose = () => {
      // Fechar por desmontagem não é queda. `closed` é o que separa as duas, e sem ele trocar de aba
      // deixaria o painel anunciando que a tela caiu.
      if (closed) return;
      setConnected(false);
      clearOverlays();
      onProblem?.("Tela desconectada. Reconecte para continuar.");
    };

    return () => {
      closed = true;
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(pulseTimer.current);
      pulseAnimation.current?.cancel();
      pulseAnimation.current = null;
      socket.close();
      socketRef.current = null;
    };
    /*
     * `onProblem` e `onFrame` entram na lista porque o efeito os lê, e um consumidor que passe funções
     * novas a cada render reconectaria a cada render. O contrato é do consumidor: estáveis (setState
     * ou `useCallback`).
     */
  }, [computerId, onProblem, onFrame, clearOverlays]);

  /**
   * Taking the wheel hides the agent marker outright. Handing back waits for a fresh event rather
   * than resurrecting the old position.
   */
  useEffect(() => {
    drivingRef.current = driving;
    if (driving) clearOverlays();
  }, [driving, clearOverlays]);

  /** One ring per click, driven by the Web Animations API; the next click cancels this one. */
  useEffect(() => {
    if (!pulse) return;
    const node = ringRef.current;
    if (!node) return;
    pulseAnimation.current?.cancel();
    pulseAnimation.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = node.animate(
      [
        { transform: "translate(-50%, -50%) scale(0.6)", opacity: "1" },
        { transform: "translate(-50%, -50%) scale(1)", opacity: "0" },
      ],
      { duration: PULSE_MS, easing: "ease-out" },
    );
    pulseAnimation.current = animation;
    return () => {
      animation.cancel();
      if (pulseAnimation.current === animation) pulseAnimation.current = null;
    };
  }, [pulse]);

  const send = useCallback(
    (message: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (!driving || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message));
    },
    [driving],
  );

  /**
   * Convert from displayed canvas coordinates to page coordinates with the shared, tested helper.
   * A screencast frame is the viewport, so its frame size stands in for natural image size.
   */
  const at = useCallback((event: React.MouseEvent) => {
    const canvas = canvasRef.current;
    const size = frameSize.current;
    if (!canvas || !size) return null;
    return pageCoordinates(
      { naturalWidth: size.width, naturalHeight: size.height },
      canvas.getBoundingClientRect(),
      event,
    );
  }, []);

  const onMouse = useCallback(
    (kind: "pressed" | "released" | "moved") =>
      (event: React.MouseEvent<HTMLCanvasElement>) => {
        const point = at(event);
        if (!point) return;
        send({
          type: "mouse",
          event: kind,
          ...point,
          button:
            event.button === 2
              ? "right"
              : event.button === 1
                ? "middle"
                : "left",
          clickCount: kind === "moved" ? 0 : 1,
          modifiers: modifierBits(event),
        });
      },
    [at, send],
  );

  /**
   * Keystrokes, forwarded while driving.
   *
   * Listen on window because canvas cannot hold focus. `preventDefault` keeps Tab and typing directed
   * at the remote page while takeover is active.
   */
  useEffect(() => {
    if (!driving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return; // Escape still closes the view.
      event.preventDefault();
      send({
        type: "key",
        event: "down",
        key: event.key,
        code: event.code,
        // Only a printable character carries text. Sending text for Backspace makes Chrome insert a
        // character instead of deleting one.
        ...(event.key.length === 1 ? { text: event.key } : {}),
        modifiers: modifierBits(event),
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      event.preventDefault();
      send({
        type: "key",
        event: "up",
        key: event.key,
        code: event.code,
        modifiers: modifierBits(event),
      });
    };
    /** Paste arrives as one block; CDP inserts it as text rather than key events. */
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text");
      if (!text) return;
      event.preventDefault();
      send({ type: "text", text });
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  }, [driving, send]);

  const showMarker = connected && !driving && agentPointer !== null;
  const showPulse = connected && !driving && pulse !== null;
  const showMissing = connected && !driving && pointerMissing;
  const markerLeft = agentPointer
    ? (agentPointer.x / agentPointer.width) * 100
    : 0;
  const markerTop = agentPointer
    ? (agentPointer.y / agentPointer.height) * 100
    : 0;
  const pulseLeft = pulse ? (pulse.x / pulse.width) * 100 : 0;
  const pulseTop = pulse ? (pulse.y / pulse.height) * 100 : 0;
  // The label flips sides near the edges so it stays inside the picture without covering the tip.
  const flipLabelX = agentPointer
    ? agentPointer.x / agentPointer.width > 0.72
    : false;
  const flipLabelY = agentPointer
    ? agentPointer.y / agentPointer.height > 0.72
    : false;

  return (
    <div className="relative block w-full">
      <canvas
        ref={canvasRef}
        className={`block h-auto w-full ${driving ? "cursor-crosshair" : ""}`}
        // Only forward input during takeover.
        {...(driving
          ? {
              onMouseDown: onMouse("pressed"),
              onMouseUp: onMouse("released"),
              onMouseMove: onMouse("moved"),
              onContextMenu: (event: React.MouseEvent) =>
                event.preventDefault(),
              onWheel: (event: React.WheelEvent<HTMLCanvasElement>) => {
                const point = at(event);
                if (!point) return;
                event.preventDefault();
                send({
                  type: "wheel",
                  ...point,
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                  modifiers: modifierBits(event),
                });
              },
            }
          : {})}
        aria-label={
          driving
            ? "A tela do assistente. Você está no controle: clique e digite aqui."
            : "A tela do assistente, ao vivo"
        }
        data-connected={connected}
      />
      {/* Static legend: names the feature once instead of announcing every move. */}
      <span className="sr-only">Cursor da IA</span>
      {/* Decorations never take input: the canvas underneath keeps every event. */}
      <div className="pointer-events-none absolute inset-0">
        <div aria-hidden className="absolute inset-0">
          {showMarker && agentPointer ? (
            <span
              style={{
                position: "absolute",
                left: `${markerLeft}%`,
                top: `${markerTop}%`,
                width: 0,
                height: 0,
                overflow: "visible",
              }}
            >
              <svg
                width="20"
                height="24"
                viewBox="0 0 20 24"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  overflow: "visible",
                  filter: "drop-shadow(0 1px 1px rgb(0 0 0 / 0.6))",
                }}
                className="fill-primary stroke-white"
                strokeWidth="1.5"
                strokeLinejoin="round"
              >
                <title>Cursor da IA</title>
                <path d="M3 2 L3 18.5 L8 14 L10.5 20 L13 18.8 L10.5 13 L15.5 13 Z" />
              </svg>
              <span
                className="rounded border bg-background px-1 text-[10px] font-semibold leading-4 text-foreground"
                style={{
                  position: "absolute",
                  left: flipLabelX ? undefined : 22,
                  right: flipLabelX ? 22 : undefined,
                  top: flipLabelY ? undefined : 24,
                  bottom: flipLabelY ? 24 : undefined,
                  whiteSpace: "nowrap",
                }}
              >
                IA
              </span>
            </span>
          ) : null}
          {showPulse && pulse ? (
            <span
              key={pulse.key}
              ref={ringRef}
              className="border-primary"
              style={{
                position: "absolute",
                left: `${pulseLeft}%`,
                top: `${pulseTop}%`,
                width: 40,
                height: 40,
                transform: "translate(-50%, -50%)",
                borderRadius: 9999,
                borderWidth: 2,
                borderStyle: "solid",
              }}
            />
          ) : null}
        </div>
        {showMissing ? (
          <span
            role="status"
            className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md border bg-background/90 px-2 py-0.5 text-xs text-muted-foreground"
          >
            Posição do cursor indisponível
          </span>
        ) : null}
      </div>
    </div>
  );
}
