import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import {
  observePointer,
  type ObservedPointer,
  type PointerHandle,
} from "../src/pointer-observer";
import { startScreencast } from "../src/screencast";

const ENABLED = process.env.COMPUTER_POINTER_SMOKE === "1";
const maybe = ENABLED ? describe : describe.skip;

/** Globals owned by the fixture scripts below; read through this instead of inline casts. */
type FixtureWindow = Window & {
  __truth?: { x: number; y: number };
  __count?: number;
  __frameCount?: number;
};

function truthScript(): string {
  return `<script>
    window.__truth = null;
    window.__count = 0;
    window.addEventListener("click", (event) => {
      window.__truth = { x: event.clientX, y: event.clientY };
    }, { capture: true });
  </script>`;
}

function framedPage(): string {
  return `<!doctype html><html><body>
    ${truthScript()}
    <div style="height: 600px">scroll rolagem</div>
    <button id="inner" onclick="window.__count++; window.__frameCount = (window.__frameCount ?? 0) + 1">Inner</button>
    <div style="height: 600px"></div>
  </body></html>`;
}

function mainPage(frameOrigin: string): string {
  return `<!doctype html><html><body>
    ${truthScript()}
    <button id="yes" onclick="window.__count++">Yes</button>
    <button id="off" disabled>Off</button>
    <button id="gone" onclick="window.__count++; this.remove()">Gone</button>
    <button id="nav" onclick="location.href='/second'">Nav</button>
    <iframe id="plain" src="${frameOrigin}/framed"
      style="border: 5px solid black; width: 300px; height: 200px; transform: scale(1.25); transform-origin: top left"></iframe>
    <iframe id="tilted" src="${frameOrigin}/framed" style="border: none; width: 200px; height: 120px; transform: rotate(15deg)"></iframe>
    <div style="height: 200vh"></div>
    <button id="low">Low</button>
  </body></html>`;
}

async function truth(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate((): { x: number; y: number } => {
    // Fixture script owns these globals; a missing capture is a fixture bug, not silent zero.
    const w = window as unknown as FixtureWindow;
    const t = w.__truth;
    if (!t || typeof t.x !== "number" || typeof t.y !== "number") {
      throw new Error("fixture truth missing");
    }
    return { x: t.x, y: t.y };
  });
}

async function count(page: Page): Promise<number> {
  return page.evaluate((): number => {
    const w = window as unknown as FixtureWindow;
    return typeof w.__count === "number" ? w.__count : 0;
  });
}

