/**
 * Observational pointer tracking for the live screen.
 *
 * Watches where the agent's pointer is and where it clicks, so the surface can draw a marker that is
 * separate from the human cursor. Observational only: nothing here moves, clicks, or grants control.
 * Execution stays in `refs.ts`/`index.ts` untouched.
 */
import type { ElementHandle, Frame, Page } from "playwright";

/** Caller identity, provided by Playwright itself — never trusted from the document. */
type BindingSource = { page: Page; frame: Frame };

/** What the surface receives. Positions are always main-viewport CSS px, never JPEG or screen px. */
export type ObservedPointer =
  | {
      event: "move" | "click";
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | { event: "reset" | "unavailable" };

export type PointerHandle = {
  /** Idempotent. Marks inactive before any await so late callbacks cannot emit. */
  stop: () => Promise<void>;
};

let observerSeq = 0;

/** Max observed moves forwarded per second; the latest position wins, no queue. */
const MOVE_BUDGET_MS = 33;
/** Unmappable moves re-announce at most this often; clicks always announce. */
const UNAVAILABLE_RESEND_MS = 1000;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The install script, run in every document (init script for future navigations, evaluated directly
 * in documents that already exist). Capture + passive: never intercepts, never blocks scrolling.
 */
function installSource(bindingName: string, teardownName: string): string {
  const binding = JSON.stringify(bindingName);
  const teardown = JSON.stringify(teardownName);
  return `(() => {
  const hook = window[${binding}];
  if (typeof hook !== "function") return;
  try {
    const prior = window[${teardown}];
    if (typeof prior === "function") prior();
  } catch {}
  const report = (kind, event) => {
    try {
      if (!event.isTrusted) return;
      if (event.pointerType === "touch") return;
      const done = hook({
        kind,
        clientX: event.clientX,
        clientY: event.clientY,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      });
      if (done && typeof done.catch === "function") done.catch(() => {});
    } catch {}
  };
  const onMove = (event) => report("move", event);
  const onClick = (event) => report("click", event);
  window.addEventListener("pointermove", onMove, { capture: true, passive: true });
  window.addEventListener("click", onClick, { capture: true, passive: true });
  window[${teardown}] = () => {
    window.removeEventListener("pointermove", onMove, { capture: true });
    window.removeEventListener("click", onClick, { capture: true });
    try {
      delete window[${teardown}];
    } catch {
      window[${teardown}] = undefined;
    }
  };
})();`;
}

/**
 * Runs inside the parent frame against one iframe element plus its ancestors. Accepts no transform,
 * or a 2D matrix with b=c=0 and positive a/d: border, scroll and axis-aligned positive scale are
 * already inside boundingBox, while rotation/skew/perspective/3D cannot be mapped safely.
 * Standalone on purpose: Playwright serializes this into the page, so it must close over nothing.
 */
function frameLineMappable(element: Element): boolean {
  const allowedMatrix = (t: string): boolean => {
    if (t === "none") return true;
    const m = /^matrix\(([^)]+)\)$/.exec(t);
    if (!m?.[1]) return false;
    const parts = m[1].split(",").map((s) => Number(s.trim()));
    if (parts.length !== 6) return false;
    const a = parts[0];
    const b = parts[1];
    const c = parts[2];
    const d = parts[3];
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      !Number.isFinite(c) ||
      !Number.isFinite(d)
    ) {
      return false;
    }
    return b === 0 && c === 0 && (a as number) > 0 && (d as number) > 0;
  };
  let node: Element | null = element;
  while (node !== null) {
    let style: CSSStyleDeclaration | null = null;
    try {
      style = window.getComputedStyle(node);
    } catch {
      return false;
    }
    if (style === null) return false;
    if (!allowedMatrix(style.transform)) return false;
    const rotate = style.getPropertyValue("rotate").trim();
    if (rotate !== "" && rotate !== "none" && rotate !== "0deg") return false;
    const scale = style.getPropertyValue("scale").trim();
    if (
      scale !== "" &&
      scale !== "none" &&
      scale !== "1" &&
      scale !== "1 1" &&
      scale !== "1 1 1"
    ) {
      return false;
    }
    const perspective = style.getPropertyValue("perspective").trim();
    if (perspective !== "" && perspective !== "none") return false;
    node = node.parentElement;
  }
  return true;
}

/** Standalone like above: reads the iframe element's layout metrics in its parent frame. */
function frameMetrics(element: Element): {
  offsetWidth: number;
  offsetHeight: number;
  clientLeft: number;
  clientTop: number;
} {
  const el = element as HTMLElement;
  return {
    offsetWidth: el.offsetWidth,
    offsetHeight: el.offsetHeight,
    clientLeft: el.clientLeft,
    clientTop: el.clientTop,
  };
}

