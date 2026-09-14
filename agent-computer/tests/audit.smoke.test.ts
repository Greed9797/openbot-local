import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "playwright";
import { describeActiveElement, runPageAudit } from "../src/audit";

const ENABLED = process.env.AUDIT_SMOKE === "1";
const maybe = ENABLED ? describe : describe.skip;

function auditPage(): string {
  return `<!doctype html><html><body>
    <button id="ok">Buy now</button>
    <button id="noname" aria-hidden="false" style="width:40px;height:20px"></button>
    <label>Customer name:<input id="name" type="text"></label>
    <img id="noalt" src="/pixel.png" width="10" height="10">
    <img id="withalt" src="/pixel.png" width="10" height="10" alt="Difai glove">
    <p id="low" style="color:#999999;background:#ffffff;font-size:14px">low contrast text</p>
    <p id="fine" style="color:#111111;background:#ffffff;font-size:14px">fine text</p>
  </body></html>`;
}

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

maybe("audit probes", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin = "";

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/pixel.png") {
          return new Response(PIXEL, {
            headers: { "Content-Type": "image/png" },
          });
        }
        return new Response(auditPage(), {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    origin = `http://localhost:${server.port}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    server.stop(true);
    await browser.close().catch(() => undefined);
  });

  async function fixturePage(): Promise<{
    page: Page;
    done: () => Promise<void>;
  }> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    return { page, done: () => context.close() };
  }

  test("names the unnamed, the alt-less and the low contrast", async () => {
    const { page, done } = await fixturePage();
    try {
      const report = await page.evaluate(runPageAudit);
      expect(report.unnamedControls.count).toBe(1);
      expect(report.unnamedControls.sample[0]?.tag).toBe("button");
      expect(report.imagesMissingAlt.count).toBe(1);
      expect(
        report.imagesMissingAlt.sample[0]?.host.startsWith("localhost"),
      ).toBe(true);
      expect(
        report.contrastFailures.sample.some((failure) =>
          failure.descriptor.includes("low contrast text"),
        ),
      ).toBe(true);
      expect(
        report.contrastFailures.sample.some((failure) =>
          failure.descriptor.includes("fine text"),
        ),
      ).toBe(false);
    } finally {
      await done();
    }
  });

  test("focus walk visits labeled controls in order, without values", async () => {
    const { page, done } = await fixturePage();
    try {
      const order: unknown[] = [];
      for (let index = 0; index < 4; index += 1) {
        await page.keyboard.press("Tab");
        order.push(await page.evaluate(describeActiveElement));
      }
      const names = order.map((entry) =>
        entry === null ? null : (entry as { text: string }).text,
      );
      expect(names[0]).toBe("Buy now");
      // The empty button is reachable but nameless: the walk reports the gap, it does not hide it.
      expect(names).toContain("");
      // Labels only: the input's current value never appears, even after typing into it.
      await page.fill("#name", "secret-customer");
      await page.keyboard.press("Tab");
      const flat = JSON.stringify(order);
      expect(flat).not.toContain("secret-customer");
    } finally {
      await done();
    }
  });
});
