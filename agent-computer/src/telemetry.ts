/**
 * What the page said while nobody was looking at it.
 *
 * Console messages, page errors and failed requests, kept per Bot in bounded ring buffers. This is
 * the DevTools half a QA run needs for its ledger: which console errors fired, which requests
 * failed, and with what status — without bodies, headers, query strings or anything a secret could
 * hide in.
 *
 * SECRET BLACKOUT. While `secretWanted` is set a person is typing a value the model must not see,
 * and this collector must not see it either: events in that window are dropped, and entering the
 * window discards what came before. The endpoint answers `secretPending: true` instead, the same
 * shape `/screenshot` uses. A gap in telemetry during a secret handoff is the design, not a bug.
 *
 * No Playwright import: the page surface used here is structural, so tests feed a fake emitter.
 */

const BUFFER_LIMIT = 200;
const TEXT_LIMIT = 200;

export type ConsoleEntry = {
  at: string;
  type: string;
  text: string;
};

export type PageErrorEntry = {
  at: string;
  message: string;
};

export type FailedRequestEntry = {
  at: string;
  method: string;
  url: string;
  status: number | null;
  failure: string | null;
};

export type TelemetrySnapshot = {
  console: ConsoleEntry[];
  pageErrors: PageErrorEntry[];
  failedRequests: FailedRequestEntry[];
};

/** The events a Playwright page emits, and the shapes this collector reads off them. */
type ConsoleMessage = { type(): string; text(): string };
type Request = {
  method(): string;
  url(): string;
  failure(): { errorText: string } | null;
};
type Response = { status(): number; url(): string; request(): Request };

export type TelemetryPage = {
  on(event: "console", handler: (message: ConsoleMessage) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
  on(event: "requestfailed", handler: (request: Request) => void): void;
  on(event: "response", handler: (response: Response) => void): void;
};

const truncate = (text: string): string =>
  text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;

/** Drop the query string: tokens, session ids and search terms all live there, nothing QA needs. */
const bareUrl = (url: string): string => {
  const query = url.indexOf("?");
  const hash = url.indexOf("#");
  const cut = [query, hash].filter((index) => index >= 0);
  return cut.length === 0 ? url : url.slice(0, Math.min(...cut));
};

const push = <T>(buffer: T[], entry: T): void => {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
};

export type Telemetry = {
  attach(page: TelemetryPage, isSecret: () => boolean): void;
  /** Entering a secret window: forget everything, so nothing straddles the handoff. */
  clear(): void;
  snapshot(): TelemetrySnapshot;
};

export function createTelemetry(now: () => string = () => new Date().toISOString()): Telemetry {
  const seen = new WeakSet<object>();
  const consoleEntries: ConsoleEntry[] = [];
  const pageErrors: PageErrorEntry[] = [];
  const failedRequests: FailedRequestEntry[] = [];

  return {
    attach(page, isSecret) {
      if (seen.has(page)) return;
      seen.add(page);
      page.on("console", (message) => {
        if (isSecret()) return;
        push(consoleEntries, { at: now(), type: message.type(), text: truncate(message.text()) });
      });
      page.on("pageerror", (error) => {
        if (isSecret()) return;
        push(pageErrors, { at: now(), message: truncate(error.message) });
      });
      page.on("requestfailed", (request) => {
        if (isSecret()) return;
        push(failedRequests, {
          at: now(),
          method: request.method(),
          url: bareUrl(request.url()),
          status: null,
          failure: request.failure()?.errorText ?? null,
        });
      });
      page.on("response", (response) => {
        if (isSecret()) return;
        if (response.status() < 400) return;
        push(failedRequests, {
          at: now(),
          method: response.request().method(),
          url: bareUrl(response.url()),
          status: response.status(),
          failure: null,
        });
      });
    },

    clear() {
      consoleEntries.length = 0;
      pageErrors.length = 0;
      failedRequests.length = 0;
    },

    snapshot() {
      return {
        console: [...consoleEntries],
        pageErrors: [...pageErrors],
        failedRequests: [...failedRequests],
      };
    },
  };
}