export async function observePointer(
  page: Page,
  emit: (event: ObservedPointer) => void,
): Promise<PointerHandle> {
  const id = `${Date.now().toString(36)}${(observerSeq++).toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
  const bindingName = `__openbotPointer_${id}`;
  const teardownName = `__openbotPointerTeardown_${id}`;
  const script = installSource(bindingName, teardownName);

  let active = true;
  // Bumped on stop and on main-frame navigation so late async mapping work is discarded.
  let generation = 0;
  let lastEmitAt = 0;
  let lastUnavailableAt = 0;
  let unavailableSent = false;
  let pendingMove: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;
  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  // Main-viewport dimensions, learned from main-frame reports; iframe clicks refresh them directly.
  let mainDims: { width: number; height: number } | null = null;

  const clearPending = () => {
    pendingMove = null;
    if (moveTimer !== undefined) {
      clearTimeout(moveTimer);
      moveTimer = undefined;
    }
  };

  /** A mapped position is back: the next unmappable event must announce again. */
  const forwardPosition = (
    event: "move" | "click",
    point: { x: number; y: number; width: number; height: number },
  ) => {
    if (!active) return;
    lastEmitAt = Date.now();
    unavailableSent = false;
    emit({ event, ...point });
  };

  const forwardUnavailable = (always: boolean) => {
    if (!active) return;
    const now = Date.now();
    if (!always) {
      if (unavailableSent || now - lastUnavailableAt < UNAVAILABLE_RESEND_MS)
        return;
    }
    lastUnavailableAt = now;
    unavailableSent = true;
    emit({ event: "unavailable" });
  };

  const scheduleMove = (point: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => {
    const wait = MOVE_BUDGET_MS - (Date.now() - lastEmitAt);
    if (wait <= 0) {
      clearPending();
      forwardPosition("move", point);
      return;
    }
    pendingMove = point;
    if (moveTimer === undefined) {
      moveTimer = setTimeout(() => {
        moveTimer = undefined;
        const latest = pendingMove;
        pendingMove = null;
        if (latest !== null) forwardPosition("move", latest);
      }, wait);
    }
  };

  const readMainDims = async (
    gen: number,
  ): Promise<{ width: number; height: number } | null> => {
    try {
      const dims = await page
        .mainFrame()
        .evaluate((): { w: number; h: number } => ({
          w: window.innerWidth,
          h: window.innerHeight,
        }));
      if (!active || gen !== generation) return null;
      if (
        !dims ||
        !finite(dims.w) ||
        !finite(dims.h) ||
        dims.w <= 0 ||
        dims.h <= 0
      )
        return null;
      return { width: dims.w, height: dims.h };
    } catch {
      return null;
    }
  };

  const disposeHandle = async (handle: ElementHandle): Promise<void> => {
    await handle.dispose().catch(() => undefined);
  };

  /**
   * Map one trusted document event to main-viewport CSS px. Null means "cannot be mapped safely":
   * the caller emits `unavailable`, never a guess.
   */
  const mapReport = async (
    sourceFrame: Frame,
    clientX: number,
    clientY: number,
    innerWidth: number,
    innerHeight: number,
    isClick: boolean,
    gen: number,
  ): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null> => {
    if (sourceFrame === page.mainFrame()) {
      mainDims = { width: innerWidth, height: innerHeight };
      return { x: clientX, y: clientY, width: innerWidth, height: innerHeight };
    }
    // Iframe, possibly cross-origin and nested: the innermost element's box is already
    // main-relative and folds every ancestor level in, but every level's transforms are checked.
    const main = page.mainFrame();
    let cursor: Frame | null = sourceFrame;
    let box: { x: number; y: number; width: number; height: number } | null =
      null;
    let metrics: {
      offsetWidth: number;
      offsetHeight: number;
      clientLeft: number;
      clientTop: number;
    } | null = null;
    while (cursor !== null && cursor !== main) {
      const element = await cursor.frameElement().catch(() => null);
      if (!active || gen !== generation) return null;
      if (element === null) return null;
      try {
        const mappable = await element
          .evaluate(frameLineMappable)
          .catch(() => false);
        if (!active || gen !== generation) return null;
        if (mappable !== true) return null;
        if (box === null) {
          const measured = await element.boundingBox().catch(() => null);
          if (!active || gen !== generation) return null;
          if (measured === null) return null;
          const sizes = await element.evaluate(frameMetrics).catch(() => null);
          if (!active || gen !== generation) return null;
          if (sizes === null) return null;
          box = measured;
          metrics = sizes;
        }
      } finally {
        await disposeHandle(element);
      }
      cursor = cursor.parentFrame();
    }
    if (box === null || metrics === null) return null;
    if (
      !finite(box.x) ||
      !finite(box.y) ||
      !finite(box.width) ||
      !finite(box.height) ||
      box.width <= 0 ||
      box.height <= 0 ||
      !finite(metrics.offsetWidth) ||
      !finite(metrics.offsetHeight) ||
      metrics.offsetWidth <= 0 ||
      metrics.offsetHeight <= 0 ||
      !finite(metrics.clientLeft) ||
      !finite(metrics.clientTop)
    ) {
      return null;
    }
    // Clicks need the position to be right: read the main viewport fresh. Moves reuse the cache.
    let viewport = mainDims;
    if (isClick || viewport === null) {
      viewport = await readMainDims(gen);
      if (viewport === null) return null;
      if (!isClick) mainDims = viewport;
      else mainDims = viewport;
    }
    const sx = box.width / metrics.offsetWidth;
    const sy = box.height / metrics.offsetHeight;
    if (!finite(sx) || !finite(sy) || sx <= 0 || sy <= 0) return null;
    const x = box.x + (metrics.clientLeft + clientX) * sx;
    const y = box.y + (metrics.clientTop + clientY) * sy;
    if (!finite(x) || !finite(y)) return null;
    return { x, y, width: viewport.width, height: viewport.height };
  };

  const onBinding = async (
    source: BindingSource,
    payload: unknown,
  ): Promise<void> => {
    if (!active) return;
    // Informative only: malformed or unexpected payloads are ignored, never acted on.
    if (typeof payload !== "object" || payload === null) return;
    const report = payload as Record<string, unknown>;
    if (report.kind !== "move" && report.kind !== "click") return;
    if (!finite(report.clientX) || !finite(report.clientY)) return;
    if (!finite(report.innerWidth) || !finite(report.innerHeight)) return;
    if (
      (report.innerWidth as number) <= 0 ||
      (report.innerHeight as number) <= 0
    )
      return;
    const gen = generation;
    const isClick = report.kind === "click";
    const mapped = await mapReport(
      source.frame,
      report.clientX as number,
      report.clientY as number,
      report.innerWidth as number,
      report.innerHeight as number,
      isClick,
      gen,
    );
    if (!active || gen !== generation) return;
    if (mapped === null) {
      // A click wipes the move queued before it even when the click itself cannot be mapped.
      if (isClick) clearPending();
      forwardUnavailable(isClick);
      return;
    }
    if (isClick) {
      clearPending();
      forwardPosition("click", mapped);
      return;
    }
    scheduleMove(mapped);
  };

  const onFrameNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    generation++;
    clearPending();
    mainDims = null;
    unavailableSent = false;
    if (active) emit({ event: "reset" });
  };

  let binding: { dispose(): Promise<void> } | undefined;
  let initScript: { dispose(): Promise<void> } | undefined;
  try {
    // The binding carries no identity of its own: the callback uses Playwright's source.page/frame.
    binding = await page.exposeBinding(bindingName, onBinding);
    if (!active) {
      await binding.dispose().catch(() => undefined);
      return { stop: async () => undefined };
    }
    initScript = await page.addInitScript({ content: script });
    page.on("framenavigated", onFrameNavigated);
    for (const frame of page.frames()) {
      if (!active) break;
      try {
        await frame.evaluate(script);
      } catch {
        // A special document without observation still gets a screencast; fixed log, no page content.
        console.error("pointer observer: document install failed");
      }
    }
  } catch (error) {
    page.off("framenavigated", onFrameNavigated);
    if (initScript !== undefined)
      await initScript.dispose().catch(() => undefined);
    if (binding !== undefined) await binding.dispose().catch(() => undefined);
    throw error;
  }

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      active = false;
      generation++;
      clearPending();
      page.off("framenavigated", onFrameNavigated);
      for (const frame of page.frames()) {
        try {
          await frame.evaluate(
            `(typeof window[${JSON.stringify(teardownName)}] === "function" ? window[${JSON.stringify(teardownName)}]() : undefined)`,
          );
        } catch {
          // A gone document needs no teardown.
        }
      }
      if (initScript !== undefined)
        await initScript.dispose().catch(() => undefined);
      if (binding !== undefined) await binding.dispose().catch(() => undefined);
    },
  };
}
