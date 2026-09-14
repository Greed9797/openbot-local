import { describe, expect, test } from "bun:test";
import { createTelemetry, type TelemetryPage } from "../src/telemetry";

/** A page that emits on demand instead of driving a browser. */
function fakePage() {
  const handlers = new Map<string, ((payload: never) => void)[]>();
  const page = {
    on: (event: string, handler: (payload: never) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as TelemetryPage;
  return {
    page,
    emit: (event: string, payload: never) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    listenerCount: () => [...handlers.values()].reduce((sum, list) => sum + list.length, 0),
  };
}

const consoleMessage = (type: string, text: string) => ({ type: () => type, text: () => text });

describe("telemetry", () => {
  test("collects console, errors and failures with redaction", () => {
    const telemetry = createTelemetry(() => "2026-09-12T00:00:00.000Z");
    const { page, emit } = fakePage();
    telemetry.attach(page, () => false);

    emit("console", consoleMessage("error", "boom") as never);
    emit("pageerror", new Error("bad render") as never);
    emit("requestfailed", {
      method: () => "GET",
      url: () => "https://shop.test/api/cart?token=secret&x=1",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    } as never);
    emit("response", {
      status: () => 500,
      url: () => "https://shop.test/checkout#frag",
      request: () => ({ method: () => "POST" }),
    } as never);
    emit("response", {
      status: () => 200,
      url: () => "https://shop.test/ok",
      request: () => ({ method: () => "GET" }),
    } as never);

    const snapshot = telemetry.snapshot();
    expect(snapshot.console).toEqual([
      { at: "2026-09-12T00:00:00.000Z", type: "error", text: "boom" },
    ]);
    expect(snapshot.pageErrors.map((entry) => entry.message)).toEqual(["bad render"]);
    expect(snapshot.failedRequests).toEqual([
      {
        at: "2026-09-12T00:00:00.000Z",
        method: "GET",
        url: "https://shop.test/api/cart",
        status: null,
        failure: "net::ERR_FAILED",
      },
      {
        at: "2026-09-12T00:00:00.000Z",
        method: "POST",
        url: "https://shop.test/checkout",
        status: 500,
        failure: null,
      },
    ]);
  });

  test("drops everything while a secret is wanted and forgets on entry", () => {
    const telemetry = createTelemetry();
    const { page, emit } = fakePage();
    let secret = false;
    telemetry.attach(page, () => secret);

    emit("console", consoleMessage("log", "before") as never);
    secret = true;
    telemetry.clear();
    emit("console", consoleMessage("log", "during") as never);
    emit("pageerror", new Error("during") as never);
    secret = false;
    emit("console", consoleMessage("log", "after") as never);

    const snapshot = telemetry.snapshot();
    expect(snapshot.console.map((entry) => entry.text)).toEqual(["after"]);
    expect(snapshot.pageErrors).toEqual([]);
  });

  test("attaching twice installs one listener set", () => {
    const telemetry = createTelemetry();
    const { page, listenerCount } = fakePage();
    telemetry.attach(page, () => false);
    telemetry.attach(page, () => false);
    expect(listenerCount()).toBe(4);
  });
});