async function waitFor<T>(
  items: T[],
  matches: (item: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = items.find(matches);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function clicks(events: ObservedPointer[]): ObservedPointer[] {
  return events.filter((event) => event.event === "click");
}

maybe("cursor observado do agente", () => {
  let browser: Browser;
  let mainServer: ReturnType<typeof Bun.serve>;
  let frameServer: ReturnType<typeof Bun.serve>;
  let mainOrigin = "";
  let frameOrigin = "";

  beforeAll(async () => {
    frameServer = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(framedPage(), {
          headers: { "Content-Type": "text/html" },
        }),
    });
    frameOrigin = `http://localhost:${frameServer.port}`;
    mainServer = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/second") {
          return new Response(
            `<!doctype html><html><body>${truthScript()}second</body></html>`,
            {
              headers: { "Content-Type": "text/html" },
            },
          );
        }
        return new Response(mainPage(frameOrigin), {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    mainOrigin = `http://localhost:${mainServer.port}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    mainServer.stop(true);
    frameServer.stop(true);
    await browser.close().catch(() => undefined);
  });

  async function freshPage(): Promise<{
    page: Page;
    done: () => Promise<void>;
  }> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(`${mainOrigin}/`);
    return {
      page,
      done: async () => {
        await context.close().catch(() => undefined);
      },
    };
  }

  async function watching(
    page: Page,
  ): Promise<{ events: ObservedPointer[]; handle: PointerHandle }> {
    const events: ObservedPointer[] = [];
    const handle = await observePointer(page, (event) => {
      events.push(event);
    });
    return { events, handle };
  }

  test("locator.click no Yes: contador 1 e clique na posição real", async () => {
    const { page, done } = await freshPage();
    try {
      const { events, handle } = await watching(page);
      try {
        await page.locator("#yes").click();
        expect(await count(page)).toBe(1);
        const seen = await waitFor(
          events,
          (event) => event.event === "click",
          "observed click",
        );
        const real = await truth(page);
        if (seen.event !== "click") throw new Error("expected a click");
        expect(Math.abs(seen.x - real.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(seen.y - real.y)).toBeLessThanOrEqual(1);
      } finally {
        await handle.stop();
      }
    } finally {
      await done();
    }
  }, 60_000);

  test("auto-scroll: posição na região visível, não a anterior", async () => {
    const { page, done } = await freshPage();
    try {
      const { events, handle } = await watching(page);
      try {
        await page.locator("#low").click();
        const seen = await waitFor(
          events,
          (event) => event.event === "click",
          "low click",
        );
        const real = await truth(page);
        const viewport = await page.evaluate(() => ({
          w: window.innerWidth,
          h: window.innerHeight,
        }));
        expect(real.y).toBeGreaterThanOrEqual(0);
        expect(real.y).toBeLessThanOrEqual(viewport.h);
        if (seen.event !== "click") throw new Error("expected a click");
        expect(seen.width).toBe(viewport.w);
        expect(seen.height).toBe(viewport.h);
        expect(Math.abs(seen.x - real.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(seen.y - real.y)).toBeLessThanOrEqual(1);
      } finally {
        await handle.stop();
      }
    } finally {
      await done();
    }
  }, 60_000);

  test("botão removido no clique ainda gera posição observada", async () => {
    const { page, done } = await freshPage();
    try {
      const { events, handle } = await watching(page);
      try {
        await page.locator("#gone").click();
        expect(await count(page)).toBe(1);
        expect(await page.locator("#gone").count()).toBe(0);
        const seen = await waitFor(
          events,
          (event) => event.event === "click",
          "gone click",
        );
        const real = await truth(page);
        if (seen.event !== "click") throw new Error("expected a click");
        expect(Math.abs(seen.x - real.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(seen.y - real.y)).toBeLessThanOrEqual(1);
      } finally {
        await handle.stop();
      }
    } finally {
      await done();
    }
  }, 60_000);

  test("iframe com borda e escala: marcador no viewport principal", async () => {
    const { page, done } = await freshPage();
    try {
      const { events, handle } = await watching(page);
      try {
        const frame = page.frameLocator("#plain");
        await frame.locator("#inner").click();
        const seen = await waitFor(
          events,
          (event) => event.event === "click",
          "iframe click",
        );
        if (seen.event !== "click") throw new Error("expected a click");
        // Independent mapping: truth inside the frame plus the element box measured here.
        const innerFrame = page
          .frames()
          .find((candidate) => candidate.url().includes("/framed"));
        if (!innerFrame) throw new Error("framed document not found");
        const real = await innerFrame.evaluate((): { x: number; y: number } => {
          const w = window as unknown as FixtureWindow;
          const t = w.__truth;
          if (!t || typeof t.x !== "number" || typeof t.y !== "number") {
            throw new Error("frame truth missing");
          }
          return { x: t.x, y: t.y };
        });
        const element = await innerFrame.frameElement();
        try {
          const box = await element.boundingBox();
          const sizes = await element.evaluate((el) => {
            // frameElement of an <iframe> is always its HTML element.
            const node = el as HTMLElement;
            return {
              offsetWidth: node.offsetWidth,
              offsetHeight: node.offsetHeight,
              clientLeft: node.clientLeft,
              clientTop: node.clientTop,
            };
          });
          if (!box) throw new Error("iframe has no box");
          const expected = {
            x:
              box.x +
              (sizes.clientLeft + real.x) * (box.width / sizes.offsetWidth),
            y:
              box.y +
              (sizes.clientTop + real.y) * (box.height / sizes.offsetHeight),
          };
          expect(Math.abs(seen.x - expected.x)).toBeLessThanOrEqual(2);
          expect(Math.abs(seen.y - expected.y)).toBeLessThanOrEqual(2);
          const viewport = await page.evaluate(() => ({
            w: window.innerWidth,
            h: window.innerHeight,
          }));
          expect(seen.width).toBe(viewport.w);
          expect(seen.height).toBe(viewport.h);
        } finally {
          await element.dispose().catch(() => undefined);
        }
      } finally {
        await handle.stop();
      }
    } finally {
      await done();
    }
  }, 60_000);

  test("iframe com rotação: unavailable e a ação continua", async () => {
    const { page, done } = await freshPage();
    try {
      const { events, handle } = await watching(page);
      try {
        // Tilted frame is the second framed document; pick it via the frame element.
        const tilted = page.frameLocator("#tilted");
        await tilted.locator("#inner").click();
        await waitFor(
          events,
          (event) => event.event === "unavailable",
          "unavailable",
        );
        const frames: Frame[] = page
          .frames()
          .filter((candidate) => candidate.url().includes("/framed"));
        let acted = 0;
        for (const candidate of frames) {
          acted += await candidate
            .evaluate((): number => {
              const w = window as unknown as FixtureWindow;
              return typeof w.__frameCount === "number" ? w.__frameCount : 0;
            })
            .catch(() => 0);
        }
        expect(acted).toBe(1);
      } finally {
        await handle.stop();
      }
    } finally {
      await done();
    }
  }, 60_000);

  test("botão disabled: nenhum pulso de click", async () => {
    const { page, done } = await freshPage();
    try {
      const { events, handle } = await watching(page);
      try {
        await expect(
          page.locator("#off").click({ timeout: 1500 }),
        ).rejects.toThrow();
        // Absence assertion against a live browser: fake timers cannot advance browser I/O.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(clicks(events)).toHaveLength(0);
      } finally {
        await handle.stop();
      }
    } finally {
      await done();
    }
  }, 60_000);

  test("clique sintético não gera marcador", async () => {
    const { page, done } = await freshPage();
    try {
      const { events, handle } = await watching(page);
      try {
        await page.evaluate(() => {
          document
            .querySelector("#yes")
            ?.dispatchEvent(
              new MouseEvent("click", {
                bubbles: true,
                clientX: 50,
                clientY: 60,
              }),
            );
        });
        // Absence assertion against a live browser: fake timers cannot advance browser I/O.
        expect(clicks(events)).toHaveLength(0);
      } finally {
        await handle.stop();
      }
    } finally {
      await done();
    }
  }, 60_000);

  test("isAgentDriving=false: humano age, nada rotulado como IA", async () => {
    const { page, done } = await freshPage();
    try {
      const messages: Array<{ type: string; event?: string }> = [];
      const cast = await startScreencast(
        page,
        (message) => {
          messages.push(message);
        },
        { isAgentDriving: () => false },
      );
      try {
        // Empty spacer area: a trusted human click that must not be labeled AI.
        await page.mouse.click(1200, 700);
        await page.locator("#yes").click();
        expect(await count(page)).toBe(1);
        // Absence assertion against a live browser: fake timers cannot advance browser I/O.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(
          messages.filter((message) => message.type === "pointer"),
        ).toHaveLength(0);
      } finally {
        await cast.stop();
      }
    } finally {
      await done();
    }
  }, 60_000);

  test("dois observadores isolados; stop e reanexação sem duplicar; navegação limpa", async () => {
    const first = await freshPage();
    const second = await freshPage();
    try {
      const a = await watching(first.page);
      const b = await watching(second.page);
      try {
        await first.page.locator("#yes").click();
        const clickA = await waitFor(
          a.events,
          (event) => event.event === "click",
          "A click",
        );
        // Silence window: a leaked event into B would land here; the live browser sets the pace.
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(clicks(b.events)).toHaveLength(0);
        expect(clickA.event).toBe("click");

        await a.handle.stop();
        const a2 = await watching(first.page);
        try {
          await first.page.locator("#yes").click();
          await waitFor(
            a2.events,
            (event) => event.event === "click",
            "reattached click",
          );
          // Silence window: a duplicate from the stopped observer would land here.
          await new Promise((resolve) => setTimeout(resolve, 400));
          // The stopped observer stays silent; the new one reports exactly one click.
          expect(clicks(a.events)).toHaveLength(1);
          expect(clicks(a2.events)).toHaveLength(1);

          await first.page.locator("#nav").click();
          await first.page.waitForURL("**/second");
          await waitFor(
            a2.events,
            (event) => event.event === "reset",
            "navigation reset",
          );
        } finally {
          await a2.handle.stop();
        }
      } finally {
        await b.handle.stop().catch(() => undefined);
      }
    } finally {
      await first.done();
      await second.done();
    }
  }, 60_000);
});
